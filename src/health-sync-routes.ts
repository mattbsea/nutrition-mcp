// HTTP half of Apple Health sync via an iOS Shortcut (the pure rules are in
// src/health-sync.ts, persistence in src/db/health-store.ts):
//
//   GET  /api/v1/health-sync/pending   closed days to log into Apple Health
//   POST /api/v1/health-sync/ack       what the shortcut actually logged
//   POST /api/v1/health-sync/revoke    disconnect (either shortcut's link)
//   POST /api/v1/health-sync/activity  the opt-in activity shortcut sends
//                                      its Active Energy day totals
//
// STEP A2 STATE: the browser pairing flow (start/connect/callback/claim) is gone
// and this router is NOT MOUNTED; src/index.ts answers every health-sync path
// with a 501 {ok:false,error:"not_available_yet"} until step B swaps the link
// token auth below for the configured shortcut_key and mounts it. The handlers
// and their tests are kept so B only changes the auth and the setup.
//
// The API answers in one envelope: every body has `ok`, and a failure is
// `{ ok: false, error, message, ref? }` with `error` from a fixed vocabulary
// and `message` written for the person reading the shortcut's alert. Every
// handler catches its own errors, and every call writes exactly one
// `[health-sync] route=… result=…` line, which never carries a token, hash or
// secret path.
import { Hono, type Context, type Next } from "hono";
import {
    HEALTH_SYNC_LEASE_SECONDS,
    HEALTH_SYNC_TOKEN_PREFIX,
    ackWindow,
    applyAck,
    computeDayTotals,
    effectiveTimezone,
    formatInstantWithOffset,
    isHealthSyncField,
    linkExpiresAt,
    looksLikeHealthSyncToken,
    offeringWindow,
    parseAckBody,
    planPending,
    shouldTouchLink,
    type DayValues,
    type HealthSyncField,
    type HealthSyncMeal,
    type HealthSyncWater,
    type LedgerRow,
} from "./health-sync.js";
import {
    HEALTH_ACTIVITY_SHORTCUT_NAME,
    parseActivityBody,
    planActivityWrites,
    type ActivityWrite,
} from "./health-activity-sync.js";
import {
    activityCreditPctFromProfile,
    createSqliteHealthActivityLinkStore,
    createSqliteHealthSyncStore,
    getMealsInRange,
    getProfile,
    getWaterInRange,
    syncHealthActiveCalories,
    timezoneFromProfile,
    type HealthActivityLinkRow,
    type HealthActivityLinkStore,
    type HealthSyncConnectKind,
    type HealthSyncDayRow,
    type HealthSyncLinkRow,
    type HealthSyncStore,
} from "./db/repo.js";
import { newErrorRef } from "./errors.js";
import { getClientIp, recordAuthFailure } from "./perimeter.js";
import {
    checkHealthSyncRateLimit,
    clearAuthFailures,
    getBanState,
    type RateLimitResult,
} from "./rate-limit.js";
const API = "/api/v1/health-sync";

/** Paths this router owns. src/index.ts keeps the global CORS middleware off
 *  them: the shortcut sends no Origin, and nothing in a browser should be
 *  able to read these responses cross-origin. */
export function isHealthSyncPath(path: string): boolean {
    return (
        path === API ||
        path.startsWith(`${API}/`) ||
        path === "/health-sync" ||
        path.startsWith("/health-sync/")
    );
}

// ---------- dependencies ----------

/** The user data /pending and /claim read. Injectable so the route tests run
 *  on fakes; the default is src/db/repo.ts. */
export interface HealthSyncData {
    /** The profile's own timezone, null when never set (no row, or a row
     *  whose timezone is null). */
    getProfileTimezone(userId: string): Promise<string | null>;
    /** Meals in [from, to] (local dates in `tz`), reconciled: throws rather
     *  than return a truncated read. */
    getMeals(
        userId: string,
        from: string,
        to: string,
        tz: string,
    ): Promise<HealthSyncMeal[]>;
    getWater(
        userId: string,
        from: string,
        to: string,
        tz: string,
    ): Promise<HealthSyncWater[]>;
}

export const repoHealthSyncData: HealthSyncData = {
    async getProfileTimezone(userId) {
        return timezoneFromProfile(await getProfile(userId));
    },
    getMeals: getMealsInRange,
    getWater: getWaterInRange,
};

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
    store?: HealthSyncStore;
    activityStore?: HealthActivityLinkStore;
    activityData?: HealthActivityData;
    data?: HealthSyncData;
    now?: () => number;
}

// ---------- envelope, logging ----------

export type HealthSyncErrorCode =
    | "invalid_token"
    | "invalid_code"
    | "expired"
    | "busy"
    | "rate_limited"
    | "unavailable"
    | "bad_request"
    | "server_error";

type Route =
    | "start"
    | "connect"
    | "callback"
    | "claim"
    | "pending"
    | "ack"
    | "revoke"
    | "activity"
    | "unknown";

/** What a handler reports for its one log line. */
interface CallNote {
    result: string;
    entries?: number;
    notices?: number;
    /** Set for server_error / unavailable: the ref the caller was shown, and
     *  the raw error text, JSON-escaped and capped like toolLogLine. */
    ref?: string;
    error?: string;
    /** A process-wide signal worth an operator's eye (no per-user data). */
    alert?: string;
}

type Env = {
    Variables: {
        hsLink: HealthSyncLinkRow;
        haLink: HealthActivityLinkRow;
        /** Which link authenticated the call. */
        hsKind: HealthSyncConnectKind;
        hsNote: CallNote;
    };
};

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
    if (note.alert) line += ` alert=${note.alert}`;
    if (note.ref) line += ` ref=${note.ref}`;
    if (note.error !== undefined) line += `: ${JSON.stringify(note.error)}`;
    return line;
}

const API_HEADERS = { "Cache-Control": "private, no-store" } as const;

/** invalid_token for the activity shortcut's own routes. */
const ACTIVITY_INVALID_TOKEN =
    "This shortcut is no longer connected to Nutrition MCP. Run the Nutrition MCP Activity shortcut again to reconnect.";

const MESSAGES: Record<
    Exclude<HealthSyncErrorCode, "bad_request" | "rate_limited">,
    string
> = {
    invalid_token:
        "This shortcut is no longer connected to Nutrition MCP. Run the Nutrition MCP Health shortcut again to reconnect.",
    // /claim cannot tell which shortcut sent a code it does not recognise, so
    // these two name neither.
    invalid_code:
        "This sign-in could not be matched to the shortcut that started it, or it was already used. Run the shortcut again to connect.",
    expired:
        "This connect request has expired. Run the shortcut again to connect.",
    busy: "Another sync is already running for this account. Try again in a couple of minutes.",
    unavailable:
        "Nutrition MCP could not reach its database, so nothing was read or changed. Try again in a few minutes.",
    server_error:
        "Something went wrong on the Nutrition MCP server, so nothing was changed. Try again later.",
};

function fail(
    c: Context<Env>,
    status: 400 | 401 | 404 | 405 | 409 | 429 | 500 | 503,
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

const MINUTE_MS = 60_000;

function toLedger(row: HealthSyncDayRow): LedgerRow {
    return {
        date: row.date,
        timezone: row.timezone,
        sent_values: row.sent_values as DayValues | null,
        topup_seq: row.topup_seq,
        offer_count: row.offer_count,
        notified: row.notified as LedgerRow["notified"],
        first_sent_at: row.first_sent_at,
        last_sent_at: row.last_sent_at,
    };
}

function toDayRow(userId: string, row: LedgerRow): HealthSyncDayRow {
    return {
        user_id: userId,
        date: row.date,
        timezone: row.timezone,
        sent_values: (row.sent_values as Record<string, number> | null) ?? null,
        topup_seq: row.topup_seq,
        offer_count: row.offer_count,
        notified: row.notified,
        first_sent_at: row.first_sent_at,
        last_sent_at: row.last_sent_at,
    };
}

function linkFields(link: HealthSyncLinkRow): HealthSyncField[] {
    return link.fields.filter(isHealthSyncField);
}

/**
 * Write what /pending decided — offer counts, notices, a re-adopted zone —
 * without touching `sent_values` or `topup_seq`, which only an ack sets. New
 * rows are inserted (a date that gained a row in between keeps it); existing
 * ones are updated only if still as `ledger` read them. Returns the dates
 * written, which are the only ones whose entries may be offered.
 */
async function recordOffers(
    store: HealthSyncStore,
    userId: string,
    ledger: readonly LedgerRow[],
    updates: readonly LedgerRow[],
): Promise<Set<string>> {
    const before = new Map(ledger.map((r) => [r.date, r]));
    const fresh = updates.filter((r) => !before.has(r.date));
    const [inserted, updated] = await Promise.all([
        store.insertDays(fresh.map((r) => toDayRow(userId, r))),
        Promise.all(
            updates
                .filter((r) => before.has(r.date))
                .map(async (r) => {
                    const b = before.get(r.date)!;
                    const ok = await store.updateDay(
                        userId,
                        r.date,
                        {
                            timezone: r.timezone,
                            offer_count: r.offer_count,
                            notified: r.notified,
                        },
                        {
                            topup_seq: b.topup_seq,
                            sentNull: b.sent_values === null,
                        },
                    );
                    return ok ? r.date : null;
                }),
        ),
    ]);
    return new Set([
        ...inserted,
        ...updated.filter((d): d is string => d !== null),
    ]);
}

export function createHealthSyncRouter(deps: HealthSyncRouterDeps = {}) {
    const router = new Hono<Env>();
    const store = deps.store ?? createSqliteHealthSyncStore();
    const activityStore =
        deps.activityStore ?? createSqliteHealthActivityLinkStore();
    const activityData = deps.activityData ?? repoHealthActivityData;
    const data = deps.data ?? repoHealthSyncData;
    const now = deps.now ?? Date.now;

    // One log line per call, written after the response is built. The note is
    // filled in by whichever branch answered; a throw that escaped a handler
    // (none should) still logs, as server_error, before propagating.
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

    // An IP banned for repeated auth failures (here or at /mcp — the strikes
    // are shared) is refused before any lookup, in the envelope. Its access
    // log line is suppressed exactly as banRepeatAuthFailures does for /mcp.
    const banGuard = async (c: Context<Env>, next: Next) => {
        const ban = getBanState(getClientIp(c));
        if (ban.banned) {
            c.set("suppressAccessLog", true);
            return rateLimited(c, {
                allowed: false,
                retryAfterSeconds: ban.retryAfterSeconds,
                remaining: 0,
                limit: 0,
            });
        }
        await next();
    };

    // Link-token auth. Three outcomes, like authenticateBearer: unavailable
    // (we could not check) is a 503 with no strike, so a database outage
    // never bans a phone; invalid is a 401 and a strike. Anything without the
    // nmhs_ shape is refused without a
    // database call, and still strikes. `kinds` lists the links a route
    // accepts, looked up in that order: the Apple Health link for /pending
    // and /ack, the activity link for /activity, either for /revoke.
    const tokenAuth =
        (kinds: readonly HealthSyncConnectKind[]) =>
        async (c: Context<Env>, next: Next) => {
            const header = c.req.header("Authorization") ?? "";
            const token = header.startsWith("Bearer ") ? header.slice(7) : "";
            const invalid = () => {
                recordAuthFailure(c);
                return fail(
                    c,
                    401,
                    "invalid_token",
                    kinds[0] === "activity"
                        ? ACTIVITY_INVALID_TOKEN
                        : MESSAGES.invalid_token,
                    {
                        headers: {
                            "WWW-Authenticate":
                                'Bearer realm="nutrition-mcp", error="invalid_token"',
                        },
                    },
                );
            };
            if (
                !token.startsWith(HEALTH_SYNC_TOKEN_PREFIX) ||
                !looksLikeHealthSyncToken(token)
            ) {
                return invalid();
            }
            const at = new Date(now());
            let found:
                | { kind: "health"; link: HealthSyncLinkRow }
                | { kind: "activity"; link: HealthActivityLinkRow }
                | null = null;
            for (const kind of kinds) {
                // The stores answer "unavailable" rather than throwing; a
                // throw is treated the same, since it equally means we could
                // not check.
                const lookup =
                    kind === "health"
                        ? await store
                              .lookupLink(token, at)
                              .catch(() => ({ status: "unavailable" }) as const)
                        : await activityStore
                              .lookupActivityLink(token, at)
                              .catch(
                                  () => ({ status: "unavailable" }) as const,
                              );
                if (lookup.status === "unavailable") {
                    const ref = newErrorRef();
                    c.get("hsNote").ref = ref;
                    return fail(
                        c,
                        503,
                        "unavailable",
                        `${MESSAGES.unavailable} (ref ${ref})`,
                        { ref, headers: { "Retry-After": "60" } },
                    );
                }
                if (lookup.status === "valid") {
                    found =
                        kind === "health"
                            ? {
                                  kind,
                                  link: lookup.link as HealthSyncLinkRow,
                              }
                            : {
                                  kind,
                                  link: lookup.link as HealthActivityLinkRow,
                              };
                    break;
                }
            }
            if (!found) return invalid();

            clearAuthFailures(getClientIp(c));
            const link = found.link;

            const limit = checkHealthSyncRateLimit(link.user_id);
            if (!limit.allowed) return rateLimited(c, limit);

            // Slide the expiry at most once an hour, against the value just
            // read. Fire-and-forget: a missed touch only means the next call
            // tries again, and must not fail or slow the sync.
            const lastUsed = link.last_used_at
                ? new Date(link.last_used_at)
                : null;
            if (shouldTouchLink(lastUsed, at)) {
                const expires = linkExpiresAt(new Date(link.created_at), at);
                const touch =
                    found.kind === "health"
                        ? store.touchLink(
                              link.user_id,
                              at.toISOString(),
                              expires.toISOString(),
                          )
                        : activityStore.touchActivityLink(
                              link.user_id,
                              at.toISOString(),
                              expires.toISOString(),
                          );
                void touch.catch(() => {});
            }

            c.set("hsKind", found.kind);
            if (found.kind === "health") c.set("hsLink", found.link);
            else c.set("haLink", found.link);
            await next();
        };
    const linkAuth = tokenAuth(["health"]);
    const activityAuth = tokenAuth(["activity"]);
    const anyLinkAuth = tokenAuth(["health", "activity"]);

    // ---- GET /pending ----
    router.get(
        `${API}/pending`,
        logged("pending"),
        banGuard,
        linkAuth,
        async (c) => {
            const link = c.get("hsLink");
            const userId = link.user_id;
            const at = new Date(now());
            let leaseUntil: string | null = null;
            try {
                const profileTz = await io(data.getProfileTimezone(userId));
                const { tz, source } = effectiveTimezone(
                    profileTz,
                    link.fallback_tz,
                );

                leaseUntil = new Date(
                    at.getTime() + HEALTH_SYNC_LEASE_SECONDS * 1000,
                ).toISOString();
                const leased = await io(
                    store.acquireLease(userId, leaseUntil, at),
                );
                if (!leased) {
                    leaseUntil = null;
                    return fail(c, 409, "busy", MESSAGES.busy);
                }

                const fields = linkFields(link);
                // Sync now, run by hand: stuck entries get a fresh set of
                // offers (see PendingInput.retryStuck).
                const manual = c.req.query("mode") === "manual";
                const win = offeringWindow(at, tz, link.sync_start_date);
                let plan = {
                    entries: [] as ReturnType<typeof planPending>["entries"],
                    notices: [] as string[],
                    syncedThrough: null as string | null,
                };
                if (win.from !== null) {
                    const from = win.from;
                    // Fail closed: if any read fails, nothing is computed,
                    // offered or written — a partial read would offer a day's
                    // total that is too low, and Health cannot lower it.
                    const [meals, water, days] = await Promise.all([
                        io(data.getMeals(userId, from, win.to, tz)),
                        fields.includes("water_ml")
                            ? io(data.getWater(userId, from, win.to, tz))
                            : Promise.resolve([] as HealthSyncWater[]),
                        io(store.getDays(userId, from, win.to)),
                    ]);
                    const totals = computeDayTotals(
                        meals,
                        water,
                        tz,
                        win.dates,
                    );
                    const ledger = days.map(toLedger);
                    const p = planPending({
                        dates: win.dates,
                        totals,
                        ledger,
                        fields,
                        tz,
                        retryStuck: manual,
                    });
                    // Offer counts and notices are recorded before anything
                    // is offered, so a notice is shown once and a stuck
                    // entry stops being offered. Only those columns, and
                    // only onto a row still as it was read: an ack landing
                    // in between (from a run whose lease lapsed) must not be
                    // undone, and a day whose row moved on is not offered.
                    const written = await io(
                        recordOffers(store, userId, ledger, p.ledgerUpdates),
                    );
                    plan = {
                        ...p,
                        entries: p.entries.filter((e) => written.has(e.date)),
                    };
                }

                const note = c.get("hsNote");
                note.entries = plan.entries.length;
                note.notices = plan.notices.length;
                return ok(c, {
                    version: 1,
                    complete: true,
                    timezone: tz,
                    timezone_source: source,
                    lease_until: leaseUntil,
                    entries: plan.entries,
                    notices: plan.notices,
                    status: {
                        synced_through: plan.syncedThrough,
                        next_day_ready_at: formatInstantWithOffset(
                            win.nextDayReadyAt,
                            tz,
                        ),
                    },
                });
            } catch (err) {
                // Hand the lease back so the retry the message suggests is
                // not refused as busy. Only this run's lease.
                if (leaseUntil !== null) {
                    void store.releaseLease(userId, leaseUntil).catch(() => {});
                }
                return failFromError(c, err);
            }
        },
    );

    // ---- POST /ack ----
    router.post(`${API}/ack`, logged("ack"), banGuard, linkAuth, async (c) => {
        const link = c.get("hsLink");
        const userId = link.user_id;
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
            const parsed = parseAckBody(json.value, linkFields(link));
            if (!parsed.ok) {
                return fail(c, 400, "bad_request", parsed.message);
            }
            const { entries, done } = parsed.value;
            const at = new Date(now());

            let applied = 0;
            if (entries.length > 0) {
                const profileTz = await io(data.getProfileTimezone(userId));
                const { tz } = effectiveTimezone(profileTz, link.fallback_tz);
                // Only dates /pending can have offered: anything else (a
                // future date, a day long gone) is skipped, so no ledger row
                // ever lands outside what the 8-day sweep removes.
                const win = ackWindow(at, tz, link.sync_start_date);
                const eligible = win
                    ? entries.filter(
                          (e) => e.date >= win.from && e.date <= win.to,
                      )
                    : [];
                const dates = eligible.map((e) => e.date).sort();
                const existing =
                    dates.length > 0
                        ? await io(
                              store.getDays(
                                  userId,
                                  dates[0]!,
                                  dates[dates.length - 1]!,
                              ),
                          )
                        : [];
                // As read: the state each guarded write below requires.
                const before = new Map(
                    existing.map((r) => [r.date, toLedger(r)]),
                );
                const rows = new Map(before);
                const appliedByDate = new Map<string, number>();
                // In order, against the row as each earlier entry left
                // it, so t1 and t2 for one day in one batch both apply. A
                // day with no row was never offered, so its ack is skipped.
                for (const entry of eligible) {
                    const row = rows.get(entry.date);
                    if (!row) continue;
                    const r = applyAck(row, entry, tz, at);
                    if (r.applied && r.row) {
                        rows.set(entry.date, r.row);
                        appliedByDate.set(
                            entry.date,
                            (appliedByDate.get(entry.date) ?? 0) + 1,
                        );
                    }
                }
                // One conditional write per day, onto the row as it was
                // read; a day another run changed in between counts as
                // skipped, and the next /pending re-offers what is missing.
                // `notified` is /pending's and is never written here.
                const results = await Promise.all(
                    [...appliedByDate].map(async ([date, n]) => {
                        const r = rows.get(date)!;
                        const b = before.get(date)!;
                        const ok = await io(
                            store.updateDay(
                                userId,
                                date,
                                {
                                    timezone: r.timezone,
                                    sent_values: r.sent_values as Record<
                                        string,
                                        number
                                    >,
                                    topup_seq: r.topup_seq,
                                    offer_count: r.offer_count,
                                    first_sent_at: r.first_sent_at,
                                    last_sent_at: r.last_sent_at,
                                },
                                {
                                    topup_seq: b.topup_seq,
                                    sentNull: b.sent_values === null,
                                },
                            ),
                        );
                        return ok ? n : 0;
                    }),
                );
                applied = results.reduce((a, n) => a + n, 0);
                if (applied > 0) {
                    await io(store.setLastSync(userId, at.toISOString()));
                }
            }
            // Only the lease this run took: a late ack from a run whose
            // lease lapsed must not free the one a newer run now holds.
            if (done && parsed.value.lease_until !== undefined) {
                await io(store.releaseLease(userId, parsed.value.lease_until));
            }

            c.get("hsNote").entries = entries.length;
            return ok(c, { applied, skipped: entries.length - applied });
        } catch (err) {
            return failFromError(c, err);
        }
    });

    // ---- POST /revoke ----
    // Either shortcut's token, and only that shortcut's link goes: the other
    // one keeps syncing.
    router.post(
        `${API}/revoke`,
        logged("revoke"),
        banGuard,
        anyLinkAuth,
        async (c) => {
            try {
                if (c.get("hsKind") === "activity") {
                    await io(
                        activityStore.deleteActivityLink(
                            c.get("haLink").user_id,
                        ),
                    );
                } else {
                    await io(store.deleteLink(c.get("hsLink").user_id));
                }
                return ok(c, {});
            } catch (err) {
                return failFromError(c, err);
            }
        },
    );

    // ---- POST /activity ----
    //
    // The activity shortcut's day totals (see src/health-activity-sync.ts for
    // the rules). Each accepted day replaces that day's Apple Health row in
    // active_calories_log; nothing here touches hand-logged entries, Apple
    // Health itself, or the Apple Health sync's ledger.
    router.post(
        `${API}/activity`,
        logged("activity"),
        banGuard,
        activityAuth,
        async (c) => {
            const link = c.get("haLink");
            const userId = link.user_id;
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
                if (!parsed.ok) {
                    return fail(c, 400, "bad_request", parsed.message);
                }
                const at = new Date(now());
                const profile = await io(
                    activityData.getActivityProfile(userId),
                );
                // The account's zone decides the dates, as every reader
                // buckets by it; the phone's only stands in when none is set.
                const { tz, source } = effectiveTimezone(
                    profile.tz,
                    parsed.value.tz ?? link.fallback_tz,
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
                await io(
                    activityStore.setActivitySynced(
                        userId,
                        at.toISOString(),
                        parsed.value.tz,
                    ),
                );
                const note = c.get("hsNote");
                note.entries = plan.writes.length;
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

    // ---- anything else under the API ----
    //
    // A wrong method or a mistyped path still answers in the envelope, so the
    // shortcut's `ok` branch can show the message rather than a bare 404.
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
    router.all(API, logged("unknown"), unknownApi);
    router.all(`${API}/*`, logged("unknown"), unknownApi);

    return router;
}

/** Each API path's one method, for the catch-all's 405. */
const API_METHODS: Record<string, string> = {
    [`${API}/start`]: "POST",
    [`${API}/claim`]: "POST",
    [`${API}/pending`]: "GET",
    [`${API}/ack`]: "POST",
    [`${API}/revoke`]: "POST",
    [`${API}/activity`]: "POST",
};
