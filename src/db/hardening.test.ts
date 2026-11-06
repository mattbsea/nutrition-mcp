import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createSavedMeal,
    deleteMeal,
    deleteSavedMeal,
    getMealById,
    getMealItems,
    getSavedMeal,
    insertMeal,
    insertWater,
    updateMeal,
    updateSavedMeal,
    upsertNutritionGoals,
    getNutritionGoals,
    countMealItems,
    replaceMealItems,
    deleteWeight,
    insertWeight,
    getBodyMeasurement,
    insertBodyMeasurement,
    getSavedMeals,
} from "./repo.js";
import { assertRuntimeSupport, openDb } from "./migrate.js";
import { normId, round2, ts } from "./util.js";
import { USER, item, useMemoryDb } from "./test-helpers.js";

describe("ts(): offset-less instants are UTC, independent of TZ", () => {
    test("zone-less strings are read as UTC; offsets and Z are honoured", () => {
        const saved = process.env.TZ;
        try {
            for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
                process.env.TZ = tz;
                expect(ts("2026-11-06T08:00:00")).toBe(
                    "2026-11-06T08:00:00.000Z",
                );
                expect(ts("2026-11-06 08:00")).toBe("2026-11-06T08:00:00.000Z");
                expect(ts("2026-11-06T08:00:00.5")).toBe(
                    "2026-11-06T08:00:00.500Z",
                );
                expect(ts("2026-11-06")).toBe("2026-11-06T00:00:00.000Z");
                expect(ts("2026-11-06T08:00:00-07:00")).toBe(
                    "2026-11-06T15:00:00.000Z",
                );
                expect(ts("2026-11-06T08:00:00Z")).toBe(
                    "2026-11-06T08:00:00.000Z",
                );
            }
        } finally {
            if (saved === undefined) delete process.env.TZ;
            else process.env.TZ = saved;
        }
    });

    test("an invalid instant throws", () => {
        expect(() => ts("not a date")).toThrow(/Invalid timestamp/);
    });
});

describe("round2: Postgres numeric rounding (half away from zero on the decimal)", () => {
    test.each([
        [1.005, 1.01],
        [2.675, 2.68],
        [1.255, 1.26],
        [150.455, 150.46],
        [-1.005, -1.01],
        [-2.675, -2.68],
        [0.004, 0],
        [0.005, 0.01],
        [9.994, 9.99],
        [12, 12],
        [0.1, 0.1],
        [1234.5, 1234.5],
        [99.999, 100],
    ])("%p -> %p", (input, out) => {
        expect(round2(input)).toBe(out);
    });
});

describe("goal rounding end to end", () => {
    useMemoryDb();
    test("stored values follow numeric(6,2) rounding", async () => {
        await upsertNutritionGoals(USER, {
            daily_protein_g: 1.005,
            daily_fat_g: 2.675,
            daily_sodium_mg: 2300.255,
        });
        expect(await getNutritionGoals(USER)).toMatchObject({
            daily_protein_g: 1.01,
            daily_fat_g: 2.68,
            daily_sodium_mg: 2300.26,
        });
    });
    test("a fractional target weight is rejected like Postgres integer", async () => {
        await expect(
            upsertNutritionGoals(USER, { target_weight_g: 70000.5 }),
        ).rejects.toThrow(/Failed to save goals/);
    });
});

describe("UUID ids are case-insensitive (Postgres uuid semantics)", () => {
    useMemoryDb();
    test("normId lowercases uuids only", () => {
        expect(normId("ABCDEF12-3456-4789-8ABC-DEF012345678")).toBe(
            "abcdef12-3456-4789-8abc-def012345678",
        );
        expect(normId("NOT-A-UUID")).toBe("NOT-A-UUID");
    });

    test("meal lookups, updates, items and deletes accept an upper-case id", async () => {
        const { meal } = await insertMeal(USER, {
            description: "x",
            meal_type: "lunch",
            calories: 100,
            logged_at: "2026-03-14T10:00:00.000Z",
            items: [item(1)],
        });
        const UP = meal.id.toUpperCase();
        expect((await getMealById(USER, UP))!.id).toBe(meal.id);
        expect((await getMealItems(USER, [UP])).get(meal.id)).toHaveLength(1);
        expect(await countMealItems(USER, UP)).toBe(1);
        expect((await updateMeal(USER, UP, { calories: 5 })).calories).toBe(5);
        const replaced = await replaceMealItems(USER, UP, { calories: 7 }, [
            item(1, { name: "n" }),
        ]);
        expect(replaced.calories).toBe(7);
        expect(await deleteMeal(USER, UP)).toBe(true);
        expect(await getMealById(USER, meal.id)).toBeNull();
    });

    test("saved meals, weight and body-measurement ids too", async () => {
        const saved = await createSavedMeal(
            USER,
            {
                name: "S",
                description: "d",
                meal_type: null,
                calories: 1,
                protein_g: 1,
                carbs_g: 1,
                fat_g: 1,
            } as never,
            [item(1)],
        );
        const UP = saved.id.toUpperCase();
        expect((await getSavedMeal(USER, UP))!.id).toBe(saved.id);
        expect(
            (await updateSavedMeal(USER, UP, { calories: 9 } as never, null))!
                .calories,
        ).toBe(9);
        const logged = await insertMeal(USER, {
            description: "x",
            meal_type: "lunch",
            saved_meal_id: UP,
            logged_at: "2026-03-14T10:00:00.000Z",
        });
        expect(logged.meal.saved_meal_id).toBe(saved.id);
        expect((await deleteSavedMeal(USER, UP))!.id).toBe(saved.id);

        const w = await insertWeight(USER, {
            weight_g: 1000,
            logged_at: "2026-03-14T10:00:00.000Z",
        });
        expect(await deleteWeight(USER, w.entry.id.toUpperCase())).toBe(true);
        const b = await insertBodyMeasurement(USER, {
            kind: "waist",
            value_mm: 800,
            value_entered: 80,
            entered_unit: "cm",
            logged_at: "2026-03-14T10:00:00.000Z",
        });
        expect(
            (await getBodyMeasurement(USER, b.entry.id.toUpperCase()))!.id,
        ).toBe(b.entry.id);
    });
});

describe("saved meals list in creation order on equal timestamps", () => {
    useMemoryDb();
    test("same-millisecond inserts keep insertion order via rowid", async () => {
        const names = ["z", "y", "x", "w"];
        for (const n of names)
            await createSavedMeal(
                USER,
                { name: n, description: "d", meal_type: null } as never,
                [],
            );
        const { getAllSavedMeals } = await import("./repo.js");
        expect((await getAllSavedMeals(USER)).map((s) => s.name)).toEqual(
            names,
        );
        expect((await getSavedMeals(USER)).map((s) => s.name)).toEqual([
            "w",
            "x",
            "y",
            "z",
        ]);
    });
});

describe("invalid timestamps surface as the write failure shape", () => {
    useMemoryDb();
    test("insertWater with a bad logged_at", async () => {
        await expect(
            insertWater(USER, { amount_ml: 10, logged_at: "nope" }),
        ).rejects.toThrow(/Failed to insert water: Invalid timestamp/);
    });
});

describe("two connections to one file serialise", () => {
    test("a second writer waits out / is refused while the first holds the lock, then proceeds", () => {
        const dir = mkdtempSync(join(tmpdir(), "nutdb-"));
        try {
            const path = join(dir, "n.db");
            const a = openDb(path);
            const b = openDb(path);
            b.exec("PRAGMA busy_timeout = 50"); // keep the test fast; production is 5000
            a.exec("BEGIN IMMEDIATE");
            a.query(
                "INSERT INTO water_log (user_id, amount_ml) VALUES ('local-owner', 100)",
            ).run();
            expect(() =>
                b
                    .query(
                        "INSERT INTO water_log (user_id, amount_ml) VALUES ('local-owner', 200)",
                    )
                    .run(),
            ).toThrow(/database is locked/);
            // b cannot see a's uncommitted row either
            expect(
                b
                    .query<{ n: number }, []>(
                        "SELECT count(*) n FROM water_log",
                    )
                    .get()!.n,
            ).toBe(0);
            a.exec("COMMIT");
            b.query(
                "INSERT INTO water_log (user_id, amount_ml) VALUES ('local-owner', 200)",
            ).run();
            expect(
                a
                    .query<{ n: number }, []>(
                        "SELECT count(*) n FROM water_log",
                    )
                    .get()!.n,
            ).toBe(2);
            a.close();
            b.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("the production busy_timeout is 5000 ms and the runtime check passes", () => {
        const db = openDb(":memory:");
        expect(
            db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!
                .timeout,
        ).toBe(5000);
        expect(() => assertRuntimeSupport(db)).not.toThrow();
        db.close();
    });
});

describe("raw Database without the runtime support is refused with a clear message", () => {
    test("assertRuntimeSupport rejects a too-old SQLite", () => {
        const fake = Object.create(new Database(":memory:"), {
            query: { value: () => ({ get: () => ({ v: "3.36.0" }) }) },
        }) as Database;
        expect(() => assertRuntimeSupport(fake)).toThrow(/STRICT/);
    });
});
