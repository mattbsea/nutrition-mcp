import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { Hono } from "hono";
import {
    createHealthSyncRouter,
    isHealthSyncPath,
    type HealthActivityData,
    type HealthSyncData,
} from "./health-sync-routes.js";
import type { ActivityWrite } from "./health-activity-sync.js";
import { HEALTH_ACTIVITY_SHORTCUT_NAME } from "./health-activity-sync.js";
import type {
    HealthActivityLinkRow,
    HealthActivityLinkStore,
    HealthSyncDayRow,
    HealthSyncLinkRow,
    HealthSyncPendingRow,
    HealthSyncStore,
} from "./db/repo.js";
import type { HealthSyncMeal, HealthSyncWater } from "./health-sync.js";
import { HEALTH_SYNC_SHORTCUT_NAME } from "./health-sync.js";
import { _resetBuckets, getBanState } from "./rate-limit.js";

// Everything runs against in-memory fakes passed to createHealthSyncRouter —
// never mock.module, which is process-wide (see CLAUDE.md). The fakes keep
// the store's contract (secrets in raw, matched exactly; consumes single-use)
// without its hashing, which src/health-sync-store.test.ts pins on its own.

const NOW = Date.parse("2026-10-03T12:00:00Z"); // 15:00 in Kyiv
const KYIV = "Europe/Kyiv";
const BASE = "http://x";
const USER = "11111111-2222-3333-4444-555555555555";

interface PendingRec {
    row: HealthSyncPendingRow;
    connectId: string;
    deviceSecret: string;
    claimCode: string | null;
}

function fakeStore() {
    const pending: PendingRec[] = [];
    const links = new Map<string, { row: HealthSyncLinkRow; token: string }>();
    const days = new Map<string, HealthSyncDayRow>();
    const calls: string[] = [];
    const fail = new Set<string>();
    let lookupState: "normal" | "unavailable" = "normal";
    const maybeFail = (name: string) => {
        calls.push(name);
        if (fail.has(name)) throw new Error(`${name} failed`);
    };
    const live = (rec: PendingRec, now: Date) =>
        rec.row.claim_expires_at !== null
            ? Date.parse(rec.row.claim_expires_at) > now.getTime()
            : Date.parse(rec.row.expires_at) > now.getTime();

    const store: HealthSyncStore = {
        async createPending(input) {
            maybeFail("createPending");
            pending.push({
                connectId: input.connectId,
                deviceSecret: input.deviceSecret,
                claimCode: null,
                row: {
                    id: crypto.randomUUID(),
                    kind: input.kind,
                    fields: input.fields,
                    tz: input.tz,
                    backfill_days: input.backfillDays,
                    pkce_verifier: input.pkceVerifier,
                    user_id: null,
                    claim_expires_at: null,
                    created_at: new Date(NOW).toISOString(),
                    expires_at: input.expiresAt,
                },
            });
        },
        async getPendingByConnectId(connectId, now) {
            maybeFail("getPendingByConnectId");
            const rec = pending.find((p) => p.connectId === connectId);
            if (!rec) return null;
            const at = now ?? new Date();
            return Date.parse(rec.row.expires_at) > at.getTime()
                ? { ...rec.row }
                : null;
        },
        async setPendingClaim(connectId, claimCode, userId, until, now) {
            maybeFail("setPendingClaim");
            const rec = pending.find((p) => p.connectId === connectId);
            const at = now ?? new Date();
            if (
                !rec ||
                rec.claimCode !== null ||
                Date.parse(rec.row.expires_at) <= at.getTime()
            )
                return false;
            rec.claimCode = claimCode;
            rec.row.user_id = userId;
            rec.row.claim_expires_at = until;
            rec.row.pkce_verifier = null;
            return true;
        },
        async consumeClaim(claimCode, deviceSecret, now) {
            maybeFail("consumeClaim");
            const at = now ?? new Date();
            const i = pending.findIndex(
                (p) =>
                    p.claimCode === claimCode &&
                    p.deviceSecret === deviceSecret &&
                    live(p, at),
            );
            if (i < 0) return null;
            const [rec] = pending.splice(i, 1);
            return rec!.row;
        },
        async replaceLink(userId, link, token) {
            maybeFail("replaceLink");
            links.set(userId, {
                token,
                row: {
                    id: crypto.randomUUID(),
                    user_id: userId,
                    kind: "shortcut",
                    fields: link.fields,
                    fallback_tz: link.fallbackTz,
                    sync_start_date: link.syncStartDate,
                    lease_until: null,
                    created_at: new Date(NOW).toISOString(),
                    last_used_at: null,
                    last_sync_at: null,
                    expires_at: link.expiresAt,
                },
            });
        },
        async lookupLink(token, now) {
            calls.push("lookupLink");
            if (lookupState === "unavailable") return { status: "unavailable" };
            const at = now ?? new Date();
            for (const l of links.values()) {
                if (
                    l.token === token &&
                    Date.parse(l.row.expires_at) > at.getTime()
                )
                    return { status: "valid", link: { ...l.row } };
            }
            return { status: "invalid" };
        },
        async touchLink(userId, lastUsedAt, expiresAt) {
            maybeFail("touchLink");
            const l = links.get(userId);
            if (l) {
                l.row.last_used_at = lastUsedAt;
                l.row.expires_at = expiresAt;
            }
        },
        async setLastSync(userId, at) {
            maybeFail("setLastSync");
            const l = links.get(userId);
            if (l) l.row.last_sync_at = at;
        },
        async acquireLease(userId, until, now) {
            maybeFail("acquireLease");
            const l = links.get(userId);
            const at = now ?? new Date();
            if (!l) return false;
            if (
                l.row.lease_until !== null &&
                Date.parse(l.row.lease_until) >= at.getTime()
            )
                return false;
            l.row.lease_until = until;
            return true;
        },
        async releaseLease(userId, heldUntil) {
            maybeFail("releaseLease");
            const l = links.get(userId);
            if (!l) return;
            if (heldUntil !== undefined && l.row.lease_until !== heldUntil)
                return;
            l.row.lease_until = null;
        },
        async getDays(userId, from, to) {
            maybeFail("getDays");
            return [...days.values()]
                .filter(
                    (d) =>
                        d.user_id === userId && d.date >= from && d.date <= to,
                )
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((d) => structuredClone(d));
        },
        async insertDays(rows) {
            maybeFail("insertDays");
            const inserted: string[] = [];
            for (const r of rows) {
                const k = `${r.user_id}|${r.date}`;
                if (days.has(k)) continue;
                days.set(k, structuredClone(r));
                inserted.push(r.date);
            }
            return inserted;
        },
        async updateDay(userId, date, patch, expect) {
            maybeFail("updateDay");
            const d = days.get(`${userId}|${date}`);
            if (
                !d ||
                d.topup_seq !== expect.topup_seq ||
                (d.sent_values === null) !== expect.sentNull
            )
                return false;
            Object.assign(d, structuredClone(patch));
            return true;
        },
        async deleteLink(userId) {
            maybeFail("deleteLink");
            links.delete(userId);
            for (const [k, d] of days) if (d.user_id === userId) days.delete(k);
        },
        async getLinkStatus() {
            return null;
        },
        async getDaysForExport() {
            return [];
        },
    };
    return {
        store,
        pending,
        links,
        days,
        calls,
        fail,
        setLookup(s: "normal" | "unavailable") {
            lookupState = s;
        },
    };
}

function fakeData(
    opts: {
        tz?: string | null;
        meals?: Partial<HealthSyncMeal>[];
        water?: HealthSyncWater[];
    } = {},
) {
    const fail = new Set<string>();
    const reads: string[] = [];
    const data: HealthSyncData = {
        async getProfileTimezone() {
            reads.push("profile");
            if (fail.has("profile")) throw new Error("profile down");
            return opts.tz === undefined ? KYIV : opts.tz;
        },
        async getMeals() {
            reads.push("meals");
            if (fail.has("meals"))
                throw new Error("meals: result would be truncated (1 of 2)");
            return (opts.meals ?? []) as HealthSyncMeal[];
        },
        async getWater() {
            reads.push("water");
            if (fail.has("water")) throw new Error("water down");
            return opts.water ?? [];
        },
    };
    return { data, fail, reads };
}

/** The activity link table and the active-calories writes, in memory. */
function fakeActivity(opts: { tz?: string | null; creditPct?: number } = {}) {
    const links = new Map<
        string,
        { row: HealthActivityLinkRow; token: string }
    >();
    const writes: { userId: string; days: ActivityWrite[] }[] = [];
    const fail = new Set<string>();
    const activityStore: HealthActivityLinkStore = {
        async replaceActivityLink(userId, link, token) {
            if (fail.has("replaceActivityLink")) throw new Error("down");
            links.set(userId, {
                token,
                row: {
                    id: crypto.randomUUID(),
                    user_id: userId,
                    fallback_tz: link.fallbackTz,
                    created_at: new Date(NOW).toISOString(),
                    last_used_at: null,
                    last_sync_at: null,
                    expires_at: link.expiresAt,
                },
            });
        },
        async lookupActivityLink(token, now) {
            const at = now ?? new Date();
            for (const l of links.values()) {
                if (
                    l.token === token &&
                    Date.parse(l.row.expires_at) > at.getTime()
                )
                    return { status: "valid", link: { ...l.row } };
            }
            return { status: "invalid" };
        },
        async touchActivityLink(userId, lastUsedAt, expiresAt) {
            const l = links.get(userId);
            if (l) {
                l.row.last_used_at = lastUsedAt;
                l.row.expires_at = expiresAt;
            }
        },
        async setActivitySynced(userId, at, fallbackTz) {
            const l = links.get(userId);
            if (l) {
                l.row.last_sync_at = at;
                if (fallbackTz !== null) l.row.fallback_tz = fallbackTz;
            }
        },
        async deleteActivityLink(userId) {
            links.delete(userId);
        },
        async getActivityLinkStatus() {
            return null;
        },
    };
    const activityData: HealthActivityData = {
        async getActivityProfile() {
            if (fail.has("profile")) throw new Error("profile down");
            return {
                tz: opts.tz === undefined ? KYIV : opts.tz,
                creditPct: opts.creditPct ?? 100,
            };
        },
        async writeActivityDays(userId, days) {
            if (fail.has("write")) throw new Error("write down");
            writes.push({ userId, days: [...days] });
            return days.length;
        },
    };
    return {
        activityStore,
        activityData,
        activityLinks: links,
        writes,
        activityFail: fail,
    };
}

function setup(
    dataOpts: Parameters<typeof fakeData>[0] = {},
    activityOpts: Parameters<typeof fakeActivity>[0] = {},
) {
    const s = fakeStore();
    const d = fakeData(dataOpts);
    const a = fakeActivity(activityOpts);
    let clock = NOW;
    const router = createHealthSyncRouter({
        activityStore: a.activityStore,
        activityData: a.activityData,
        store: s.store,
        data: d.data,
        now: () => clock,
    });
    const app = new Hono();
    app.route("/", router);
    app.onError((err, c) => {
        // Nothing may fall through to the app's error handler.
        throw new Error(`reached onError: ${err.message}`);
        return c.text("x", 500);
    });
    const req = (
        path: string,
        init: {
            method?: string;
            body?: unknown;
            token?: string;
            ip?: string;
            headers?: Record<string, string>;
        } = {},
    ) =>
        app.request(`${BASE}${path}`, {
            method: init.method ?? "GET",
            headers: {
                "x-forwarded-for": init.ip ?? "203.0.113.7",
                ...(init.body !== undefined
                    ? { "content-type": "application/json" }
                    : {}),
                ...(init.token
                    ? { Authorization: `Bearer ${init.token}` }
                    : {}),
                ...init.headers,
            },
            ...(init.body !== undefined
                ? {
                      body:
                          typeof init.body === "string"
                              ? init.body
                              : JSON.stringify(init.body),
                  }
                : {}),
        });
    return {
        ...s,
        ...a,
        dataFail: d.fail,
        reads: d.reads,
        req,
        setClock: (t: number) => {
            clock = t;
        },
    };
}

type Ctx = ReturnType<typeof setup>;

/** Seed a link directly, as /claim would have written it. */
function seedLink(
    ctx: Ctx,
    over: Partial<HealthSyncLinkRow> = {},
    token = `nmhs_${"a".repeat(43)}`,
) {
    ctx.links.set(USER, {
        token,
        row: {
            id: "link-1",
            user_id: USER,
            kind: "shortcut",
            fields: [
                "energy_kcal",
                "protein_g",
                "carbohydrates_g",
                "fat_g",
                "fiber_g",
                // Links created before sugar left the sync still list it;
                // the routes drop it, so a meal's sugar is never offered.
                "sugar_g",
                "caffeine_mg",
            ],
            fallback_tz: null,
            sync_start_date: "2026-09-25",
            lease_until: null,
            created_at: "2026-09-25T10:00:00.000Z",
            last_used_at: null,
            last_sync_at: null,
            expires_at: "2026-12-25T10:00:00.000Z",
            ...over,
        },
    });
    return token;
}

/** A day row as /pending leaves it once it has offered the initial entry. */
function offeredRow(date: string): HealthSyncDayRow {
    return {
        user_id: USER,
        date,
        timezone: KYIV,
        sent_values: null,
        topup_seq: 0,
        offer_count: 1,
        notified: {},
        first_sent_at: null,
        last_sent_at: null,
    };
}

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
const lines = () =>
    [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .map((args) => args.map(String).join(" "))
        .filter((l) => l.startsWith("[health-sync]"));

// The ban test identifies clients by X-Forwarded-For, which the perimeter only
// believes with TRUST_PROXY=1.
const trustBefore = process.env.TRUST_PROXY;
beforeEach(() => {
    process.env.TRUST_PROXY = "1";
    _resetBuckets();
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    if (trustBefore === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trustBefore;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    _resetBuckets();
});

describe("link-token auth", () => {
    test("a missing token is a 401 invalid_token with a realm challenge", async () => {
        const ctx = setup();
        const r = await ctx.req("/api/v1/health-sync/pending");
        expect(r.status).toBe(401);
        expect(r.headers.get("www-authenticate")).toBe(
            'Bearer realm="nutrition-mcp", error="invalid_token"',
        );
        const b = (await r.json()) as Record<string, string>;
        expect(b).toMatchObject({ ok: false, error: "invalid_token" });
        expect(b.message).toContain("Nutrition MCP Health");
    });

    test("a token without the nmhs_ shape is refused without a lookup", async () => {
        const ctx = setup();
        seedLink(ctx);
        // The shape newOpaqueToken() mints.
        const stray = "Q".repeat(43);
        const r = await ctx.req("/api/v1/health-sync/pending", {
            token: stray,
        });
        expect(r.status).toBe(401);
        expect(ctx.calls).not.toContain("lookupLink");
    });

    test("an unknown nmhs_ token is looked up and refused", async () => {
        const ctx = setup();
        seedLink(ctx);
        const r = await ctx.req("/api/v1/health-sync/pending", {
            token: `nmhs_${"z".repeat(43)}`,
        });
        expect(r.status).toBe(401);
        expect(ctx.calls).toContain("lookupLink");
    });

    test("an expired link is refused", async () => {
        const ctx = setup();
        const token = seedLink(ctx, {
            expires_at: "2026-10-01T00:00:00.000Z",
        });
        const r = await ctx.req("/api/v1/health-sync/pending", { token });
        expect(r.status).toBe(401);
    });

    test("unavailable is a 503 with no strike, so an outage never bans", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        ctx.setLookup("unavailable");
        for (let i = 0; i < 25; i++) {
            const r = await ctx.req("/api/v1/health-sync/pending", { token });
            expect(r.status).toBe(503);
            const b = (await r.json()) as Record<string, string>;
            expect(b.error).toBe("unavailable");
            expect(b.ref).toMatch(/^[0-9a-f]{8}$/);
        }
        expect(getBanState("203.0.113.7").banned).toBe(false);
        ctx.setLookup("normal");
        expect(
            (await ctx.req("/api/v1/health-sync/pending", { token })).status,
        ).toBe(200);
    });

    test("invalid tokens strike, and a banned IP is shed in the envelope", async () => {
        const ctx = setup();
        for (let i = 0; i < 20; i++) {
            const r = await ctx.req("/api/v1/health-sync/pending", {
                token: `nmhs_${"y".repeat(43)}`,
            });
            expect(r.status).toBe(401);
        }
        expect(getBanState("203.0.113.7").banned).toBe(true);
        const lookups = ctx.calls.filter((c) => c === "lookupLink").length;
        const r = await ctx.req("/api/v1/health-sync/pending", {
            token: `nmhs_${"y".repeat(43)}`,
        });
        expect(r.status).toBe(429);
        expect(await r.json()).toMatchObject({
            ok: false,
            error: "rate_limited",
        });
        expect(ctx.calls.filter((c) => c === "lookupLink").length).toBe(
            lookups,
        );
    });

    test("last use is stamped at most once an hour", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        await ctx.req("/api/v1/health-sync/ack", {
            method: "POST",
            token,
            body: { entries: [], done: true },
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(ctx.calls.filter((c) => c === "touchLink")).toHaveLength(1);
        const row = ctx.links.get(USER)!.row;
        expect(row.last_used_at).toBe(new Date(NOW).toISOString());
        expect(Date.parse(row.expires_at)).toBe(NOW + 90 * 86_400_000);
        ctx.setClock(NOW + 30 * 60_000);
        await ctx.req("/api/v1/health-sync/ack", {
            method: "POST",
            token,
            body: { entries: [], done: true },
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(ctx.calls.filter((c) => c === "touchLink")).toHaveLength(1);
    });

    test("the per-user bucket is 40 a minute, answered in the envelope", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        for (let i = 0; i < 40; i++) {
            const r = await ctx.req("/api/v1/health-sync/ack", {
                method: "POST",
                token,
                body: { entries: [], done: true },
            });
            expect(r.status).toBe(200);
        }
        const r = await ctx.req("/api/v1/health-sync/pending", { token });
        expect(r.status).toBe(429);
        expect(r.headers.get("retry-after")).toBeTruthy();
        expect(await r.json()).toMatchObject({
            ok: false,
            error: "rate_limited",
        });
    });
});

describe("GET /pending", () => {
    const meals = [
        // Oct 2 in Kyiv (UTC+3).
        {
            logged_at: "2026-10-02T06:00:00Z",
            calories: 600,
            protein_g: 30.04,
            carbs_g: null,
            fat_g: 20,
            fiber_g: null,
            sugar_g: null,
            caffeine_mg: 95,
        },
        {
            logged_at: "2026-10-02T18:30:00Z",
            calories: 900,
            protein_g: 40,
            carbs_g: null,
            fat_g: null,
            fiber_g: null,
            sugar_g: 0,
            caffeine_mg: null,
        },
        // Oct 3 in Kyiv: not closed yet at 15:00 local.
        {
            logged_at: "2026-10-03T08:00:00Z",
            calories: 400,
            protein_g: 10,
            carbs_g: 50,
            fat_g: 10,
            fiber_g: 5,
            sugar_g: 5,
            caffeine_mg: 0,
        },
    ] as unknown as Partial<HealthSyncMeal>[];

    test("offers closed days only, omitting nulls, and records the offer", async () => {
        const ctx = setup({ meals });
        const token = seedLink(ctx);
        const r = await ctx.req("/api/v1/health-sync/pending", { token });
        expect(r.status).toBe(200);
        expect(r.headers.get("cache-control")).toBe("private, no-store");
        const b = (await r.json()) as Record<string, any>;
        expect(b).toMatchObject({
            ok: true,
            version: 1,
            complete: true,
            timezone: KYIV,
            timezone_source: "profile",
            notices: [],
        });
        expect(b.lease_until).toBe(new Date(NOW + 120_000).toISOString());
        expect(b.entries).toEqual([
            {
                entry_id: "2026-10-02:i",
                date: "2026-10-02",
                kind: "initial",
                sample_local: "2026-10-02 12:00:00",
                values: {
                    energy_kcal: 1500,
                    protein_g: 70,
                    fat_g: 20,
                    caffeine_mg: 95,
                },
            },
        ]);
        expect(b.status).toEqual({
            synced_through: "2026-10-01",
            next_day_ready_at: "2026-10-04T05:00:00+03:00",
        });
        // Water is off for this link: never read.
        expect(ctx.reads).not.toContain("water");
        const day = ctx.days.get(`${USER}|2026-10-02`)!;
        expect(day.offer_count).toBe(1);
        expect(day.sent_values).toBeNull();
        expect(lines()).toEqual([
            "[health-sync] route=pending result=ok entries=1 notices=0",
        ]);
    });

    test("a second run inside the lease is busy", async () => {
        const ctx = setup({ meals });
        const token = seedLink(ctx);
        expect(
            (await ctx.req("/api/v1/health-sync/pending", { token })).status,
        ).toBe(200);
        const r = await ctx.req("/api/v1/health-sync/pending", { token });
        expect(r.status).toBe(409);
        expect(await r.json()).toMatchObject({ ok: false, error: "busy" });
        // Once it lapses, a run goes through again.
        ctx.setClock(NOW + 121_000);
        expect(
            (await ctx.req("/api/v1/health-sync/pending", { token })).status,
        ).toBe(200);
    });

    test("fails closed: a read failure computes and writes nothing, and frees the lease", async () => {
        for (const which of ["meals", "water", "profile"]) {
            const ctx = setup({ meals });
            const token = seedLink(ctx, {
                fields: ["energy_kcal", "water_ml"],
            });
            ctx.dataFail.add(which);
            const r = await ctx.req("/api/v1/health-sync/pending", { token });
            expect(r.status).toBe(503);
            const b = (await r.json()) as Record<string, unknown>;
            expect(b.ok).toBe(false);
            expect(b.error).toBe("unavailable");
            expect(b.entries).toBeUndefined();
            expect(ctx.calls).not.toContain("insertDays");
            expect(ctx.calls).not.toContain("updateDay");
            expect(ctx.days.size).toBe(0);
            await new Promise((res) => setTimeout(res, 0));
            expect(ctx.links.get(USER)!.row.lease_until).toBeNull();
            const line = lines()[0]!;
            expect(line).toContain("route=pending result=unavailable ref=");
            expect(line).not.toContain(USER);
        }
    });

    test("a ledger read failure fails closed too", async () => {
        const ctx = setup({ meals });
        const token = seedLink(ctx);
        ctx.fail.add("getDays");
        const r = await ctx.req("/api/v1/health-sync/pending", { token });
        expect(r.status).toBe(503);
        expect(ctx.calls).not.toContain("insertDays");
        expect(ctx.calls).not.toContain("updateDay");
    });

    test("an empty window answers without reading meals", async () => {
        const ctx = setup({ meals });
        // Paired today with no backfill: nothing has closed yet.
        const token = seedLink(ctx, { sync_start_date: "2026-10-03" });
        const r = await ctx.req("/api/v1/health-sync/pending", { token });
        const b = (await r.json()) as Record<string, any>;
        expect(b.entries).toEqual([]);
        expect(b.status.synced_through).toBeNull();
        expect(ctx.reads).not.toContain("meals");
    });

    test("falls back to the phone's zone, then UTC", async () => {
        const phone = setup({ tz: null });
        const t1 = seedLink(phone, { fallback_tz: "Asia/Tokyo" });
        const b1 = (await (
            await phone.req("/api/v1/health-sync/pending", { token: t1 })
        ).json()) as Record<string, any>;
        expect(b1.timezone).toBe("Asia/Tokyo");
        expect(b1.timezone_source).toBe("phone");

        const utc = setup({ tz: null });
        const t2 = seedLink(utc);
        const b2 = (await (
            await utc.req("/api/v1/health-sync/pending", { token: t2 })
        ).json()) as Record<string, any>;
        expect(b2.timezone).toBe("UTC");
        expect(b2.timezone_source).toBe("utc");
    });
});

describe("POST /ack", () => {
    const meals = [
        { logged_at: "2026-10-02T06:00:00Z", calories: 600, protein_g: 30 },
    ] as unknown as Partial<HealthSyncMeal>[];

    test("is idempotent, and done releases the lease", async () => {
        const ctx = setup({ meals });
        const token = seedLink(ctx);
        const p = (await (
            await ctx.req("/api/v1/health-sync/pending", { token })
        ).json()) as {
            lease_until: string;
            entries: { entry_id: string; date: string; values: object }[];
        };
        const entry = p.entries[0]!;
        expect(ctx.links.get(USER)!.row.lease_until).not.toBeNull();

        const ack = (done: boolean) =>
            ctx.req("/api/v1/health-sync/ack", {
                method: "POST",
                token,
                body: {
                    entries: [
                        {
                            entry_id: entry.entry_id,
                            date: entry.date,
                            values: entry.values,
                        },
                    ],
                    done,
                    lease_until: p.lease_until,
                },
            });
        const first = await ack(false);
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({
            ok: true,
            applied: 1,
            skipped: 0,
        });
        // Not done: the lease is still held.
        expect(ctx.links.get(USER)!.row.lease_until).not.toBeNull();
        const day = ctx.days.get(`${USER}|2026-10-02`)!;
        expect(day.sent_values).toEqual({ energy_kcal: 600, protein_g: 30 });
        expect(day.offer_count).toBe(0);
        expect(day.timezone).toBe(KYIV);
        expect(ctx.links.get(USER)!.row.last_sync_at).toBe(
            new Date(NOW).toISOString(),
        );

        const second = await ack(true);
        expect(await second.json()).toEqual({
            ok: true,
            applied: 0,
            skipped: 1,
        });
        expect(ctx.links.get(USER)!.row.lease_until).toBeNull();

        // Nothing left to offer.
        const again = (await (
            await ctx.req("/api/v1/health-sync/pending", { token })
        ).json()) as { entries: unknown[]; status: { synced_through: string } };
        expect(again.entries).toEqual([]);
        expect(again.status.synced_through).toBe("2026-10-02");
    });

    test("applies two top-ups for one day from one batch, in order", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        ctx.days.set(`${USER}|2026-10-02`, {
            user_id: USER,
            date: "2026-10-02",
            timezone: KYIV,
            sent_values: { energy_kcal: 500 },
            topup_seq: 0,
            offer_count: 0,
            notified: {},
            first_sent_at: "2026-10-03T03:00:00.000Z",
            last_sent_at: "2026-10-03T03:00:00.000Z",
        });
        const r = await ctx.req("/api/v1/health-sync/ack", {
            method: "POST",
            token,
            body: {
                entries: [
                    {
                        entry_id: "2026-10-02:t1",
                        date: "2026-10-02",
                        values: { energy_kcal: 100 },
                    },
                    {
                        entry_id: "2026-10-02:t2",
                        date: "2026-10-02",
                        values: { energy_kcal: 50 },
                    },
                ],
            },
        });
        expect(await r.json()).toEqual({ ok: true, applied: 2, skipped: 0 });
        const day = ctx.days.get(`${USER}|2026-10-02`)!;
        expect(day.sent_values).toEqual({ energy_kcal: 650 });
        expect(day.topup_seq).toBe(2);
    });

    test("refuses a field the link does not send, and other bad bodies", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        for (const body of [
            {
                entries: [
                    {
                        entry_id: "2026-10-02:i",
                        date: "2026-10-02",
                        values: { water_ml: 500 },
                    },
                ],
            },
            {
                entries: [
                    {
                        entry_id: "2026-10-02:i",
                        date: "2026-10-02",
                        values: { energy_kcal: -1 },
                    },
                ],
            },
            {
                entries: Array.from({ length: 21 }, () => ({
                    entry_id: "2026-10-02:i",
                    date: "2026-10-02",
                    values: { energy_kcal: 1 },
                })),
            },
            "{",
        ]) {
            const r = await ctx.req("/api/v1/health-sync/ack", {
                method: "POST",
                token,
                body,
            });
            expect(r.status).toBe(400);
            expect(((await r.json()) as { error: string }).error).toBe(
                "bad_request",
            );
        }
        expect(ctx.calls).not.toContain("insertDays");
        expect(ctx.calls).not.toContain("updateDay");
    });

    test("a store failure is unavailable with a ref", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        ctx.days.set(`${USER}|2026-10-02`, offeredRow("2026-10-02"));
        ctx.fail.add("updateDay");
        const r = await ctx.req("/api/v1/health-sync/ack", {
            method: "POST",
            token,
            body: {
                entries: [
                    {
                        entry_id: "2026-10-02:i",
                        date: "2026-10-02",
                        values: { energy_kcal: 10 },
                    },
                ],
            },
        });
        expect(r.status).toBe(503);
        expect(((await r.json()) as { error: string }).error).toBe(
            "unavailable",
        );
    });
});

describe("POST /ack: bounds and concurrency", () => {
    const meals = [
        { logged_at: "2026-10-02T06:00:00Z", calories: 600, protein_g: 30 },
    ] as unknown as Partial<HealthSyncMeal>[];
    const ack = (ctx: Ctx, token: string, body: unknown) =>
        ctx.req("/api/v1/health-sync/ack", { method: "POST", token, body });
    const initial = (date: string) => ({
        entry_id: `${date}:i`,
        date,
        values: { energy_kcal: 1 },
    });

    test("only dates /pending could have offered are applied", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        // Even a row that exists (however it got there) outside the window
        // is not written: future days, and days older than the window.
        for (const d of ["2030-01-01", "2026-10-03", "2026-09-20"]) {
            ctx.days.set(`${USER}|${d}`, offeredRow(d));
        }
        const r = await ack(ctx, token, {
            entries: [
                initial("2030-01-01"),
                initial("2030-01-02"),
                // Today: not closed yet.
                initial("2026-10-03"),
                // Before the window (lastClosed − 7 is 2026-09-25).
                initial("2026-09-20"),
            ],
        });
        expect(await r.json()).toEqual({ ok: true, applied: 0, skipped: 4 });
        expect(ctx.days.has(`${USER}|2030-01-02`)).toBe(false);
        for (const d of ["2030-01-01", "2026-10-03", "2026-09-20"]) {
            expect(ctx.days.get(`${USER}|${d}`)!.sent_values).toBeNull();
        }
        expect(ctx.calls).not.toContain("updateDay");
    });

    test("a day that was never offered (no row) is skipped", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        const r = await ack(ctx, token, { entries: [initial("2026-10-01")] });
        expect(await r.json()).toEqual({ ok: true, applied: 0, skipped: 1 });
        expect(ctx.days.size).toBe(0);
    });

    test("the day that slid out of the window at 05:00 is still taken", async () => {
        const ctx = setup();
        const token = seedLink(ctx, { sync_start_date: "2026-09-01" });
        // At 12:00Z on Oct 3 the window is Sep 26 – Oct 2; Sep 25 was its
        // first day until 05:00 this morning.
        ctx.days.set(`${USER}|2026-09-25`, offeredRow("2026-09-25"));
        const r = await ack(ctx, token, { entries: [initial("2026-09-25")] });
        expect(await r.json()).toEqual({ ok: true, applied: 1, skipped: 0 });
    });

    test("nothing before the link's start date", async () => {
        const ctx = setup();
        const token = seedLink(ctx, { sync_start_date: "2026-10-02" });
        ctx.days.set(`${USER}|2026-10-01`, offeredRow("2026-10-01"));
        const r = await ack(ctx, token, { entries: [initial("2026-10-01")] });
        expect(await r.json()).toEqual({ ok: true, applied: 0, skipped: 1 });
    });

    test("done frees only the lease this run holds", async () => {
        const ctx = setup({ meals });
        const token = seedLink(ctx);
        const a = (await (
            await ctx.req("/api/v1/health-sync/pending", { token })
        ).json()) as { lease_until: string };
        // Run A's lease lapses; run B takes a new one.
        ctx.setClock(NOW + 150_000);
        const b = (await (
            await ctx.req("/api/v1/health-sync/pending", { token })
        ).json()) as { lease_until: string };
        expect(b.lease_until).not.toBe(a.lease_until);
        // A's late done does not free B's lease...
        await ack(ctx, token, {
            entries: [],
            done: true,
            lease_until: a.lease_until,
        });
        expect(ctx.links.get(USER)!.row.lease_until).toBe(b.lease_until);
        // ...and neither does a done that names no lease.
        await ack(ctx, token, { entries: [], done: true });
        expect(ctx.links.get(USER)!.row.lease_until).toBe(b.lease_until);
        const busy = await ctx.req("/api/v1/health-sync/pending", { token });
        expect(busy.status).toBe(409);
        // B's own done does.
        await ack(ctx, token, {
            entries: [],
            done: true,
            lease_until: b.lease_until,
        });
        expect(ctx.links.get(USER)!.row.lease_until).toBeNull();
    });

    test("an ack landing between /pending's read and write is not undone", async () => {
        const ctx = setup({ meals });
        const token = seedLink(ctx);
        // Run A was offered Oct 2 and its lease lapsed before it acked.
        await ctx.req("/api/v1/health-sync/pending", { token });
        ctx.setClock(NOW + 150_000);
        // Run B reads the ledger; A's ack lands before B writes.
        const realGetDays = ctx.store.getDays.bind(ctx.store);
        let fired = false;
        ctx.store.getDays = async (u, f, t) => {
            const rows = await realGetDays(u, f, t);
            if (!fired) {
                fired = true;
                const r = await ack(ctx, token, {
                    entries: [
                        {
                            entry_id: "2026-10-02:i",
                            date: "2026-10-02",
                            values: { energy_kcal: 600, protein_g: 30 },
                        },
                    ],
                });
                expect(await r.json()).toMatchObject({ applied: 1 });
            }
            return rows;
        };
        const b = (await (
            await ctx.req("/api/v1/health-sync/pending", { token })
        ).json()) as { entries: unknown[] };
        // B does not offer the day again, and A's ack stands.
        expect(b.entries).toEqual([]);
        const day = ctx.days.get(`${USER}|2026-10-02`)!;
        expect(day.sent_values).toEqual({ energy_kcal: 600, protein_g: 30 });
        expect(day.offer_count).toBe(0);
    });

    test("an ack whose day moved on in between counts as skipped", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        ctx.days.set(`${USER}|2026-10-02`, offeredRow("2026-10-02"));
        const realGetDays = ctx.store.getDays.bind(ctx.store);
        ctx.store.getDays = async (u, f, t) => {
            const rows = await realGetDays(u, f, t);
            // Another run's ack of the same initial lands first.
            ctx.days.get(`${USER}|2026-10-02`)!.sent_values = {
                energy_kcal: 5,
            };
            return rows;
        };
        const r = await ack(ctx, token, { entries: [initial("2026-10-02")] });
        expect(await r.json()).toEqual({ ok: true, applied: 0, skipped: 1 });
        expect(ctx.days.get(`${USER}|2026-10-02`)!.sent_values).toEqual({
            energy_kcal: 5,
        });
        expect(ctx.calls).not.toContain("setLastSync");
    });
});

describe("GET /pending: stuck days", () => {
    const meals = [
        { logged_at: "2026-10-02T06:00:00Z", calories: 600 },
    ] as unknown as Partial<HealthSyncMeal>[];
    const pending = async (ctx: Ctx, token: string, query = "") =>
        (await (
            await ctx.req(`/api/v1/health-sync/pending${query}`, { token })
        ).json()) as {
            entries: { entry_id: string }[];
            notices: string[];
            lease_until: string;
        };

    test("a stuck day comes back on a run started by hand", async () => {
        const ctx = setup({ meals });
        const token = seedLink(ctx);
        // Three automation runs whose writes Health refused: nothing acked.
        let clock = NOW;
        for (let i = 0; i < 3; i++) {
            const p = await pending(ctx, token);
            expect(p.entries.map((e) => e.entry_id)).toEqual(["2026-10-02:i"]);
            clock += 150_000;
            ctx.setClock(clock);
        }
        const stuck = await pending(ctx, token);
        expect(stuck.entries).toEqual([]);
        expect(stuck.notices).toHaveLength(1);
        expect(stuck.notices[0]).toContain("Sharing → Apps → Shortcuts");
        clock += 150_000;
        ctx.setClock(clock);
        // Automations stay quiet about it.
        const auto = await pending(ctx, token);
        expect(auto.entries).toEqual([]);
        expect(auto.notices).toEqual([]);
        clock += 150_000;
        ctx.setClock(clock);
        // The user fixes the permission and runs Sync now.
        const manual = await pending(ctx, token, "?mode=manual");
        expect(manual.entries.map((e) => e.entry_id)).toEqual(["2026-10-02:i"]);
        const r = await ctx.req("/api/v1/health-sync/ack", {
            method: "POST",
            token,
            body: {
                entries: [
                    {
                        entry_id: "2026-10-02:i",
                        date: "2026-10-02",
                        values: { energy_kcal: 600 },
                    },
                ],
                done: true,
                lease_until: manual.lease_until,
            },
        });
        expect(await r.json()).toMatchObject({ applied: 1 });
        const day = ctx.days.get(`${USER}|2026-10-02`)!;
        expect(day.sent_values).toEqual({ energy_kcal: 600 });
        expect(day.offer_count).toBe(0);
        expect(day.notified).toEqual({});
    });
});

describe("unknown API paths", () => {
    test("a wrong method or path answers in the envelope", async () => {
        const ctx = setup();
        const wrong = await ctx.req("/api/v1/health-sync/ack");
        expect(wrong.status).toBe(405);
        expect(wrong.headers.get("allow")).toBe("POST");
        expect(wrong.headers.get("cache-control")).toBe("private, no-store");
        expect(await wrong.json()).toMatchObject({
            ok: false,
            error: "bad_request",
        });
        const typo = await ctx.req("/api/v1/health-sync/pendng");
        expect(typo.status).toBe(404);
        expect(await typo.json()).toMatchObject({
            ok: false,
            error: "bad_request",
            message: "Unknown endpoint.",
        });
        const root = await ctx.req("/api/v1/health-sync", { method: "POST" });
        expect(root.status).toBe(404);
        expect(lines()).toEqual([
            "[health-sync] route=unknown result=bad_request",
            "[health-sync] route=unknown result=bad_request",
            "[health-sync] route=unknown result=bad_request",
        ]);
    });

    test("the real routes still win", async () => {
        const ctx = setup();
        const r = await ctx.req("/api/v1/health-sync/pending");
        expect(r.status).toBe(401);
    });
});

describe("POST /revoke", () => {
    test("deletes the link and its sent record", async () => {
        const ctx = setup();
        const token = seedLink(ctx);
        ctx.days.set(`${USER}|2026-10-02`, {
            user_id: USER,
            date: "2026-10-02",
            timezone: KYIV,
            sent_values: { energy_kcal: 500 },
            topup_seq: 0,
            offer_count: 0,
            notified: {},
            first_sent_at: null,
            last_sent_at: null,
        });
        const r = await ctx.req("/api/v1/health-sync/revoke", {
            method: "POST",
            token,
        });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ ok: true });
        expect(ctx.links.size).toBe(0);
        expect(ctx.days.size).toBe(0);
        const after = await ctx.req("/api/v1/health-sync/pending", { token });
        expect(after.status).toBe(401);
    });
});

describe("logging", () => {
});

describe("activity shortcut", () => {
    const ACTIVITY_TOKEN = `nmhs_${"z".repeat(43)}`;

    function seedActivityLink(ctx: Ctx, token = ACTIVITY_TOKEN) {
        ctx.activityLinks.set(USER, {
            token,
            row: {
                id: "activity-link-1",
                user_id: USER,
                fallback_tz: null,
                created_at: "2026-09-25T10:00:00.000Z",
                last_used_at: null,
                last_sync_at: null,
                expires_at: "2026-12-25T10:00:00.000Z",
            },
        });
        return token;
    }

    test("each token works only on its own routes", async () => {
        const ctx = setup();
        const healthToken = seedLink(ctx);
        const activityToken = seedActivityLink(ctx);
        const body = {
            tz: KYIV,
            days: [{ date: "2026-10-03", active_kcal: 1 }],
        };

        const a = await ctx.req("/api/v1/health-sync/activity", {
            method: "POST",
            body,
            token: healthToken,
        });
        expect(a.status).toBe(401);
        const aj = (await a.json()) as { error: string; message: string };
        expect(aj.error).toBe("invalid_token");
        expect(aj.message).toContain(HEALTH_ACTIVITY_SHORTCUT_NAME);

        const p = await ctx.req("/api/v1/health-sync/pending", {
            token: activityToken,
        });
        expect(p.status).toBe(401);
        const ack = await ctx.req("/api/v1/health-sync/ack", {
            method: "POST",
            body: { entries: [], done: true },
            token: activityToken,
        });
        expect(ack.status).toBe(401);
        expect(ctx.writes).toHaveLength(0);
    });

    test("writes today and the days before as day totals, skipping 0", async () => {
        const ctx = setup({}, { creditPct: 50 });
        const token = seedActivityLink(ctx);
        // NOW is 15:00 on 2026-10-03 in Kyiv.
        const r = await ctx.req("/api/v1/health-sync/activity", {
            method: "POST",
            token,
            body: {
                tz: "Europe/Berlin",
                days: [
                    { date: "2026-10-03", active_kcal: 412.4 },
                    { date: "2026-10-02", active_kcal: "380" },
                    { date: "2026-10-01", active_kcal: 0 },
                ],
            },
        });
        expect(r.status).toBe(200);
        const b = (await r.json()) as Record<string, unknown>;
        expect(b).toMatchObject({
            ok: true,
            timezone: KYIV,
            timezone_source: "profile",
            written: 2,
            changed: 2,
            skipped: [{ date: "2026-10-01", reason: "zero" }],
            status: { through: "2026-10-03" },
        });
        expect(ctx.writes).toEqual([
            {
                userId: USER,
                days: [
                    {
                        date: "2026-10-02",
                        kcal: 380,
                        // Local noon in Kyiv (UTC+3).
                        logged_at: "2026-10-02T09:00:00.000Z",
                        credit_pct: 50,
                    },
                    {
                        date: "2026-10-03",
                        kcal: 412,
                        logged_at: "2026-10-03T09:00:00.000Z",
                        credit_pct: 50,
                    },
                ],
            },
        ]);
        const link = ctx.activityLinks.get(USER)!.row;
        expect(link.last_sync_at).toBe(new Date(NOW).toISOString());
        expect(link.fallback_tz).toBe("Europe/Berlin");
        expect(lines()).toContain(
            "[health-sync] route=activity result=ok entries=2",
        );
    });

    test("without a profile zone the phone's zone decides the dates", async () => {
        const ctx = setup({}, { tz: null });
        const token = seedActivityLink(ctx);
        const r = await ctx.req("/api/v1/health-sync/activity", {
            method: "POST",
            token,
            body: {
                tz: "America/Los_Angeles",
                days: [{ date: "2026-10-03", active_kcal: 100 }],
            },
        });
        const b = (await r.json()) as Record<string, unknown>;
        expect(b).toMatchObject({
            timezone: "America/Los_Angeles",
            timezone_source: "phone",
        });
        // 05:00 in Los Angeles: 2026-10-03 is today there.
        expect(ctx.writes[0]!.days[0]!.logged_at).toBe(
            "2026-10-03T19:00:00.000Z",
        );
    });

    test("future, too old and implausible days are skipped, not refused", async () => {
        const ctx = setup();
        const token = seedActivityLink(ctx);
        const r = await ctx.req("/api/v1/health-sync/activity", {
            method: "POST",
            token,
            body: {
                tz: KYIV,
                days: [
                    { date: "2026-10-04", active_kcal: 10 },
                    { date: "2026-09-26", active_kcal: 10 },
                    { date: "2026-09-27", active_kcal: 10 },
                    { date: "2026-10-03", active_kcal: 10001 },
                ],
            },
        });
        expect(r.status).toBe(200);
        const b = (await r.json()) as {
            skipped: unknown;
            written: number;
            status: unknown;
        };
        expect(b.written).toBe(1);
        expect(ctx.writes[0]!.days.map((d) => d.date)).toEqual(["2026-09-27"]);
        expect(b.skipped).toEqual([
            { date: "2026-09-26", reason: "outside_window" },
            { date: "2026-10-03", reason: "too_high" },
            { date: "2026-10-04", reason: "outside_window" },
        ]);
        expect(b.status).toEqual({ through: "2026-10-03" });
    });

    test("a malformed body is a 400 with a message the shortcut can show", async () => {
        const ctx = setup();
        const token = seedActivityLink(ctx);
        for (const body of [
            '{"tz":Europe/Kyiv}',
            { tz: KYIV },
            { tz: KYIV, days: [] },
            { tz: KYIV, days: [{ date: "02.10.2026", active_kcal: 1 }] },
            { tz: KYIV, days: [{ date: "2026-10-02", active_kcal: "1,234" }] },
            { tz: KYIV, days: [{ date: "2026-10-02", active_kcal: -1 }] },
            {
                tz: KYIV,
                days: Array.from({ length: 9 }, (_, i) => ({
                    date: `2026-10-0${(i % 3) + 1}`,
                    active_kcal: 1,
                })),
            },
        ]) {
            const r = await ctx.req("/api/v1/health-sync/activity", {
                method: "POST",
                token,
                body,
            });
            expect(r.status).toBe(400);
            const b = (await r.json()) as { ok: boolean; message: string };
            expect(b.ok).toBe(false);
            expect(b.message.length).toBeGreaterThan(10);
        }
        expect(ctx.writes).toHaveLength(0);
    });

    test("a write failure is unavailable with a ref", async () => {
        const ctx = setup();
        const token = seedActivityLink(ctx);
        ctx.activityFail.add("write");
        const r = await ctx.req("/api/v1/health-sync/activity", {
            method: "POST",
            token,
            body: { tz: KYIV, days: [{ date: "2026-10-03", active_kcal: 5 }] },
        });
        expect(r.status).toBe(503);
        const b = (await r.json()) as { error: string; ref: string };
        expect(b.error).toBe("unavailable");
        expect(b.ref).toMatch(/^[0-9a-f]{8}$/);
    });

    test("/revoke with the activity token removes only the activity link", async () => {
        const ctx = setup();
        const healthToken = seedLink(ctx);
        const activityToken = seedActivityLink(ctx);
        const r = await ctx.req("/api/v1/health-sync/revoke", {
            method: "POST",
            token: activityToken,
        });
        expect(r.status).toBe(200);
        expect(ctx.activityLinks.size).toBe(0);
        expect(ctx.links.get(USER)!.token).toBe(healthToken);

        const h = await ctx.req("/api/v1/health-sync/revoke", {
            method: "POST",
            token: healthToken,
        });
        expect(h.status).toBe(200);
        expect(ctx.links.size).toBe(0);
    });

    test("the wrong method on /activity is a 405 in the envelope", async () => {
        const ctx = setup();
        const r = await ctx.req("/api/v1/health-sync/activity");
        expect(r.status).toBe(405);
        expect(r.headers.get("allow")).toBe("POST");
    });
});
