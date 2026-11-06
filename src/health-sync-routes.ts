// HTTP half of Apple Health sync via an iOS Shortcut (the pure rules are in
// src/health-sync.ts, persistence in src/db/health-store.ts):
//
//   GET  /api/v1/health-sync/pending   what to add to Apple Health right now
//   POST /api/v1/health-sync/ack       what the shortcut actually logged
//   POST /api/v1/health-sync/activity  Active Energy day totals (replace, not add)
//   GET  /api/v1/health-sync/status    sync clocks, per-day sent vs logged
//   POST /api/v1/health-sync/revoke    forget the ledger (start over)
//
// Authentication: one static key, `Authorization: Bearer <SHORTCUT_KEY>`,
// checked by src/perimeter.ts (bearerKeyGuard) in front of every route here:
// constant-time compare, shared per-address failure ban, a generic 401. It is
// a different credential from the MCP path key and never appears in a URL.
//
// The API answers in one envelope: every body has `ok`, and a failure is
// `{ ok: false, error, message, ref? }` with `error` from a fixed vocabulary
// and `message` written for the person reading the shortcut's alert. Every
// handler catches its own errors, and every call writes exactly one
// `[health-sync] route=… result=…` line, which never carries a key.
//
// Mounted at "/" by src/index.ts, so no middleware here is registered on
// "*": a sub-app's wildcard middleware would run on every path of the parent.
import { Hono, type Context, type Next } from "hono";
import {
    HEALTH_SYNC_LEASE_SECONDS,
    HEALTH_SYNC_RETENTION_DAYS,
    ackWindow,
    applyAck,
    effectiveTimezone,
    formatInstantWithOffset,
    parseAckBody,
} from "./health-sync.js";
import {
    parseActivityBody,
    planActivityWrites,
    type ActivityWrite,
} from "./health-activity-sync.js";
import {
    OWNER_ID,
    activityCreditPctFromProfile,
    createSqliteHealthSyncStore,
    getProfile,
    syncHealthActiveCalories,
    timezoneFromProfile,
    type HealthSyncStore,
} from "./db/repo.js";
import {
    computePlan,
    getHealthSyncStatus,
    repoHealthSyncData,
    type HealthSyncData,
} from "./health-sync-status.js";
import { shiftLocalDate, dateInTz, validateTz } from "./tz.js";
import { newErrorRef } from "./errors.js";
import {
    checkHealthSyncRateLimit,
    type RateLimitResult,
} from "./rate-limit.js";
import { bearerKeyGuard } from "./perimeter.js";

const API = "/api/v1/health-sync";

/** Paths this router owns. */
export function isHealthSyncPath(path: string): boolean {
    return path === API || path.startsWith(`${API}/`);
}

// ---------- dependencies ----------

/** What POST /activity reads and writes. Injectable like HealthSyncData. */
export interface HealthActivityData {
    /** The profile's timezone (null when never set) and its current credit
     *  share, from one profile read. */
    getActivityProfile(
        userId: string,
    ): Promise<{ tz: string | null; creditPct: number }>;
    /** Insert or replace the day totals; returns rows inserted or changed. */
    writeActivityDays(
        userId: string,
        days: readonly ActivityWrite[],
    ): Promise<number>;
}

export const repoHealthActivityData: HealthActivityData = {
    async getActivityProfile(userId) {
        const profile = await getProfile(userId);
        return {
            tz: timezoneFromProfile(profile),
            creditPct: activityCreditPctFromProfile(profile),
        };
    },
    writeActivityDays: syncHealthActiveCalories,
};

export interface HealthSyncRouterDeps {
    /** The shortcut key, read per request. Required: there is no open mode. */
    key: () => string;
    store?: HealthSyncStore;
    activityData?: HealthActivityData;
    data?: HealthSyncData;
    now?: () => number;
}

// ---------- envelope, logging ----------

export type HealthSyncErrorCode =
    | "unauthorized"
    | "busy"
    | "rate_limited"
    | "unavailable"
    | "bad_request"
    | "server_error";

type Route = "pending" | "ack" | "activity" | "status" | "revoke" | "unknown";

/** What a handler reports for its one log line. */
interface CallNote {
    result: string;
    entries?: number;
    notices?: number;
    discrepancies?: number;
    /** Set for server_error / unavailable: the ref the caller was shown, and
     *  the raw error text, JSON-escaped and capped. */
    ref?: string;
    error?: string;
}

type Env = { Variables: { hsNote: CallNote } };

/** Thrown around a store or data call, so a failure to read or write is
 *  told apart from a bug: the first is `unavailable` (retry later), the
 *  second `server_error`. */
class Unavailable extends Error {
    constructor(readonly inner: unknown) {
        super(inner instanceof Error ? inner.message : String(inner));
    }
}

async function io<T>(p: Promise<T>): Promise<T> {
    try {
        return await p;
    } catch (err) {
        throw new Unavailable(err);
    }
}

function errorText(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.slice(0, 500);
}

function logLine(route: Route, note: CallNote): string {
    let line = `[health-sync] route=${route} result=${note.result}`;
    if (note.entries !== undefined) line += ` entries=${note.entries}`;
    if (note.notices !== undefined) line += ` notices=${note.notices}`;
    if (note.discrepancies !== undefined)
        line += ` discrepancies=${note.discrepancies}`;
    if (note.ref) line += ` ref=${note.ref}`;
    if (note.error !== undefined) line += `: ${JSON.stringify(note.error)}`;
    return line;
}

const API_HEADERS = { "Cache-Control": "private, no-store" } as const;

const MESSAGES: Record<
    Exclude<HealthSyncErrorCode, "bad_request" | "rate_limited">,
    string
> = {
    unauthorized:
        "The shortcut key was missing or wrong. Check the Authorization header in the shortcut.",
    busy: "Another sync is already running. Try again in a couple of minutes.",
    unavailable:
        "The server could not reach its database, so nothing was read or changed. Try again in a few minutes.",
    server_error:
        "Something went wrong on the server, so nothing was changed. Try again later.",
};

function fail(
    c: Context<Env>,
    status: 400 | 404 | 405 | 409 | 429 | 500 | 503,
    error: HealthSyncErrorCode,
    message: string,
    extra: { ref?: string; headers?: Record<string, string> } = {},
) {
    const note = c.get("hsNote");
    if (note) note.result = error;
    const body: Record<string, unknown> = { ok: false, error, message };
    if (extra.ref) body.ref = extra.ref;
    return c.json(body, status, { ...API_HEADERS, ...extra.headers });
}

function rateLimited(c: Context<Env>, r: RateLimitResult) {
    const after = r.retryAfterSeconds ?? 60;
    return fail(
        c,
        429,
        "rate_limited",
        `Too many requests. Try again in ${after} seconds.`,
        { headers: { "Retry-After": String(after) } },
    );
}

/** The 503/500 for an error a handler caught; logs under the same ref. */
function failFromError(c: Context<Env>, err: unknown) {
    const ref = newErrorRef();
    const note = c.get("hsNote");
    note.ref = ref;
    note.error = errorText(err instanceof Unavailable ? err.inner : err);
    if (err instanceof Unavailable) {
        return fail(
            c,
            503,
            "unavailable",
            `${MESSAGES.unavailable} (ref ${ref})`,
            { ref, headers: { "Retry-After": "60" } },
        );
    }
    return fail(
        c,
        500,
        "server_error",
        `${MESSAGES.server_error} (ref ${ref})`,
        { ref },
    );
}

function ok(c: Context<Env>, body: Record<string, unknown>) {
    c.get("hsNote").result = "ok";
    return c.json({ ok: true, ...body }, 200, API_HEADERS);
}

/** A JSON body, or `undefined` for an empty one; null when it is not JSON. */
async function readJson(c: Context<Env>): Promise<{ value: unknown } | null> {
    const text = await c.req.text();
    if (text.trim() === "") return { value: undefined };
    try {
        return { value: JSON.parse(text) };
    } catch {
        return null;
    }
}

/** `?tz=` as the phone's IANA zone, or null when absent / not a real zone. */
function phoneTzOf(c: Context<Env>): string | null {
    const raw = c.req.query("tz")?.trim();
    return raw && raw.length <= 64 && validateTz(raw) ? raw : null;
}

const truthy = (v: string | undefined) => v === "1" || v === "true";

// ---------- router ----------

export function createHealthSyncRouter(deps: HealthSyncRouterDeps) {
    const router = new Hono<Env>();
    const store = deps.store ?? createSqliteHealthSyncStore();
    const data = deps.data ?? repoHealthSyncData;
    const activityData = deps.activityData ?? repoHealthActivityData;
    const now = deps.now ?? Date.now;
    const userId = OWNER_ID;

    // One log line per call, written after the response is built. A throw that
    // escaped a handler (none should) still logs, as server_error.
    const logged = (route: Route) => async (c: Context<Env>, next: Next) => {
        const note: CallNote = { result: "server_error" };
        c.set("hsNote", note);
        try {
            await next();
        } finally {
            const line = logLine(route, note);
            if (note.result === "ok") console.log(line);
            else console.warn(line);
        }
    };

    // Key check (and the shared ban) for every route, in the envelope.
    const auth = bearerKeyGuard(deps.key, {
        unauthorized: (c) =>
            c.json(
                {
                    ok: false,
                    error: "unauthorized",
                    message: MESSAGES.unauthorized,
                },
                401,
                { ...API_HEADERS, "WWW-Authenticate": 'Bearer realm="food"' },
            ),
        banned: (c, retryAfter) =>
            c.json(
                {
                    ok: false,
                    error: "rate_limited",
                    message: `Too many failed attempts. Try again in ${retryAfter} seconds.`,
                },
                429,
                { ...API_HEADERS, "Retry-After": String(retryAfter) },
            ),
    });

    // Per-owner request budget, after the key is accepted.
    const budget = async (c: Context<Env>, next: Next) => {
        const limit = checkHealthSyncRateLimit(userId);
        if (!limit.allowed) return rateLimited(c, limit);
        await next();
    };

    // ---- GET /pending ----
    router.get(`${API}/pending`, logged("pending"), auth, budget, async (c) => {
        const at = new Date(now());
        let leaseUntil: string | null = null;
        try {
            leaseUntil = new Date(
                at.getTime() + HEALTH_SYNC_LEASE_SECONDS * 1000,
            ).toISOString();
            if (!(await io(store.acquireLease(userId, leaseUntil, at)))) {
                leaseUntil = null;
                return fail(c, 409, "busy", MESSAGES.busy);
            }
            const plan = await io(
                computePlan(userId, {
                    now: at,
                    phoneTz: phoneTzOf(c),
                    includeWater: truthy(
                        c.req.query("water") ?? c.req.query("include_water"),
                    ),
                    store,
                    data,
                }),
            );
            await io(store.touchSync(userId, at.toISOString()));
            // Retention: the ledger keeps a day for HEALTH_SYNC_RETENTION_DAYS.
            await io(
                store.deleteDaysBefore(
                    userId,
                    shiftLocalDate(
                        dateInTz(at, plan.timezone),
                        -HEALTH_SYNC_RETENTION_DAYS,
                    ),
                ),
            );
            // Nothing to acknowledge means nothing to lock.
            if (plan.entries.length === 0) {
                await io(store.releaseLease(userId, leaseUntil));
                leaseUntil = null;
            }
            const note = c.get("hsNote");
            note.entries = plan.entries.length;
            note.notices = plan.notices.length;
            note.discrepancies = plan.discrepancies.length;
            return ok(c, {
                version: 2,
                now: formatInstantWithOffset(at, plan.timezone),
                timezone: plan.timezone,
                timezone_source: plan.timezone_source,
                window: {
                    from: plan.dates[0],
                    to: plan.dates[plan.dates.length - 1],
                },
                lease_until: leaseUntil,
                count: plan.entries.length,
                entries: plan.entries,
                discrepancies: plan.discrepancies,
                notices: plan.notices,
            });
        } catch (err) {
            // Hand the lease back so the retry the message suggests is not
            // refused as busy. Only this run's lease.
            if (leaseUntil !== null) {
                void store.releaseLease(userId, leaseUntil).catch(() => {});
            }
            return failFromError(c, err);
        }
    });

    // ---- POST /ack ----
    router.post(`${API}/ack`, logged("ack"), auth, budget, async (c) => {
        try {
            const json = await readJson(c);
            if (!json) {
                return fail(
                    c,
                    400,
                    "bad_request",
                    "The request body must be JSON.",
                );
            }
            const parsed = parseAckBody(json.value);
            if (!parsed.ok) return fail(c, 400, "bad_request", parsed.message);
            const { entries, done } = parsed.value;
            const at = new Date(now());

            const results: {
                entry_id: string;
                status: "applied" | "skipped";
            }[] = [];
            if (entries.length > 0) {
                const profileTz = await io(data.getProfileTimezone(userId));
                const { tz } = effectiveTimezone(profileTz, phoneTzOf(c));
                const win = ackWindow(at, tz);
                // In order, each against the row as the entry before it left
                // it, so r1 and r2 for one day in one batch both apply.
                for (const entry of entries) {
                    let applied = false;
                    if (entry.date >= win.from && entry.date <= win.to) {
                        const [row] = await io(
                            store.getDays(userId, entry.date, entry.date),
                        );
                        const r = applyAck(row ?? null, entry, tz, at);
                        // Conditional on the row still being as it was read:
                        // an overlapping ack that got there first makes this
                        // one a skip, never a second count.
                        if (r.applied && r.row) {
                            applied = await io(
                                store.commitDay(
                                    userId,
                                    row?.rounds ?? 0,
                                    r.row,
                                    at.toISOString(),
                                ),
                            );
                        }
                    }
                    results.push({
                        entry_id: entry.entry_id,
                        status: applied ? "applied" : "skipped",
                    });
                }
            }
            // Only the lease this run took: a late ack from a run whose lease
            // lapsed must not free the one a newer run now holds.
            if (done && parsed.value.lease_until !== undefined) {
                await io(store.releaseLease(userId, parsed.value.lease_until));
            }
            const applied = results.filter(
                (r) => r.status === "applied",
            ).length;
            c.get("hsNote").entries = entries.length;
            return ok(c, {
                applied,
                skipped: entries.length - applied,
                results,
            });
        } catch (err) {
            return failFromError(c, err);
        }
    });

    // ---- POST /activity ----
    //
    // The activity shortcut's day totals (rules: src/health-activity-sync.ts).
    // Each accepted day replaces that day's Apple Health row in
    // active_calories_log; nothing here touches hand-logged entries or the
    // nutrition ledger.
    router.post(
        `${API}/activity`,
        logged("activity"),
        auth,
        budget,
        async (c) => {
            try {
                const json = await readJson(c);
                if (!json) {
                    return fail(
                        c,
                        400,
                        "bad_request",
                        "The request body must be JSON. Check the shortcut's Text action before Get Contents of URL.",
                    );
                }
                const parsed = parseActivityBody(json.value);
                if (!parsed.ok)
                    return fail(c, 400, "bad_request", parsed.message);
                const at = new Date(now());
                const profile = await io(
                    activityData.getActivityProfile(userId),
                );
                // The profile's zone decides the dates, as every reader buckets by
                // it; the phone's only stands in when none is set.
                const { tz, source } = effectiveTimezone(
                    profile.tz,
                    parsed.value.tz ?? phoneTzOf(c),
                );
                const plan = planActivityWrites({
                    days: parsed.value.days,
                    now: at,
                    tz,
                    creditPct: profile.creditPct,
                });
                const changed = await io(
                    activityData.writeActivityDays(userId, plan.writes),
                );
                await io(store.setActivitySynced(userId, at.toISOString()));
                c.get("hsNote").entries = plan.writes.length;
                return ok(c, {
                    version: 1,
                    timezone: tz,
                    timezone_source: source,
                    written: plan.writes.length,
                    changed,
                    skipped: plan.skipped,
                    status: { through: plan.through },
                });
            } catch (err) {
                return failFromError(c, err);
            }
        },
    );

    // ---- GET /status ----
    router.get(`${API}/status`, logged("status"), auth, budget, async (c) => {
        try {
            const status = await io(
                getHealthSyncStatus({
                    userId,
                    now: new Date(now()),
                    includeWater: truthy(c.req.query("water")) ? true : "auto",
                    store,
                    data,
                }),
            );
            return ok(c, { ...status });
        } catch (err) {
            return failFromError(c, err);
        }
    });

    // ---- POST /revoke ----
    //
    // Forgets what was sent (and the clocks). The next /pending then offers the
    // whole window again, which duplicates anything Health still holds, so it
    // needs `{"confirm": true}`.
    router.post(`${API}/revoke`, logged("revoke"), auth, budget, async (c) => {
        try {
            const json = await readJson(c);
            const body = json?.value as { confirm?: unknown } | undefined;
            if (!json || body?.confirm !== true) {
                return fail(
                    c,
                    400,
                    "bad_request",
                    'Send {"confirm": true} to forget what was sent. Anything Apple Health still holds would be offered again.',
                );
            }
            await io(store.reset(userId));
            return ok(c, {});
        } catch (err) {
            return failFromError(c, err);
        }
    });

    // ---- anything else under the API ----
    //
    // A wrong method or a mistyped path still answers in the envelope, so the
    // shortcut's `ok` branch can show the message rather than a bare 404.
    // The key is checked first: an unauthenticated caller learns nothing.
    const unknownApi = async (c: Context<Env>) => {
        const known = API_METHODS[c.req.path];
        if (known) {
            return fail(
                c,
                405,
                "bad_request",
                `${c.req.path} takes ${known}, not ${c.req.method}.`,
                { headers: { Allow: known } },
            );
        }
        return fail(c, 404, "bad_request", "Unknown endpoint.");
    };
    router.all(API, logged("unknown"), auth, unknownApi);
    router.all(`${API}/*`, logged("unknown"), auth, unknownApi);

    return router;
}

/** Each API path's one method, for the catch-all's 405. */
const API_METHODS: Record<string, string> = {
    [`${API}/pending`]: "GET",
    [`${API}/ack`]: "POST",
    [`${API}/activity`]: "POST",
    [`${API}/status`]: "GET",
    [`${API}/revoke`]: "POST",
};
