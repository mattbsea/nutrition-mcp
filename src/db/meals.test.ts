import { describe, expect, test } from "bun:test";
import { ToolError } from "../errors.js";
import { getDb } from "./conn.js";
import {
    SnapshotConflictError,
    countMealItems,
    countMeals,
    createSavedMeal,
    deleteMeal,
    deleteSavedMeal,
    existingIdempotencyKeys,
    existingMealIds,
    getAllMealItems,
    getAllMeals,
    getMealById,
    getMealItems,
    getMealsByDate,
    getMealsInRange,
    hasMealsBefore,
    insertMeal,
    replaceMealItems,
    searchMeals,
    snapshotGuardOf,
    updateMeal,
} from "./repo.js";
import { OTHER, USER, item, useMemoryDb } from "./test-helpers.js";

useMemoryDb();

const base = {
    description: "porridge",
    meal_type: "breakfast" as const,
    calories: 300,
    protein_g: 12,
    carbs_g: 45,
    fat_g: 8,
    logged_at: "2026-03-14T08:00:00.000Z",
};

describe("insertMeal", () => {
    test("stores every nutrient and provenance column and reads them back", async () => {
        const { meal, deduplicated } = await insertMeal(USER, {
            ...base,
            saturated_fat_g: 2.5,
            trans_fat_g: 0.1,
            fiber_g: 6,
            sugar_g: 9,
            added_sugar_g: 3,
            alcohol_g: 0,
            caffeine_mg: 80,
            sodium_mg: 140,
            notes: "with milk",
            nutrient_sources: { calories: { s: "estimate" } } as never,
            source_detail: { "usda:123": { name: "Oats" } } as never,
        });
        expect(deduplicated).toBe(false);
        expect(meal.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(meal).toMatchObject({
            user_id: USER,
            calories: 300,
            protein_g: 12,
            saturated_fat_g: 2.5,
            trans_fat_g: 0.1,
            fiber_g: 6,
            sugar_g: 9,
            added_sugar_g: 3,
            alcohol_g: 0,
            caffeine_mg: 80,
            sodium_mg: 140,
            notes: "with milk",
            saved_meal_id: null,
            logged_at: "2026-03-14T08:00:00.000Z",
        });
        expect(meal.nutrient_sources).toEqual({ calories: { s: "estimate" } } as never);
        expect(meal.source_detail).toEqual({ "usda:123": { name: "Oats" } } as never);
        expect(meal.idempotency_key).toStartWith("auto:");
        expect(await getMealById(USER, meal.id)).toEqual(meal);
    });

    test("normalises logged_at offsets to UTC ISO", async () => {
        const { meal } = await insertMeal(USER, { ...base, logged_at: "2026-03-14T01:00:00-07:00" });
        expect(meal.logged_at).toBe("2026-03-14T08:00:00.000Z");
    });

    test("rounds fractional calories to the integer column", async () => {
        const { meal } = await insertMeal(USER, { ...base, calories: 388.54 });
        expect(meal.calories).toBe(389);
    });

    test("an identical retry returns the existing row instead of duplicating", async () => {
        const a = await insertMeal(USER, base);
        const b = await insertMeal(USER, base);
        expect(b.deduplicated).toBe(true);
        expect(b.meal.id).toBe(a.meal.id);
        expect(await countMeals(USER)).toBe(1);
    });

    test("a client idempotency_key dedupes even when the content differs", async () => {
        const a = await insertMeal(USER, { ...base, idempotency_key: "k1" });
        const b = await insertMeal(USER, { ...base, description: "changed", idempotency_key: "k1" });
        expect(b.deduplicated).toBe(true);
        expect(b.meal.id).toBe(a.meal.id);
        expect(b.meal.description).toBe("porridge");
    });

    test("a deduplicated retry writes no extra items", async () => {
        const first = await insertMeal(USER, { ...base, items: [item(1)] });
        const again = await insertMeal(USER, { ...base, items: [item(1), item(2)] });
        expect(again.deduplicated).toBe(true);
        expect(await countMealItems(USER, first.meal.id)).toBe(1);
    });

    test("decodes escape sequences in description and notes", async () => {
        const { meal } = await insertMeal(USER, { ...base, description: "a\\u0041b", notes: "c\\x41d" });
        expect(meal.description).toBe("aAb");
        expect(meal.notes).toBe("cAd");
    });
});

describe("meals with items (insert_meal_with_items)", () => {
    test("writes the meal and its items together, in position order", async () => {
        const { meal } = await insertMeal(USER, {
            ...base,
            items: [item(2, { name: "milk" }), item(1, { name: "oats", amount: null, unit: null })],
        });
        const items = (await getMealItems(USER, [meal.id])).get(meal.id)!;
        expect(items.map((i) => i.name)).toEqual(["oats", "milk"]);
        expect(items[0]).toMatchObject({ amount: null, unit: null, calories: 100 });
        expect(await countMealItems(USER, meal.id)).toBe(2);
    });

    test("is atomic: a bad item rolls the meal back too", async () => {
        await expect(
            insertMeal(USER, { ...base, items: [item(1), item(1, { name: "dup position" })] }),
        ).rejects.toThrow(/Failed to insert meal/);
        expect(await countMeals(USER)).toBe(0);
        expect(getDb().query("SELECT count(*) n FROM meal_items").get()).toEqual({ n: 0 });
    });

    test("is atomic: a CHECK violation in a later item leaves nothing behind", async () => {
        await expect(
            insertMeal(USER, { ...base, items: [item(1), item(2, { calories: -5 })] }),
        ).rejects.toThrow();
        expect(await countMeals(USER)).toBe(0);
    });

    test("item provenance round-trips as parsed objects", async () => {
        const { meal } = await insertMeal(USER, {
            ...base,
            items: [item(1, { nutrient_sources: { calories: { s: "usda", ref: "123" } } as never, source_detail: { "usda:123": { name: "Oats" } } as never })],
        });
        const [it] = (await getMealItems(USER, [meal.id])).get(meal.id)!;
        expect(it!.nutrient_sources).toEqual({ calories: { s: "usda", ref: "123" } } as never);
        expect(it!.source_detail).toEqual({ "usda:123": { name: "Oats" } } as never);
    });

    test("deleting a meal cascades to its items", async () => {
        const { meal } = await insertMeal(USER, { ...base, items: [item(1), item(2)] });
        expect(await deleteMeal(USER, meal.id)).toBe(true);
        expect(await getAllMealItems(USER)).toEqual([]);
        expect(await deleteMeal(USER, meal.id)).toBe(false);
    });

    test("logging from a saved meal links it; deleting the saved meal nulls the link", async () => {
        const saved = await createSavedMeal(
            USER,
            { name: "Usual", description: "d", meal_type: null, calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 } as never,
            [item(1)],
        );
        const { meal } = await insertMeal(USER, { ...base, saved_meal_id: saved.id });
        expect(meal.saved_meal_id).toBe(saved.id);
        await deleteSavedMeal(USER, saved.id);
        const after = await getMealById(USER, meal.id);
        expect(after).not.toBeNull();
        expect(after!.saved_meal_id).toBeNull();
        expect(after!.calories).toBe(300);
    });

    test("an unknown saved_meal_id is a ToolError and writes nothing", async () => {
        const id = "00000000-0000-4000-8000-000000000000";
        await expect(insertMeal(USER, { ...base, saved_meal_id: id })).rejects.toBeInstanceOf(ToolError);
        expect(await countMeals(USER)).toBe(0);
    });
});

describe("updateMeal", () => {
    test("changes only the given fields and returns the row", async () => {
        const { meal } = await insertMeal(USER, base);
        const updated = await updateMeal(USER, meal.id, { calories: 350.4, notes: null as never });
        expect(updated).toMatchObject({ id: meal.id, calories: 350, protein_g: 12, description: "porridge" });
        expect(updated.notes).toBeNull();
    });

    test("recomputes an auto: idempotency key, so the corrected content dedupes", async () => {
        const { meal } = await insertMeal(USER, base);
        const updated = await updateMeal(USER, meal.id, { calories: 400 });
        expect(updated.idempotency_key).not.toBe(meal.idempotency_key);
        const relog = await insertMeal(USER, { ...base, calories: 400 });
        expect(relog.deduplicated).toBe(true);
        expect(relog.meal.id).toBe(meal.id);
    });

    test("leaves a caller-supplied idempotency key alone", async () => {
        const { meal } = await insertMeal(USER, { ...base, idempotency_key: "mine" });
        const updated = await updateMeal(USER, meal.id, { calories: 400 });
        expect(updated.idempotency_key).toBe("mine");
    });

    test("an unknown id is a ToolError", async () => {
        await expect(updateMeal(USER, "nope", { calories: 1 })).rejects.toBeInstanceOf(ToolError);
    });

    test("a matching snapshot guard lets the write land", async () => {
        const { meal } = await insertMeal(USER, { ...base, nutrient_sources: { calories: { s: "estimate" } } as never });
        const guard = snapshotGuardOf(meal as never);
        const updated = await updateMeal(USER, meal.id, { calories: 123 }, guard);
        expect(updated.calories).toBe(123);
    });

    test("a moved snapshot throws SnapshotConflictError and writes nothing", async () => {
        const { meal } = await insertMeal(USER, base);
        const guard = snapshotGuardOf(meal as never);
        await updateMeal(USER, meal.id, { protein_g: 99 });
        await expect(updateMeal(USER, meal.id, { calories: 1 }, guard)).rejects.toBeInstanceOf(
            SnapshotConflictError,
        );
        expect((await getMealById(USER, meal.id))!.calories).toBe(300);
    });

    test("the guard compares label objects ignoring key order, and null as IS NULL", async () => {
        const { meal } = await insertMeal(USER, { ...base, nutrient_sources: { fat_g: { s: "estimate" }, calories: { s: "label" } } as never });
        const guard = { ...snapshotGuardOf(meal as never), nutrient_sources: { calories: { s: "label" }, fat_g: { s: "estimate" } } };
        await expect(updateMeal(USER, meal.id, { calories: 5 }, guard)).resolves.toBeDefined();
        const nullGuard = { ...snapshotGuardOf((await getMealById(USER, meal.id)) as never), fiber_g: null };
        await expect(updateMeal(USER, meal.id, { calories: 6 }, nullGuard)).resolves.toBeDefined();
        await expect(
            updateMeal(USER, meal.id, { calories: 7 }, { ...nullGuard, protein_g: null }),
        ).rejects.toBeInstanceOf(SnapshotConflictError);
    });
});

describe("replaceMealItems (update_meal_with_items)", () => {
    test("replaces the items and the totals in one transaction", async () => {
        const { meal } = await insertMeal(USER, { ...base, items: [item(1), item(2), item(3)] });
        const updated = await replaceMealItems(
            USER,
            meal.id,
            { calories: 250, protein_g: 7, fiber_g: null, notes: "edited" },
            [item(1, { name: "only", calories: 250 })],
        );
        expect(updated).toMatchObject({ calories: 250, protein_g: 7, notes: "edited", carbs_g: 45 });
        const items = (await getMealItems(USER, [meal.id])).get(meal.id)!;
        expect(items).toHaveLength(1);
        expect(items[0]!.name).toBe("only");
    });

    test("a failing item insert rolls back the field update and keeps the old items", async () => {
        const { meal } = await insertMeal(USER, { ...base, items: [item(1), item(2)] });
        await expect(
            replaceMealItems(USER, meal.id, { calories: 1 }, [item(1), item(1)]),
        ).rejects.toThrow();
        expect((await getMealById(USER, meal.id))!.calories).toBe(300);
        expect(await countMealItems(USER, meal.id)).toBe(2);
    });

    test("an unknown meal is a ToolError", async () => {
        await expect(replaceMealItems(USER, "nope", {}, [])).rejects.toBeInstanceOf(ToolError);
    });
});

describe("reads", () => {
    test("day and range windows follow the timezone and are ordered", async () => {
        await insertMeal(USER, { ...base, description: "late", logged_at: "2026-03-15T06:30:00.000Z" });
        await insertMeal(USER, { ...base, description: "early", logged_at: "2026-03-14T09:00:00.000Z" });
        await insertMeal(USER, { ...base, description: "next", logged_at: "2026-03-15T20:00:00.000Z" });
        // America/Los_Angeles on 2026-03-14 is UTC-7 (DST began 2026-03-08):
        // 07:00Z Mar 14 .. 07:00Z Mar 15.
        const day = await getMealsByDate(USER, "2026-03-14", "America/Los_Angeles");
        expect(day.map((m) => m.description)).toEqual(["early", "late"]);
        const range = await getMealsInRange(USER, "2026-03-14", "2026-03-15", "UTC");
        expect(range.map((m) => m.description)).toEqual(["early", "late", "next"]);
    });

    test("meals sharing a logged_at keep a stable id order", async () => {
        for (const d of ["a", "b", "c"]) await insertMeal(USER, { ...base, description: d });
        const rows = await getMealsInRange(USER, "2026-03-14", "2026-03-14", "UTC");
        const ids = rows.map((r) => r.id);
        expect(ids).toEqual([...ids].sort());
    });

    test("hasMealsBefore", async () => {
        await insertMeal(USER, base);
        expect(await hasMealsBefore(USER, "2026-03-15", "UTC")).toBe(true);
        expect(await hasMealsBefore(USER, "2026-03-14", "UTC")).toBe(false);
    });

    test("existingIdempotencyKeys / existingMealIds", async () => {
        const { meal } = await insertMeal(USER, { ...base, idempotency_key: "k" });
        expect([...(await existingIdempotencyKeys(USER, ["k", "zzz"]))]).toEqual(["k"]);
        expect([...(await existingIdempotencyKeys(USER, []))]).toEqual([]);
        const found = await existingMealIds(USER, [meal.id.toUpperCase(), "not-a-uuid"]);
        expect([...found]).toEqual([meal.id]);
    });

    test("getAllMeals returns provenance parsed, oldest first", async () => {
        await insertMeal(USER, { ...base, description: "b", logged_at: "2026-03-14T09:00:00.000Z" });
        await insertMeal(USER, { ...base, description: "a", logged_at: "2026-03-14T08:00:00.000Z" });
        expect((await getAllMeals(USER)).map((m) => m.description)).toEqual(["a", "b"]);
    });

    test("getMealById ignores a non-uuid", async () => {
        expect(await getMealById(USER, "'; DROP TABLE meals; --")).toBeNull();
        expect(getDb().query("SELECT count(*) n FROM sqlite_master WHERE name='meals'").get()).toEqual({ n: 1 });
    });
});

describe("searchMeals", () => {
    test("matches description, notes and one ingredient holding every token", async () => {
        await insertMeal(USER, { ...base, description: "Chicken soup", logged_at: "2026-03-14T10:00:00.000Z" });
        await insertMeal(USER, { ...base, description: "lunch", notes: "leftover CHICKEN", logged_at: "2026-03-14T11:00:00.000Z" });
        await insertMeal(USER, {
            ...base,
            description: "bowl",
            logged_at: "2026-03-14T12:00:00.000Z",
            items: [item(1, { name: "Roast chicken thigh" }), item(2, { name: "rice" })],
        });
        await insertMeal(USER, { ...base, description: "salad" });
        const found = await searchMeals(USER, ["chicken"]);
        expect(found.map((m) => m.description)).toEqual(["bowl", "lunch", "Chicken soup"]);
    });

    test("all tokens of an alternative must match one field; alternatives OR", async () => {
        await insertMeal(USER, { ...base, description: "red apple" });
        await insertMeal(USER, { ...base, description: "green pear", logged_at: "2026-03-14T09:00:00.000Z" });
        expect(await searchMeals(USER, ["red pear"])).toEqual([]);
        expect((await searchMeals(USER, ["red apple", "green pear"])).length).toBe(2);
    });

    test("an ingredient needs ONE item to hold every token", async () => {
        await insertMeal(USER, { ...base, description: "x", items: [item(1, { name: "chicken" }), item(2, { name: "rice" })] });
        expect(await searchMeals(USER, ["chicken rice"])).toEqual([]);
    });

    test("is case-insensitive beyond ASCII", async () => {
        await insertMeal(USER, { ...base, description: "Борщ с говядиной" });
        await insertMeal(USER, { ...base, description: "Crème brûlée", logged_at: "2026-03-14T09:00:00.000Z" });
        expect((await searchMeals(USER, ["борщ"])).length).toBe(1);
        expect((await searchMeals(USER, ["CRÈME"])).length).toBe(1);
    });

    test("LIKE metacharacters and quotes in the query match literally", async () => {
        await insertMeal(USER, { ...base, description: "100% juice" });
        await insertMeal(USER, { ...base, description: "plain water", logged_at: "2026-03-14T09:00:00.000Z" });
        expect((await searchMeals(USER, ["%"])).map((m) => m.description)).toEqual(["100% juice"]);
        expect(await searchMeals(USER, ["_"])).toEqual([]);
        expect(await searchMeals(USER, ["' OR 1=1 --"])).toEqual([]);
    });

    test("sinceIso and limit are honoured", async () => {
        await insertMeal(USER, { ...base, description: "tea old", logged_at: "2026-01-01T00:00:00.000Z" });
        await insertMeal(USER, { ...base, description: "tea new", logged_at: "2026-03-01T00:00:00.000Z" });
        expect((await searchMeals(USER, ["tea"], { sinceIso: "2026-02-01T00:00:00Z" })).map((m) => m.description)).toEqual(["tea new"]);
        expect(await searchMeals(USER, ["tea"], { limit: 1 })).toHaveLength(1);
    });
});

describe("owner predicate", () => {
    test("a row owned by someone else is never returned or touched", async () => {
        const { meal } = await insertMeal(OTHER, base);
        expect(await getMealById(USER, meal.id)).toBeNull();
        expect(await getAllMeals(USER)).toEqual([]);
        expect(await countMeals(USER)).toBe(0);
        expect(await getMealsInRange(USER, "2026-03-14", "2026-03-14")).toEqual([]);
        expect(await searchMeals(USER, ["porridge"])).toEqual([]);
        expect((await existingMealIds(USER, [meal.id])).size).toBe(0);
        expect(await hasMealsBefore(USER, "2030-01-01")).toBe(false);
        expect(await deleteMeal(USER, meal.id)).toBe(false);
        await expect(updateMeal(USER, meal.id, { calories: 1 })).rejects.toBeInstanceOf(ToolError);
        await expect(replaceMealItems(USER, meal.id, {}, [])).rejects.toBeInstanceOf(ToolError);
        expect((await getMealById(OTHER, meal.id))!.calories).toBe(300);
    });

    test("the same idempotency key under another owner is a different row", async () => {
        const a = await insertMeal(USER, { ...base, idempotency_key: "same" });
        const b = await insertMeal(OTHER, { ...base, idempotency_key: "same" });
        expect(b.deduplicated).toBe(false);
        expect(b.meal.id).not.toBe(a.meal.id);
    });

    test("items of another owner's meal are invisible", async () => {
        const { meal } = await insertMeal(OTHER, { ...base, items: [item(1)] });
        expect((await getMealItems(USER, [meal.id])).size).toBe(0);
        expect(await countMealItems(USER, meal.id)).toBe(0);
    });
});
