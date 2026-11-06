import { describe, expect, test } from "bun:test";
import { getDb } from "./conn.js";
import { TABLES } from "./schema.js";
import {
    createSavedMeal,
    createSqliteHealthActivityLinkStore,
    createSqliteHealthSyncStore,
    deleteAllUserData,
    exportArchivePath,
    exportStoragePaths,
    insertActiveCalories,
    insertBodyMeasurement,
    insertMeal,
    insertWater,
    insertWeight,
    upsertNutritionGoals,
    upsertProfile,
    writeFoodCache,
} from "./repo.js";
import { OTHER, USER, item, useMemoryDb } from "./test-helpers.js";

useMemoryDb();

const count = (table: string, owner?: string) =>
    (
        getDb()
            .query(
                owner
                    ? `SELECT count(*) n FROM ${table} WHERE user_id = ?`
                    : `SELECT count(*) n FROM ${table}`,
            )
            .get(...(owner ? [owner] : [])) as { n: number }
    ).n;

/** One row in every owner table for `who`. */
async function populate(who: string) {
    const saved = await createSavedMeal(
        who,
        {
            name: `Saved ${who}`,
            description: "d",
            meal_type: null,
            calories: 1,
            protein_g: 1,
            carbs_g: 1,
            fat_g: 1,
        } as never,
        [item(1)],
    );
    await insertMeal(who, {
        description: "m",
        meal_type: "lunch",
        calories: 100,
        logged_at: "2026-03-14T10:00:00.000Z",
        saved_meal_id: saved.id,
        items: [item(1)],
    });
    await insertWater(who, {
        amount_ml: 250,
        logged_at: "2026-03-14T10:00:00.000Z",
    });
    await insertWeight(who, {
        weight_g: 80000,
        logged_at: "2026-03-14T10:00:00.000Z",
    });
    await insertBodyMeasurement(who, {
        kind: "waist",
        value_mm: 800,
        value_entered: 80,
        entered_unit: "cm",
        logged_at: "2026-03-14T10:00:00.000Z",
    });
    await insertActiveCalories(who, {
        kcal: 100,
        credit_pct: 100,
        logged_at: "2026-03-14T10:00:00.000Z",
    });
    await upsertProfile(who, { timezone: "UTC" });
    await upsertNutritionGoals(who, { daily_calories: 2000 });
    const hs = createSqliteHealthSyncStore();
    await hs.replaceLink(
        who,
        {
            fields: ["calories"],
            fallbackTz: null,
            syncStartDate: "2026-03-10",
            expiresAt: "2030-01-01T00:00:00.000Z",
        },
        `tok-${who}`,
    );
    await hs.insertDays([
        {
            user_id: who,
            date: "2026-03-13",
            timezone: "UTC",
            sent_values: null,
            topup_seq: 0,
            offer_count: 0,
            notified: {},
            first_sent_at: null,
            last_sent_at: null,
        },
    ]);
    await hs.createPending({
        kind: "health",
        connectId: `c-${who}`,
        deviceSecret: `d-${who}`,
        pkceVerifier: "v",
        fields: [],
        tz: null,
        backfillDays: 0,
        expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await hs.setPendingClaim(
        `c-${who}`,
        `claim-${who}`,
        who,
        "2030-01-01T00:00:00.000Z",
    );
    await createSqliteHealthActivityLinkStore().replaceActivityLink(
        who,
        { fallbackTz: null, expiresAt: "2030-01-01T00:00:00.000Z" },
        `act-${who}`,
    );
}

describe("deleteAllUserData", () => {
    test("removes the owner's rows from every owner table, leaves others and the shared food cache", async () => {
        await populate(USER);
        await populate(OTHER);
        await writeFoodCache("usda", "1", { a: 1 });
        const owned = TABLES.filter((t) => t !== "food_cache");
        for (const t of owned) expect(count(t, USER)).toBeGreaterThan(0);

        await deleteAllUserData(USER);

        for (const t of owned) expect(count(t, USER)).toBe(0);
        for (const t of owned) expect(count(t, OTHER)).toBeGreaterThan(0);
        expect(count("food_cache")).toBe(1);
    });

    test("covers every table that has an owner column (a new table cannot be forgotten)", () => {
        for (const t of TABLES.filter((x) => x !== "food_cache")) {
            const cols = getDb().query(`PRAGMA table_info(${t})`).all() as {
                name: string;
            }[];
            expect(cols.map((c) => c.name)).toContain("user_id");
        }
    });

    test("is one transaction: a failure part-way leaves every row in place", async () => {
        await populate(USER);
        const before = TABLES.map((t) => [t, count(t)] as const);
        getDb().exec("ALTER TABLE profiles RENAME TO profiles_gone"); // fails mid-sequence
        await expect(deleteAllUserData(USER)).rejects.toThrow(
            /Failed to delete user data/,
        );
        getDb().exec("ALTER TABLE profiles_gone RENAME TO profiles");
        expect(TABLES.map((t) => [t, count(t)] as const)).toEqual(before);
    });

    test("is idempotent and a no-op on an empty database", async () => {
        await deleteAllUserData(USER);
        await deleteAllUserData(USER);
        expect(count("meals")).toBe(0);
    });
});

describe("foreign keys", () => {
    test("deleting a meal removes its items; deleting a saved meal removes its items and unlinks meals", async () => {
        await populate(USER);
        expect(count("meal_items")).toBe(1);
        expect(count("saved_meal_items")).toBe(1);
        getDb().query("DELETE FROM saved_meals").run();
        expect(count("saved_meal_items")).toBe(0);
        expect(
            (
                getDb().query("SELECT saved_meal_id FROM meals").get() as {
                    saved_meal_id: string | null;
                }
            ).saved_meal_id,
        ).toBeNull();
        getDb().query("DELETE FROM meals").run();
        expect(count("meal_items")).toBe(0);
    });

    test("an item cannot point at a missing meal", () => {
        expect(() =>
            getDb()
                .query(
                    "INSERT INTO meal_items (meal_id, user_id, position, name, calories, protein_g, carbs_g, fat_g) VALUES ('nope', ?, 1, 'x', 1, 1, 1, 1)",
                )
                .run(USER),
        ).toThrow(/FOREIGN KEY/);
    });
});

describe("export file names", () => {
    test("exportStoragePaths always includes the current archive and the legacy csv", () => {
        expect(exportStoragePaths(USER)).toEqual([
            exportArchivePath(USER),
            `${USER}/meals.csv`,
        ]);
    });
});

describe("a hostile owner id is only ever a bound parameter", () => {
    test("a hostile userId matches nothing and damages nothing (the dynamic column and IN lists are covered by the whitelist tests in meals/logs)", async () => {
        await populate(USER);
        const evil = "x' OR '1'='1";
        const { getAllMeals, getAllWater, countMeals, deleteMeal } =
            await import("./repo.js");
        expect(await getAllMeals(evil)).toEqual([]);
        expect(await getAllWater(evil)).toEqual([]);
        expect(await countMeals(evil)).toBe(0);
        expect(await deleteMeal(evil, "' OR 1=1 --")).toBe(false);
        await deleteAllUserData(evil);
        expect(count("meals")).toBe(1);
    });
});
