import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
    OWNER_ID,
    createSqliteHealthSyncStore,
    getAllActiveCalories,
    insertActiveCalories,
    insertMeal,
    insertWater,
    upsertProfile,
    type HealthSyncStore,
} from "./db/repo.js";
import { useMemoryDb } from "./db/test-helpers.js";
import { createApp } from "./index.js";
import { _resetBuckets, getBanState } from "./rate-limit.js";
import { repoHealthSyncData } from "./health-sync-status.js";

useMemoryDb();

const KEY = "shortcut-".padEnd(60, "Q7r");
const MCP_KEY = "mcp-".padEnd(60, "W3x");
const IP = "198.51.100.7";
const API = "/api/v1/health-sync";
// 10:00 in Kyiv on Oct 3 2026 (EEST, UTC+3).
const T0 = Date.parse("2026-10-03T07:00:00Z");

let clock = T0;
let store: HealthSyncStore;
let app: ReturnType<typeof createApp>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
const trustBefore = process.env.TRUST_PROXY;

beforeEach(async () => {
    _resetBuckets();
    delete process.env.TRUST_PROXY;
    clock = T0;
    store = createSqliteHealthSyncStore();
    app = makeApp();
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    await upsertProfile(OWNER_ID, { timezone: "Europe/Kyiv" });
});
afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    if (trustBefore === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trustBefore;
});

function makeApp(
    healthSync: Parameters<typeof createApp>[0]["healthSync"] = {},
) {
    return createApp({
        mcpKey: () => MCP_KEY,
        shortcutKey: () => KEY,
        exportSecret: () => "e".repeat(40),
        healthSync: { now: () => clock, ...healthSync },
    });
}

interface Opts {
    key?: string | null;
    scheme?: string;
    body?: unknown;
    ip?: string;
    headers?: Record<string, string>;
}
function call(method: string, path: string, o: Opts = {}) {
    const headers: Record<string, string> = { ...o.headers };
    const key = o.key === undefined ? KEY : o.key;
    if (key !== null) headers.authorization = `${o.scheme ?? "Bearer"} ${key}`;
    let body: string | undefined;
    if (o.body !== undefined) {
        headers["content-type"] = "application/json";
        body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    }
    return app.request(
        `http://x${path}`,
        { method, headers, body },
        { ip: o.ip ?? IP },
    );
}
const get = (path: string, o?: Opts) => call("GET", path, o);
const post = (path: string, body?: unknown, o: Opts = {}) =>
    call("POST", path, { ...o, body: body ?? {} });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

/** Logs a meal at a UTC instant (Kyiv is +3 in early October). */
const eat = (iso: string, calories: number, extra: object = {}) =>
    insertMeal(OWNER_ID, {
        description: "synthetic meal",
        meal_type: "lunch",
        calories,
        logged_at: iso,
        ...extra,
    });

/** What the Shortcut does: pending, then ack every entry exactly as offered. */
async function syncOnce(o: Opts = {}) {
    const p = await json(await get(`${API}/pending`, o));
    expect(p.ok).toBe(true);
    if (p.count > 0) {
        const a = await json(
            await post(
                `${API}/ack`,
                {
                    entries: p.entries.map((e: any) => ({
                        entry_id: e.entry_id,
                        date: e.date,
                        values: e.values,
                    })),
                    done: true,
                    lease_until: p.lease_until,
                },
                o,
            ),
        );
        expect(a.ok).toBe(true);
        return { p, a };
    }
    return { p, a: null };
}

describe("authentication", () => {
    const routes: [string, string][] = [
        ["GET", `${API}/pending`],
        ["POST", `${API}/ack`],
        ["POST", `${API}/activity`],
        ["GET", `${API}/status`],
        ["POST", `${API}/revoke`],
        ["GET", `${API}/nope`],
    ];

    test.each(routes)(
        "%s %s without a key is a 401 in the envelope",
        async (m, p) => {
            const r = await call(m, p, { key: null });
            expect(r.status).toBe(401);
            expect(r.headers.get("www-authenticate")).toContain("Bearer");
            expect(r.headers.get("cache-control")).toContain("no-store");
            expect(await json(r)).toMatchObject({
                ok: false,
                error: "unauthorized",
            });
        },
    );

    test("wrong key, wrong length, wrong scheme, extra words, the MCP key and an empty token all look identical", async () => {
        const variants: Opts[] = [
            { key: "wrong-" + KEY },
            { key: KEY.slice(0, -1) },
            { key: KEY + "x" },
            { key: KEY, scheme: "Basic" },
            { key: `${KEY} extra` },
            { key: MCP_KEY },
            { key: "" },
            { key: null, headers: { authorization: "Bearer" } },
            { key: null, headers: { authorization: KEY } },
        ];
        const shapes = [];
        for (const v of variants) {
            const r = await get(`${API}/pending`, v);
            expect(r.status).toBe(401);
            shapes.push({ status: r.status, body: await r.text() });
        }
        expect(new Set(shapes.map((s) => s.body)).size).toBe(1);
    });

    test("the key is accepted ONLY as a bearer header, never in the URL or body", async () => {
        const inQuery = await get(`${API}/pending?key=${KEY}`, { key: null });
        expect(inQuery.status).toBe(401);
        const inBody = await post(
            `${API}/ack`,
            { key: KEY, done: true },
            { key: null },
        );
        expect(inBody.status).toBe(401);
        const asApiKeyHeader = await get(`${API}/pending`, {
            key: null,
            headers: { "x-api-key": KEY },
        });
        expect(asApiKeyHeader.status).toBe(401);
    });

    test("with the right key, a wrong method or an unknown path answers in the envelope", async () => {
        const wrongMethod = await post(`${API}/pending`);
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.headers.get("allow")).toBe("GET");
        expect(await json(wrongMethod)).toMatchObject({ ok: false });
        const unknown = await get(`${API}/nope`);
        expect(unknown.status).toBe(404);
        expect(await json(unknown)).toMatchObject({
            ok: false,
            message: "Unknown endpoint.",
        });
    });

    test("20 consecutive failures ban the address (429, Retry-After), even for the right key; others are fine", async () => {
        for (let i = 0; i < 20; i++) {
            expect(
                (await get(`${API}/pending`, { key: `bad${i}` })).status,
            ).toBe(401);
        }
        expect(getBanState(IP).banned).toBe(true);
        const shed = await get(`${API}/pending`);
        expect(shed.status).toBe(429);
        expect(Number(shed.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(await json(shed)).toMatchObject({
            ok: false,
            error: "rate_limited",
        });
        expect(
            (await get(`${API}/pending`, { ip: "203.0.113.9" })).status,
        ).toBe(200);
    });

    test("failures here and at the MCP path count together (one ban per address)", async () => {
        for (let i = 0; i < 10; i++)
            await get(`${API}/pending`, { key: `bad${i}` });
        for (let i = 0; i < 10; i++) {
            await app.request(
                `http://x/mcp/bad${i}`,
                { method: "POST" },
                { ip: IP },
            );
        }
        expect(getBanState(IP).banned).toBe(true);
    });

    test("a success clears the run of failures", async () => {
        for (let i = 0; i < 15; i++)
            await get(`${API}/pending`, { key: `bad${i}` });
        expect((await get(`${API}/pending`)).status).toBe(200);
        for (let i = 0; i < 15; i++)
            await get(`${API}/pending`, { key: `again${i}` });
        expect(getBanState(IP).banned).toBe(false);
    });

    test("a runaway shortcut is held to the per-owner request budget", async () => {
        let limited = 0;
        for (let i = 0; i < 60; i++) {
            const r = await get(`${API}/status`);
            if (r.status === 429) {
                limited++;
                expect(r.headers.get("retry-after")).toBeTruthy();
                expect(await json(r)).toMatchObject({ error: "rate_limited" });
            }
        }
        expect(limited).toBeGreaterThan(0);
    });

    test("the key never appears in a log line or a response, successful or not", async () => {
        await eat("2026-10-03T06:00:00Z", 500);
        const seen: string[] = [];
        const bodies: string[] = [];
        for (const r of [
            await get(`${API}/pending`),
            await get(`${API}/pending`, { key: "wrong-" + KEY }),
            await post(`${API}/ack`, { entries: [], done: true }),
            await post(`${API}/ack`, "{not json"),
            await get(`${API}/status`),
        ]) {
            bodies.push(await r.text());
            for (const [, v] of r.headers) seen.push(v);
        }
        const logs = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((c) =>
            c.map(String).join(" "),
        );
        for (const text of [...seen, ...bodies, ...logs])
            expect(text).not.toContain(KEY);
        expect(
            logs.some((l) =>
                l.startsWith("[health-sync] route=pending result=ok"),
            ),
        ).toBe(true);
        expect(
            logs.some((l) =>
                l.startsWith("[req] GET /api/v1/health-sync/pending 200"),
            ),
        ).toBe(true);
    });
});

describe("GET /pending", () => {
    test("nothing logged: ok, no entries, and no lease is left held", async () => {
        const r = await json(await get(`${API}/pending`));
        expect(r).toMatchObject({
            ok: true,
            version: 2,
            timezone: "Europe/Kyiv",
            timezone_source: "profile",
            window: { from: "2026-09-27", to: "2026-10-03" },
            lease_until: null,
            count: 0,
            entries: [],
            discrepancies: [],
            notices: [],
        });
        expect(r.now).toBe("2026-10-03T10:00:00+03:00");
        expect((await store.getState(OWNER_ID)).lease_until).toBeNull();
        expect((await store.getState(OWNER_ID)).last_sync_at).toBe(
            new Date(T0).toISOString(),
        );
    });

    test("offers today's totals as one entry with the lease and a sample time", async () => {
        await eat("2026-10-03T05:00:00Z", 450, {
            protein_g: 20,
            caffeine_mg: 95,
        });
        await eat("2026-10-03T06:00:00Z", 300, { protein_g: 10 });
        const r = await json(await get(`${API}/pending`));
        expect(r.count).toBe(1);
        expect(r.entries[0]).toEqual({
            entry_id: "2026-10-03:r1",
            date: "2026-10-03",
            closed: false,
            sample_at: "2026-10-03T10:00:00+03:00",
            values: { energy_kcal: 750, protein_g: 30, caffeine_mg: 95 },
        });
        expect(r.lease_until).toBe(new Date(T0 + 120_000).toISOString());
    });

    test("the profile's timezone decides the day; the phone's ?tz only stands in when none is set", async () => {
        // 22:30Z Oct 2 = 01:30 Oct 3 in Kyiv, but still Oct 2 in New York.
        await eat("2026-10-02T22:30:00Z", 400);
        const kyiv = await json(
            await get(`${API}/pending?tz=America/New_York`),
        );
        expect(kyiv.timezone).toBe("Europe/Kyiv");
        expect(kyiv.entries[0].date).toBe("2026-10-03");
        await store.releaseLease(OWNER_ID);
        // No profile timezone: the phone's is used, and nothing is written to the profile.
        await upsertProfile(OWNER_ID, { timezone: null as never });
        const { getProfile } = await import("./db/repo.js");
        const ny = await json(await get(`${API}/pending?tz=America/New_York`));
        expect(ny.timezone).toBe("America/New_York");
        expect(ny.timezone_source).toBe("phone");
        expect((await getProfile(OWNER_ID))!.timezone).toBeNull();
        await store.releaseLease(OWNER_ID);
        const utc = await json(await get(`${API}/pending?tz=Not/AZone`));
        expect(utc.timezone).toBe("UTC");
    });

    test("water is offered only when the run asks for it", async () => {
        await eat("2026-10-03T05:00:00Z", 400);
        await insertWater(OWNER_ID, {
            amount_ml: 750,
            logged_at: "2026-10-03T05:30:00Z",
        });
        const off = await json(await get(`${API}/pending`));
        expect(off.entries[0].values).toEqual({ energy_kcal: 400 });
        await store.releaseLease(OWNER_ID);
        const on = await json(await get(`${API}/pending?water=1`));
        expect(on.entries[0].values).toEqual({
            energy_kcal: 400,
            water_ml: 750,
        });
        await store.releaseLease(OWNER_ID);
        const alias = await json(
            await get(`${API}/pending?include_water=true`),
        );
        expect(alias.entries[0].values.water_ml).toBe(750);
    });

    test("an overlapping run is told it is busy and offered nothing; it can run once the lease is freed or lapses", async () => {
        await eat("2026-10-03T05:00:00Z", 400);
        const first = await json(await get(`${API}/pending`));
        expect(first.count).toBe(1);
        const second = await get(`${API}/pending`);
        expect(second.status).toBe(409);
        expect(await json(second)).toMatchObject({ ok: false, error: "busy" });
        // lapsed
        clock = T0 + 121_000;
        const third = await json(await get(`${API}/pending`));
        expect(third.count).toBe(1);
        expect(third.lease_until).toBe(new Date(clock + 120_000).toISOString());
    });

    test("an empty run does not take the lease from a real one", async () => {
        const empty = await json(await get(`${API}/pending`));
        expect(empty.count).toBe(0);
        await eat("2026-10-03T05:00:00Z", 400);
        expect((await json(await get(`${API}/pending`))).count).toBe(1);
    });

    test("reports a discrepancy instead of writing a negative", async () => {
        const meal = await eat("2026-10-03T05:00:00Z", 800);
        await syncOnce();
        const { deleteMeal } = await import("./db/repo.js");
        await deleteMeal(OWNER_ID, meal.meal.id);
        await eat("2026-10-03T05:30:00Z", 500);
        const r = await json(await get(`${API}/pending`));
        expect(r.count).toBe(0);
        expect(r.discrepancies).toEqual([
            {
                date: "2026-10-03",
                field: "energy_kcal",
                sent: 800,
                current: 500,
                difference: -300,
            },
        ]);
    });

    test("fails closed when a read fails: 503, nothing offered, lease handed back", async () => {
        await eat("2026-10-03T05:00:00Z", 400);
        const broken = makeApp({
            now: () => clock,
            data: {
                ...repoHealthSyncData,
                getMeals: async () => {
                    throw new Error("disk I/O error");
                },
            },
        });
        const r = await broken.request(
            `http://x${API}/pending`,
            { headers: { authorization: `Bearer ${KEY}` } },
            { ip: IP },
        );
        expect(r.status).toBe(503);
        const body = (await r.json()) as Record<string, any>;
        expect(body).toMatchObject({ ok: false, error: "unavailable" });
        expect(body.message).not.toContain("disk I/O");
        expect((await store.getState(OWNER_ID)).lease_until).toBeNull();
        // the raw text is in the log under the same ref, not in the response
        const logs = warnSpy.mock.calls
            .map((c: unknown[]) => c.map(String).join(" "))
            .join("\n");
        expect(logs).toContain(`ref=${body.ref}`);
        expect(logs).toContain("disk I/O error");
    });

    test("old ledger days are swept past the retention", async () => {
        await store.commitDay(
            OWNER_ID,
            0,
            {
                date: "2026-09-20",
                timezone: "Europe/Kyiv",
                rounds: 1,
                sent: { energy_kcal: 5 },
                first_sent_at: null,
                last_sent_at: null,
            },
            new Date(T0).toISOString(),
        );
        await get(`${API}/pending`);
        expect(
            await store.getDays(OWNER_ID, "2026-01-01", "2026-12-31"),
        ).toEqual([]);
    });
});

describe("POST /ack", () => {
    test("applies the offered entry; sent-so-far moves and last_ack_at is stamped", async () => {
        await eat("2026-10-03T05:00:00Z", 450, { protein_g: 20 });
        const { a } = await syncOnce();
        expect(a).toMatchObject({
            ok: true,
            applied: 1,
            skipped: 0,
            results: [{ entry_id: "2026-10-03:r1", status: "applied" }],
        });
        const [day] = await store.getDays(OWNER_ID, "2026-10-03", "2026-10-03");
        expect(day).toMatchObject({
            rounds: 1,
            timezone: "Europe/Kyiv",
            sent: { energy_kcal: 450, protein_g: 20 },
        });
        expect((await store.getState(OWNER_ID)).last_ack_at).toBe(
            new Date(T0).toISOString(),
        );
        expect((await store.getState(OWNER_ID)).lease_until).toBeNull();
    });

    test("a replayed ack is idempotent: skipped, ledger unchanged", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        const p = await json(await get(`${API}/pending`));
        const body = {
            entries: [
                {
                    entry_id: "2026-10-03:r1",
                    date: "2026-10-03",
                    values: p.entries[0].values,
                },
            ],
            done: false,
        };
        expect((await json(await post(`${API}/ack`, body))).applied).toBe(1);
        const again = await json(await post(`${API}/ack`, body));
        expect(again).toMatchObject({
            applied: 0,
            skipped: 1,
            results: [{ status: "skipped" }],
        });
        const [day] = await store.getDays(OWNER_ID, "2026-10-03", "2026-10-03");
        expect(day!.sent.energy_kcal).toBe(450);
        expect(day!.rounds).toBe(1);
    });

    test("two overlapping identical acks count exactly once", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        const p = await json(await get(`${API}/pending`));
        const body = {
            entries: [
                {
                    entry_id: "2026-10-03:r1",
                    date: "2026-10-03",
                    values: p.entries[0].values,
                },
            ],
        };
        const [a, b] = await Promise.all([
            post(`${API}/ack`, body),
            post(`${API}/ack`, body),
        ]);
        const applied = [(await json(a)).applied, (await json(b)).applied];
        expect(applied.sort()).toEqual([0, 1]);
        const [day] = await store.getDays(OWNER_ID, "2026-10-03", "2026-10-03");
        expect(day!.sent.energy_kcal).toBe(450);
    });

    test("r1 and r2 for one day in one batch both apply, in order", async () => {
        const r = await json(
            await post(`${API}/ack`, {
                entries: [
                    {
                        entry_id: "2026-10-03:r1",
                        date: "2026-10-03",
                        values: { energy_kcal: 100 },
                    },
                    {
                        entry_id: "2026-10-03:r2",
                        date: "2026-10-03",
                        values: { energy_kcal: 50 },
                    },
                    {
                        entry_id: "2026-10-03:r4",
                        date: "2026-10-03",
                        values: { energy_kcal: 9 },
                    },
                ],
            }),
        );
        expect(r.results.map((x: any) => x.status)).toEqual([
            "applied",
            "applied",
            "skipped",
        ]);
        const [day] = await store.getDays(OWNER_ID, "2026-10-03", "2026-10-03");
        expect(day).toMatchObject({ rounds: 2, sent: { energy_kcal: 150 } });
    });

    test("dates outside the window (future, long gone) are skipped and write nothing", async () => {
        const r = await json(
            await post(`${API}/ack`, {
                entries: [
                    {
                        entry_id: "2026-10-04:r1",
                        date: "2026-10-04",
                        values: { energy_kcal: 100 },
                    },
                    {
                        entry_id: "2026-09-01:r1",
                        date: "2026-09-01",
                        values: { energy_kcal: 100 },
                    },
                    {
                        entry_id: "2026-09-26:r1",
                        date: "2026-09-26",
                        values: { energy_kcal: 100 },
                    },
                ],
            }),
        );
        // Sep 26 is the one extra day an ack may reach back to.
        expect(r.results.map((x: any) => x.status)).toEqual([
            "skipped",
            "skipped",
            "applied",
        ]);
        expect(
            await store.getDays(OWNER_ID, "2026-01-01", "2026-12-31"),
        ).toHaveLength(1);
    });

    test("a partial echo (the phone logged fewer fields) only moves those; the rest is offered again", async () => {
        await eat("2026-10-03T05:00:00Z", 450, { protein_g: 20 });
        const p = await json(await get(`${API}/pending`));
        await post(`${API}/ack`, {
            entries: [
                {
                    entry_id: p.entries[0].entry_id,
                    date: "2026-10-03",
                    values: { energy_kcal: 450 },
                },
            ],
            done: true,
            lease_until: p.lease_until,
        });
        const next = await json(await get(`${API}/pending`));
        expect(next.entries[0]).toMatchObject({
            entry_id: "2026-10-03:r2",
            values: { protein_g: 20 },
        });
    });

    test("done:true frees the lease only when it is still the caller's", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        const first = await json(await get(`${API}/pending`));
        // Its lease lapses and a newer run takes over.
        clock = T0 + 130_000;
        const second = await json(await get(`${API}/pending`));
        expect(second.lease_until).not.toBe(first.lease_until);
        // A late ack from the first run must not free the second run's lease.
        await post(`${API}/ack`, {
            done: true,
            lease_until: first.lease_until,
        });
        expect((await get(`${API}/pending`)).status).toBe(409);
        await post(`${API}/ack`, {
            done: true,
            lease_until: second.lease_until,
        });
        expect((await store.getState(OWNER_ID)).lease_until).toBeNull();
    });

    test.each([
        ["not JSON", "{nope", /must be JSON/],
        ["not an object", "[]", /JSON object/],
        [
            "unknown field",
            {
                entries: [
                    {
                        entry_id: "2026-10-03:r1",
                        date: "2026-10-03",
                        values: { sugar_g: 3 },
                    },
                ],
            },
            /not a field/,
        ],
        [
            "over the cap",
            {
                entries: [
                    {
                        entry_id: "2026-10-03:r1",
                        date: "2026-10-03",
                        values: { energy_kcal: 60000 },
                    },
                ],
            },
            /0 to 50000/,
        ],
        [
            "old entry id shape",
            {
                entries: [
                    {
                        entry_id: "2026-10-03:i",
                        date: "2026-10-03",
                        values: { energy_kcal: 5 },
                    },
                ],
            },
            /entry_id/,
        ],
    ])("refuses a malformed body: %s", async (_n, body, message) => {
        const r = await post(`${API}/ack`, body);
        expect(r.status).toBe(400);
        const j = await json(r);
        expect(j).toMatchObject({ ok: false, error: "bad_request" });
        expect(j.message).toMatch(message);
        expect(
            await store.getDays(OWNER_ID, "2026-01-01", "2026-12-31"),
        ).toEqual([]);
    });
});

describe("only the new delta flows, hour after hour", () => {
    test("pending → ack → pending is empty → more food → only the delta", async () => {
        await eat("2026-10-03T05:00:00Z", 450, { protein_g: 20 });
        const first = await syncOnce();
        expect(first.p.entries[0].values).toEqual({
            energy_kcal: 450,
            protein_g: 20,
        });
        expect((await json(await get(`${API}/pending`))).count).toBe(0);

        clock = T0 + 3_600_000;
        await eat("2026-10-03T07:30:00Z", 600, { protein_g: 35 });
        const second = await syncOnce();
        expect(second.p.entries).toHaveLength(1);
        expect(second.p.entries[0]).toMatchObject({
            entry_id: "2026-10-03:r2",
            values: { energy_kcal: 600, protein_g: 35 },
        });
        expect((await json(await get(`${API}/pending`))).count).toBe(0);
        const [day] = await store.getDays(OWNER_ID, "2026-10-03", "2026-10-03");
        expect(day).toMatchObject({
            rounds: 2,
            sent: { energy_kcal: 1050, protein_g: 55 },
        });
    });

    test("food logged below the threshold waits until it adds up", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        await syncOnce();
        clock += 3_600_000;
        await eat("2026-10-03T06:30:00Z", 12);
        expect((await json(await get(`${API}/pending`))).count).toBe(0);
        await eat("2026-10-03T06:45:00Z", 10);
        const r = await json(await get(`${API}/pending`));
        expect(r.entries[0].values).toEqual({ energy_kcal: 22 });
    });

    test("yesterday's late entry is picked up as a final top-up once its day has closed", async () => {
        await eat("2026-10-02T10:00:00Z", 1800);
        const day1 = await syncOnce();
        expect(day1.p.entries[0]).toMatchObject({
            date: "2026-10-02",
            closed: true,
        });
        await eat("2026-10-02T12:00:00Z", 8); // forgotten snack, logged later
        const r = await json(await get(`${API}/pending`));
        expect(r.entries[0]).toMatchObject({
            entry_id: "2026-10-02:r2",
            closed: true,
            sample_at: "2026-10-02T23:59:00+03:00",
            values: { energy_kcal: 8 },
        });
    });

    test("the 05:00 boundary: the same small delta is held at 04:59:59 and sent at 05:00:00", async () => {
        clock = Date.parse("2026-10-03T01:59:59Z"); // 04:59:59 Kyiv, Oct 2 still open
        await eat("2026-10-02T10:00:00Z", 1800);
        await syncOnce();
        await eat("2026-10-02T12:00:00Z", 8);
        expect((await json(await get(`${API}/pending`))).count).toBe(0);
        clock = Date.parse("2026-10-03T02:00:00Z");
        const r = await json(await get(`${API}/pending`));
        expect(r.count).toBe(1);
        expect(r.entries[0].closed).toBe(true);
    });

    test("DST fall-back (Kyiv, Oct 25): days bucket and close by local time", async () => {
        // 03:00Z Oct 25 = 05:00 EET: Oct 24 just closed. Food at 22:30Z Oct 24 is 00:30 Oct 25 EET.
        clock = Date.parse("2026-10-25T09:00:00Z");
        await eat("2026-10-24T20:30:00Z", 700); // 23:30 EEST Oct 24
        await eat("2026-10-24T22:30:00Z", 300); // 00:30 EET Oct 25
        const r = await json(await get(`${API}/pending`));
        const byDate = Object.fromEntries(
            r.entries.map((e: any) => [e.date, e]),
        );
        expect(byDate["2026-10-24"].values.energy_kcal).toBe(700);
        expect(byDate["2026-10-24"].sample_at).toBe(
            "2026-10-24T23:59:00+03:00",
        );
        expect(byDate["2026-10-25"].values.energy_kcal).toBe(300);
        expect(byDate["2026-10-25"].sample_at).toBe(
            "2026-10-25T11:00:00+02:00",
        );
        expect(r.window).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    });

    test("DST spring-forward (New York, Mar 8 2026): the 23-hour day buckets correctly", async () => {
        await upsertProfile(OWNER_ID, { timezone: "America/New_York" });
        clock = Date.parse("2026-03-09T16:00:00Z"); // 12:00 EDT Mar 9
        await eat("2026-03-08T04:30:00Z", 200); // 23:30 EST Mar 7
        await eat("2026-03-08T05:30:00Z", 300); // 00:30 EST Mar 8
        await eat("2026-03-09T03:30:00Z", 400); // 23:30 EDT Mar 8 (the short day)
        const r = await json(await get(`${API}/pending`));
        const v = Object.fromEntries(
            r.entries.map((e: any) => [e.date, e.values.energy_kcal]),
        );
        expect(v).toEqual({ "2026-03-07": 200, "2026-03-08": 700 });
    });

    test("after local midnight the new day is today and yesterday is a closed-or-open day by the clock", async () => {
        clock = Date.parse("2026-10-03T21:10:00Z"); // 00:10 Oct 4 Kyiv: Oct 3 is NOT closed yet
        await eat("2026-10-03T18:00:00Z", 500);
        const r = await json(await get(`${API}/pending`));
        expect(r.entries[0]).toMatchObject({
            date: "2026-10-03",
            closed: false,
            sample_at: "2026-10-03T23:59:00+03:00",
        });
        expect(r.window.to).toBe("2026-10-04");
    });
});

describe("POST /activity", () => {
    const send = (days: unknown, extra: object = {}) =>
        post(`${API}/activity`, { days, ...extra });

    test("writes the day totals, reports what changed, and stamps the activity clock", async () => {
        const r = await json(
            await send([
                { date: "2026-10-03", active_kcal: 512.4 },
                { date: "2026-10-02", active_kcal: "640" },
            ]),
        );
        expect(r).toMatchObject({
            ok: true,
            version: 1,
            timezone: "Europe/Kyiv",
            written: 2,
            changed: 2,
            skipped: [],
            status: { through: "2026-10-03" },
        });
        const rows = await getAllActiveCalories(OWNER_ID);
        expect(rows.map((x) => [x.source_date, x.kcal, x.source])).toEqual([
            ["2026-10-02", 640, "apple_health"],
            ["2026-10-03", 512, "apple_health"],
        ]);
        expect((await store.getState(OWNER_ID)).last_activity_at).toBe(
            new Date(T0).toISOString(),
        );
    });

    test("REPLACES a day's total on every sync, never adds; an unchanged resend changes nothing", async () => {
        await send([{ date: "2026-10-03", active_kcal: 300 }]);
        const grown = await json(
            await send([{ date: "2026-10-03", active_kcal: 450 }]),
        );
        expect(grown.changed).toBe(1);
        expect(
            (await getAllActiveCalories(OWNER_ID)).map((x) => x.kcal),
        ).toEqual([450]);
        const same = await json(
            await send([{ date: "2026-10-03", active_kcal: 450 }]),
        );
        expect(same).toMatchObject({ written: 1, changed: 0 });
        expect(await getAllActiveCalories(OWNER_ID)).toHaveLength(1);
    });

    test("manual entries are preserved beside the synced total", async () => {
        await insertActiveCalories(OWNER_ID, {
            kcal: 200,
            credit_pct: 100,
            logged_at: "2026-10-03T08:00:00.000Z",
        });
        await send([{ date: "2026-10-03", active_kcal: 600 }]);
        await send([{ date: "2026-10-03", active_kcal: 650 }]);
        const rows = await getAllActiveCalories(OWNER_ID);
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.source === null)!.kcal).toBe(200);
        expect(rows.find((r) => r.source === "apple_health")!.kcal).toBe(650);
    });

    test("only today and the six days before; a zero writes nothing; too-high skipped", async () => {
        const r = await json(
            await send([
                { date: "2026-10-04", active_kcal: 100 },
                { date: "2026-09-26", active_kcal: 100 },
                { date: "2026-09-27", active_kcal: 100 },
                { date: "2026-10-01", active_kcal: 0 },
                { date: "2026-10-02", active_kcal: 99999 },
            ]),
        );
        expect(r.written).toBe(1);
        expect(r.skipped).toEqual([
            { date: "2026-09-26", reason: "outside_window" },
            { date: "2026-10-01", reason: "zero" },
            { date: "2026-10-02", reason: "too_high" },
            { date: "2026-10-04", reason: "outside_window" },
        ]);
        expect(
            (await getAllActiveCalories(OWNER_ID)).map((x) => x.source_date),
        ).toEqual(["2026-09-27"]);
    });

    test("a day sent twice keeps its last value; the credit snapshot of an existing day is kept", async () => {
        await upsertProfile(OWNER_ID, { activity_credit_pct: 60 });
        await send([
            { date: "2026-10-03", active_kcal: 100 },
            { date: "2026-10-03", active_kcal: 120 },
        ]);
        await upsertProfile(OWNER_ID, { activity_credit_pct: 100 });
        await send([{ date: "2026-10-03", active_kcal: 140 }]);
        const [row] = await getAllActiveCalories(OWNER_ID);
        expect(row).toMatchObject({ kcal: 140, credit_pct: 60 });
    });

    test.each([
        ["no days", {}, /days must be a list/],
        ["empty days", { days: [] }, /days must be a list/],
        [
            "bad date",
            { days: [{ date: "03/10/2026", active_kcal: 5 }] },
            /YYYY-MM-DD/,
        ],
        [
            "negative",
            { days: [{ date: "2026-10-03", active_kcal: -5 }] },
            /0 or more/,
        ],
        [
            "not a number",
            { days: [{ date: "2026-10-03", active_kcal: "lots" }] },
            /number of kilocalories/,
        ],
        [
            "too many",
            {
                days: Array.from({ length: 9 }, (_, i) => ({
                    date: `2026-10-0${i + 1}`,
                    active_kcal: 1,
                })),
            },
            /at most 8/,
        ],
    ])("refuses a malformed body: %s", async (_n, body, message) => {
        const r = await post(`${API}/activity`, body);
        expect(r.status).toBe(400);
        expect((await json(r)).message).toMatch(message);
        expect(await getAllActiveCalories(OWNER_ID)).toEqual([]);
    });

    test("does not touch the nutrition ledger", async () => {
        await send([{ date: "2026-10-03", active_kcal: 300 }]);
        expect(
            await store.getDays(OWNER_ID, "2026-01-01", "2026-12-31"),
        ).toEqual([]);
    });
});

describe("GET /status and POST /revoke", () => {
    test("status carries the clocks and the per-day sent / logged / pending view", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        await syncOnce();
        await eat("2026-10-03T06:00:00Z", 100);
        await post(`${API}/activity`, {
            days: [{ date: "2026-10-03", active_kcal: 250 }],
        });
        const s = await json(await get(`${API}/status`));
        expect(s).toMatchObject({
            ok: true,
            timezone: "Europe/Kyiv",
            last_sync_at: new Date(T0).toISOString(),
            last_ack_at: new Date(T0).toISOString(),
            last_activity_at: new Date(T0).toISOString(),
            pending_entries: 1,
            discrepancies: [],
        });
        expect(s.days).toHaveLength(7);
        expect(s.days.at(-1)).toMatchObject({
            date: "2026-10-03",
            sent: { energy_kcal: 450 },
            logged: { energy_kcal: 550 },
            pending: { energy_kcal: 100 },
            rounds: 1,
        });
        // status never takes the lease
        expect((await store.getState(OWNER_ID)).lease_until).toBeNull();
    });

    test("status shows discrepancies and includes water once water has been sent", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        await insertWater(OWNER_ID, {
            amount_ml: 500,
            logged_at: "2026-10-03T05:10:00Z",
        });
        await syncOnce({ headers: {} }).catch(() => {});
        await store.releaseLease(OWNER_ID);
        const p = await json(await get(`${API}/pending?water=1`));
        await post(`${API}/ack`, {
            entries: p.entries.map((e: any) => ({
                entry_id: e.entry_id,
                date: e.date,
                values: e.values,
            })),
            done: true,
            lease_until: p.lease_until,
        });
        const { getAllWater, deleteWater } = await import("./db/repo.js");
        for (const w of await getAllWater(OWNER_ID))
            await deleteWater(OWNER_ID, w.id);
        const s = await json(await get(`${API}/status`));
        expect(s.discrepancies.map((d: any) => d.field)).toContain("water_ml");
    });

    test("revoke needs an explicit confirm, then forgets the ledger and the clocks", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        await syncOnce();
        const refused = await post(`${API}/revoke`, {});
        expect(refused.status).toBe(400);
        expect(
            (await store.getDays(OWNER_ID, "2026-01-01", "2026-12-31")).length,
        ).toBe(1);
        expect(
            (await json(await post(`${API}/revoke`, { confirm: true }))).ok,
        ).toBe(true);
        expect(
            await store.getDays(OWNER_ID, "2026-01-01", "2026-12-31"),
        ).toEqual([]);
        expect((await store.getState(OWNER_ID)).last_ack_at).toBeNull();
        // the whole day is offered again from zero, as documented
        expect(
            (await json(await get(`${API}/pending`))).entries[0].entry_id,
        ).toBe("2026-10-03:r1");
    });
});

describe("the health-sync lines in the log", () => {
    test("one line per call: route, result, counts; no secrets, no values", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        await get(`${API}/pending`);
        await get(`${API}/pending`); // busy
        await post(`${API}/ack`, "{bad");
        const lines = [...logSpy.mock.calls, ...warnSpy.mock.calls]
            .map((c) => c.map(String).join(" "))
            .filter((l: string) => l.startsWith("[health-sync]"));
        expect(lines).toEqual([
            "[health-sync] route=pending result=ok entries=1 notices=0 discrepancies=0",
            "[health-sync] route=pending result=busy",
            "[health-sync] route=ack result=bad_request",
        ]);
        await get(`${API}/pending`, { key: "nope" });
        const denied = [...warnSpy.mock.calls]
            .map((c: unknown[]) => c.map(String).join(" "))
            .filter((l: string) => l.includes("unauthorized"));
        expect(denied).toEqual([
            "[health-sync] route=pending result=unauthorized",
        ]);
    });
});
