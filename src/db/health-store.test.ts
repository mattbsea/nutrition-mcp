import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getDb } from "./conn.js";
import { runMigrations } from "./migrate.js";
import { MIGRATIONS } from "./schema.js";
import { createSqliteHealthSyncStore, type HealthSyncDayRow } from "./repo.js";
import { OTHER, USER, useMemoryDb } from "./test-helpers.js";

useMemoryDb();

const store = () => createSqliteHealthSyncStore();
const NOW = new Date("2026-03-14T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;

const day = (
    date: string,
    over: Partial<HealthSyncDayRow> = {},
): HealthSyncDayRow => ({
    date,
    timezone: "America/Denver",
    rounds: 1,
    sent: { energy_kcal: 500, protein_g: 30.5 },
    first_sent_at: iso(0),
    last_sent_at: iso(0),
    ...over,
});

describe("migration 2", () => {
    test("upgrades a version-1 database, dropping the pairing tables and adding the ledger", () => {
        const db = new Database(":memory:");
        runMigrations(db, [MIGRATIONS[0]!]);
        const before = db
            .query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type='table'",
            )
            .all()
            .map((r) => r.name);
        expect(before).toContain("health_sync_pending");
        expect(before).toContain("health_activity_links");
        expect(runMigrations(db)).toBe(MIGRATIONS.length);
        const after = db
            .query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type='table'",
            )
            .all()
            .map((r) => r.name);
        for (const gone of [
            "health_sync_pending",
            "health_sync_links",
            "health_activity_links",
        ])
            expect(after).not.toContain(gone);
        for (const here of [
            "health_sync_state",
            "health_sync_days",
            "health_sync_sent",
        ])
            expect(after).toContain(here);
        db.close();
    });
});

describe("the lease", () => {
    test("one winner until it lapses; released only by its holder", async () => {
        expect(await store().acquireLease(USER, iso(2 * MIN), NOW)).toBe(true);
        expect(await store().acquireLease(USER, iso(3 * MIN), NOW)).toBe(false);
        // lapsed
        expect(
            await store().acquireLease(
                USER,
                iso(10 * MIN),
                new Date(NOW.getTime() + 3 * MIN),
            ),
        ).toBe(true);
        // a stale holder cannot release the newer lease
        await store().releaseLease(USER, iso(2 * MIN));
        expect(
            await store().acquireLease(
                USER,
                iso(20 * MIN),
                new Date(NOW.getTime() + 4 * MIN),
            ),
        ).toBe(false);
        await store().releaseLease(USER, iso(10 * MIN));
        expect(
            await store().acquireLease(
                USER,
                iso(20 * MIN),
                new Date(NOW.getTime() + 4 * MIN),
            ),
        ).toBe(true);
        await store().releaseLease(USER);
        expect(
            await store().acquireLease(
                USER,
                iso(30 * MIN),
                new Date(NOW.getTime() + 5 * MIN),
            ),
        ).toBe(true);
        await store().releaseLease(USER, "not a date"); // never throws, never matches
    });

    test("owners have separate leases", async () => {
        expect(await store().acquireLease(USER, iso(2 * MIN), NOW)).toBe(true);
        expect(await store().acquireLease(OTHER, iso(2 * MIN), NOW)).toBe(true);
    });
});

describe("the ledger", () => {
    test("commitDay is compare-and-set on the round count", async () => {
        expect(
            await store().commitDay(USER, 0, day("2026-03-12"), iso(0)),
        ).toBe(true);
        // a replay expecting the old count loses
        expect(
            await store().commitDay(USER, 0, day("2026-03-12"), iso(MIN)),
        ).toBe(false);
        // the next round expects the new count
        const next = day("2026-03-12", {
            rounds: 2,
            sent: { energy_kcal: 650, protein_g: 40 },
            last_sent_at: iso(MIN),
        });
        expect(await store().commitDay(USER, 1, next, iso(MIN))).toBe(true);
        expect(await store().commitDay(USER, 1, next, iso(2 * MIN))).toBe(
            false,
        );
        const [row] = await store().getDays(USER, "2026-03-12", "2026-03-12");
        expect(row).toMatchObject({
            date: "2026-03-12",
            timezone: "America/Denver",
            rounds: 2,
            sent: { energy_kcal: 650, protein_g: 40 },
            last_sent_at: iso(MIN),
        });
    });

    test("a failed commit writes nothing, not even a partial sent set", async () => {
        await store().commitDay(USER, 0, day("2026-03-12"), iso(0));
        await store().commitDay(
            USER,
            0,
            day("2026-03-12", { sent: { energy_kcal: 9999 } }),
            iso(MIN),
        );
        const [row] = await store().getDays(USER, "2026-03-12", "2026-03-12");
        expect(row!.sent).toEqual({ energy_kcal: 500, protein_g: 30.5 });
    });

    test("a commit that violates a CHECK rolls the whole day back", async () => {
        await expect(
            store().commitDay(
                USER,
                0,
                day("2026-03-12", { sent: { energy_kcal: 5, protein_g: -1 } }),
                iso(0),
            ),
        ).rejects.toThrow(/CHECK constraint failed/);
        expect(await store().getDays(USER, "2026-03-01", "2026-03-31")).toEqual(
            [],
        );
    });

    test("getDays is a date-ordered inclusive window with sent values attached", async () => {
        await store().commitDay(USER, 0, day("2026-03-13"), iso(0));
        await store().commitDay(
            USER,
            0,
            day("2026-03-11", { sent: { water_ml: 750 } }),
            iso(0),
        );
        await store().commitDay(USER, 0, day("2026-03-15"), iso(0));
        const got = await store().getDays(USER, "2026-03-11", "2026-03-13");
        expect(got.map((d) => d.date)).toEqual(["2026-03-11", "2026-03-13"]);
        expect(got[0]!.sent).toEqual({ water_ml: 750 });
    });

    test("deleteDaysBefore sweeps only this owner's old days (sent values cascade)", async () => {
        await store().commitDay(USER, 0, day("2026-03-01"), iso(0));
        await store().commitDay(USER, 0, day("2026-03-12"), iso(0));
        await store().commitDay(OTHER, 0, day("2026-03-01"), iso(0));
        expect(await store().deleteDaysBefore(USER, "2026-03-10")).toBe(1);
        expect(
            (await store().getDays(USER, "2026-01-01", "2026-12-31")).map(
                (d) => d.date,
            ),
        ).toEqual(["2026-03-12"]);
        expect(
            await store().getDays(OTHER, "2026-01-01", "2026-12-31"),
        ).toHaveLength(1);
        expect(
            getDb()
                .query(
                    "SELECT count(*) n FROM health_sync_sent WHERE date = '2026-03-01' AND user_id = ?",
                )
                .get(USER),
        ).toEqual({ n: 0 });
    });

    test("another owner's days are invisible and unaffected", async () => {
        await store().commitDay(OTHER, 0, day("2026-03-12"), iso(0));
        expect(await store().getDays(USER, "2026-03-01", "2026-03-31")).toEqual(
            [],
        );
        expect(
            await store().commitDay(USER, 0, day("2026-03-12"), iso(0)),
        ).toBe(true);
        expect(
            await store().getDays(OTHER, "2026-03-01", "2026-03-31"),
        ).toHaveLength(1);
    });
});

describe("state clocks and reset", () => {
    test("an owner with no row reads all-null", async () => {
        expect(await store().getState(USER)).toEqual({
            lease_until: null,
            last_sync_at: null,
            last_ack_at: null,
            last_activity_at: null,
        });
    });

    test("touchSync, commitDay (last_ack_at) and setActivitySynced stamp their own clock", async () => {
        await store().touchSync(USER, iso(MIN));
        await store().commitDay(USER, 0, day("2026-03-12"), iso(2 * MIN));
        await store().setActivitySynced(USER, iso(3 * MIN));
        expect(await store().getState(USER)).toMatchObject({
            last_sync_at: iso(MIN),
            last_ack_at: iso(2 * MIN),
            last_activity_at: iso(3 * MIN),
        });
        // a later touch does not disturb the others
        await store().touchSync(USER, iso(9 * MIN));
        expect(await store().getState(USER)).toMatchObject({
            last_sync_at: iso(9 * MIN),
            last_ack_at: iso(2 * MIN),
        });
    });

    test("reset forgets the ledger and the clocks, for this owner only", async () => {
        await store().commitDay(USER, 0, day("2026-03-12"), iso(0));
        await store().commitDay(OTHER, 0, day("2026-03-12"), iso(0));
        await store().touchSync(USER, iso(MIN));
        await store().reset(USER);
        expect(await store().getDays(USER, "2026-01-01", "2026-12-31")).toEqual(
            [],
        );
        expect((await store().getState(USER)).last_sync_at).toBeNull();
        expect(
            await store().getDays(OTHER, "2026-01-01", "2026-12-31"),
        ).toHaveLength(1);
    });
});
