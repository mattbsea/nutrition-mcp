/**
 * End to end, over real HTTP, as the iPhone Shortcut behaves: a fake "Apple
 * Health" holds samples; every hour the emulated Shortcut GETs /pending, WRITES
 * each entry's values into Health (one sample per field, dated sample_at), POSTs
 * /ack with exactly what it wrote, and stops when pending is empty. The only
 * thing the emulator knows about the server is the JSON it is sent; the clock is
 * injected so a whole day passes in milliseconds.
 *
 * The invariant under test: Health's total for each day/field always equals the
 * logged total (never double, never negative), however runs overlap, retry or
 * crash.
 */
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";
import {
    OWNER_ID,
    deleteMeal,
    insertMeal,
    insertWater,
    upsertProfile,
} from "./db/repo.js";
import { useMemoryDb } from "./db/test-helpers.js";
import { createApp } from "./index.js";
import { _resetBuckets } from "./rate-limit.js";

useMemoryDb();

const KEY = "e2e-shortcut-key-".padEnd(60, "k");
let clock = Date.parse("2026-10-03T07:00:00Z"); // 10:00 Kyiv
const HOUR = 3_600_000;

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
    const app = createApp({
        mcpKey: () => "m".repeat(60),
        shortcutKey: () => KEY,
        exportSecret: () => "x".repeat(40),
        healthSync: { now: () => clock },
    });
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (req, srv) =>
            app.fetch(req, { ip: srv.requestIP(req)?.address }),
    });
    base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
    server.stop(true);
});

beforeEach(async () => {
    _resetBuckets();
    clock = Date.parse("2026-10-03T07:00:00Z");
    health.length = 0;
    await upsertProfile(OWNER_ID, { timezone: "Europe/Kyiv" });
});

// ---- the fake Apple Health --------------------------------------------------

interface Sample {
    field: string;
    value: number;
    at: string;
}
const health: Sample[] = [];

/** Health's total for a field on a local date (samples carry their own offset). */
const healthTotal = (date: string, field: string) =>
    Math.round(
        health
            .filter((s) => s.field === field && s.at.startsWith(date))
            .reduce((a, s) => a + s.value, 0) * 10,
    ) / 10;

// ---- the Shortcut -----------------------------------------------------------

const auth = {
    authorization: `Bearer ${KEY}`,
    "content-type": "application/json",
};

interface RunOptions {
    water?: boolean;
    /** Crash after writing this many entries into Health, before acking. */
    crashAfterWriting?: number;
    /** Ack twice (a retried request). */
    ackTwice?: boolean;
}

async function shortcutRun(o: RunOptions = {}) {
    const q = o.water ? "?water=1&tz=Europe/Kyiv" : "?tz=Europe/Kyiv";
    const res = await fetch(`${base}/api/v1/health-sync/pending${q}`, {
        headers: auth,
    });
    const p = (await res.json()) as any;
    if (res.status === 409) return { busy: true as const, written: 0, p };
    if (!p.ok) throw new Error(`pending failed: ${JSON.stringify(p)}`);
    if (p.count === 0) return { busy: false as const, written: 0, p };

    const acked: any[] = [];
    let written = 0;
    for (const entry of p.entries) {
        // "Repeat with each": Log Health Sample for every key present.
        for (const [field, value] of Object.entries(entry.values)) {
            health.push({ field, value: value as number, at: entry.sample_at });
        }
        written++;
        if (
            o.crashAfterWriting !== undefined &&
            written >= o.crashAfterWriting
        ) {
            return { busy: false as const, written, p, crashed: true as const };
        }
        acked.push({
            entry_id: entry.entry_id,
            date: entry.date,
            values: entry.values,
        });
    }
    const body = JSON.stringify({
        entries: acked,
        done: true,
        lease_until: p.lease_until,
    });
    const a = (await (
        await fetch(`${base}/api/v1/health-sync/ack`, {
            method: "POST",
            headers: auth,
            body,
        })
    ).json()) as any;
    if (o.ackTwice)
        await fetch(`${base}/api/v1/health-sync/ack`, {
            method: "POST",
            headers: auth,
            body,
        });
    return { busy: false as const, written, p, a };
}

const eat = (iso: string, calories: number, extra: object = {}) =>
    insertMeal(OWNER_ID, {
        description: "synthetic meal",
        meal_type: "lunch",
        calories,
        logged_at: iso,
        ...extra,
    });

describe("the Shortcut, end to end", () => {
    test("pending → write → ack → pending is empty → more food → only the new delta", async () => {
        await eat("2026-10-03T05:00:00Z", 450, { protein_g: 20 });
        const first = await shortcutRun();
        expect(first.written).toBe(1);
        expect(healthTotal("2026-10-03", "energy_kcal")).toBe(450);
        expect(healthTotal("2026-10-03", "protein_g")).toBe(20);

        const idle = await shortcutRun();
        expect(idle.p.count).toBe(0);
        expect(health).toHaveLength(2);

        clock += HOUR;
        await eat("2026-10-03T07:30:00Z", 600, {
            protein_g: 35,
            caffeine_mg: 80,
        });
        const second = await shortcutRun();
        expect(second.p.entries[0].values).toEqual({
            energy_kcal: 600,
            protein_g: 35,
            caffeine_mg: 80,
        });
        expect(healthTotal("2026-10-03", "energy_kcal")).toBe(1050);
        expect((await shortcutRun()).p.count).toBe(0);
    });

    test("a whole day of hourly runs with meals, water and a forgotten snack stays exactly in step", async () => {
        const meals: [string, number, number][] = [
            ["2026-10-03T05:10:00Z", 380, 18], // 08:10
            ["2026-10-03T09:40:00Z", 720, 41], // 12:40
            ["2026-10-03T15:20:00Z", 150, 3], // 18:20
            ["2026-10-03T17:55:00Z", 810, 52], // 20:55
        ];
        let logged = 0;
        for (let h = 0; h < 15; h++) {
            clock = Date.parse("2026-10-03T05:00:00Z") + h * HOUR; // 08:00 .. 22:00 Kyiv
            for (const [at, kcal, protein] of meals) {
                if (Date.parse(at) <= clock && Date.parse(at) > clock - HOUR) {
                    await eat(at, kcal, { protein_g: protein });
                    logged += kcal;
                }
            }
            if (h === 6)
                await insertWater(OWNER_ID, {
                    amount_ml: 600,
                    logged_at: new Date(clock).toISOString(),
                });
            await shortcutRun({ water: true });
        }
        expect(logged).toBe(2060);
        expect(healthTotal("2026-10-03", "energy_kcal")).toBe(2060);
        expect(healthTotal("2026-10-03", "protein_g")).toBe(114);
        expect(healthTotal("2026-10-03", "water_ml")).toBe(600);

        // Next morning: the day closes at 05:00; a snack logged late for yesterday is
        // swept up as a final top-up even though it is tiny.
        clock = Date.parse("2026-10-04T02:30:00Z"); // 05:30 Kyiv Oct 4
        await eat("2026-10-03T19:00:00Z", 9);
        await shortcutRun({ water: true });
        expect(healthTotal("2026-10-03", "energy_kcal")).toBe(2069);
        const last = health.at(-1)!;
        expect(last.at).toBe("2026-10-03T23:59:00+03:00");
        expect((await shortcutRun({ water: true })).p.count).toBe(0);
    });

    test("food deleted after it reached Health is reported, not subtracted; re-logging resumes cleanly", async () => {
        const m = await eat("2026-10-03T05:00:00Z", 800);
        await shortcutRun();
        await deleteMeal(OWNER_ID, m.meal.id);
        clock += HOUR;
        const r = await shortcutRun();
        expect(r.p.count).toBe(0);
        expect(r.p.discrepancies).toEqual([
            {
                date: "2026-10-03",
                field: "energy_kcal",
                sent: 800,
                current: 0,
                difference: -800,
            },
        ]);
        expect(healthTotal("2026-10-03", "energy_kcal")).toBe(800); // never lowered
        expect(health.every((s) => s.value > 0)).toBe(true);
        // eating 1000 now means Health needs only +200 to match the log again
        await eat("2026-10-03T08:00:00Z", 1000);
        clock += HOUR;
        await shortcutRun();
        expect(healthTotal("2026-10-03", "energy_kcal")).toBe(1000);
    });

    test("a crash between writing and acking re-offers the same entry id (the recipe acks per entry to keep this window tiny)", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        const crashed = await shortcutRun({ crashAfterWriting: 1 });
        expect(crashed.crashed).toBe(true);
        // The lease from the dead run is still held: an immediate retry is "busy".
        expect((await shortcutRun()).busy).toBe(true);
        clock += 130_000; // lease lapses
        const retry = await shortcutRun();
        expect(retry.p.entries[0].entry_id).toBe(crashed.p.entries[0].entry_id);
        expect(retry.p.entries[0].values).toEqual(crashed.p.entries[0].values);
    });

    test("a retried ack request never counts twice", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        await shortcutRun({ ackTwice: true });
        expect((await shortcutRun()).p.count).toBe(0);
        const status = (await (
            await fetch(`${base}/api/v1/health-sync/status`, { headers: auth })
        ).json()) as any;
        expect(status.days.at(-1).sent.energy_kcal).toBe(450);
        expect(status.days.at(-1).rounds).toBe(1);
    });

    test("two phones/automations racing: exactly one gets the entries, the other is told it is busy", async () => {
        await eat("2026-10-03T05:00:00Z", 450);
        const [a, b] = await Promise.all([shortcutRun(), shortcutRun()]);
        expect([a.busy, b.busy].sort()).toEqual([false, true]);
        expect(healthTotal("2026-10-03", "energy_kcal")).toBe(450);
    });

    test("the activity shortcut replaces the day total every run", async () => {
        const send = async (kcal: number) =>
            (await (
                await fetch(`${base}/api/v1/health-sync/activity`, {
                    method: "POST",
                    headers: auth,
                    body: JSON.stringify({
                        tz: "Europe/Kyiv",
                        days: [{ date: "2026-10-03", active_kcal: kcal }],
                    }),
                })
            ).json()) as any;
        expect((await send(120)).changed).toBe(1);
        clock += HOUR;
        expect((await send(340)).changed).toBe(1);
        expect((await send(340)).changed).toBe(0);
        const { getAllActiveCalories } = await import("./db/repo.js");
        expect(
            (await getAllActiveCalories(OWNER_ID)).map((r) => r.kcal),
        ).toEqual([340]);
    });
});
