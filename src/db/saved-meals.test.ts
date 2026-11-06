import { describe, expect, test } from "bun:test";
import {
    SavedMealNameTaken,
    SnapshotConflictError,
    countSavedMeals,
    createSavedMeal,
    deleteSavedMeal,
    findSavedMealsByName,
    getAllSavedMealItems,
    getAllSavedMeals,
    getSavedMeal,
    getSavedMeals,
    searchSavedMeals,
    snapshotGuardOf,
    updateSavedMeal,
    updateSavedMealIfUnchanged,
} from "./repo.js";
import { getDb } from "./conn.js";
import { OTHER, USER, item, useMemoryDb } from "./test-helpers.js";

useMemoryDb();

const input = (name: string, extra: object = {}) =>
    ({
        name,
        description: `${name} description`,
        meal_type: "lunch",
        calories: 500,
        protein_g: 30,
        carbs_g: 40,
        fat_g: 20,
        ...extra,
    }) as never;

describe("createSavedMeal (insert_saved_meal)", () => {
    test("creates the saved meal with its ingredients", async () => {
        const saved = await createSavedMeal(
            USER,
            input("Chicken bowl", { sodium_mg: 600 }),
            [item(1, { name: "chicken" }), item(2, { name: "rice" })],
        );
        expect(saved).toMatchObject({
            name: "Chicken bowl",
            user_id: USER,
            calories: 500,
            sodium_mg: 600,
            meal_type: "lunch",
        });
        expect(saved.items.map((i) => i.name)).toEqual(["chicken", "rice"]);
        const read = await getSavedMeal(USER, saved.id);
        expect(read!.items).toHaveLength(2);
        expect(read!.created_at).toBe(saved.created_at);
    });

    test("a name already used (ignoring case) throws SavedMealNameTaken with the existing id and writes nothing", async () => {
        const a = await createSavedMeal(USER, input("Oatmeal"), [item(1)]);
        const err = await createSavedMeal(USER, input("OATMEAL"), [
            item(1),
        ]).catch((e) => e);
        expect(err).toBeInstanceOf(SavedMealNameTaken);
        expect(err.existingId).toBe(a.id);
        expect(await countSavedMeals(USER)).toBe(1);
    });

    test("case-insensitive uniqueness covers non-ASCII", async () => {
        await createSavedMeal(USER, input("Борщ"), []);
        await expect(
            createSavedMeal(USER, input("борщ"), []),
        ).rejects.toBeInstanceOf(SavedMealNameTaken);
    });

    test("is atomic: a bad item rolls the saved meal back", async () => {
        await expect(
            createSavedMeal(USER, input("Broken"), [item(1), item(1)]),
        ).rejects.toThrow(/Failed to save meal/);
        expect(await countSavedMeals(USER)).toBe(0);
    });

    test("two owners may use the same name", async () => {
        await createSavedMeal(USER, input("Same"), []);
        await createSavedMeal(OTHER, input("Same"), []);
        expect(await countSavedMeals(USER)).toBe(1);
        expect(await countSavedMeals(OTHER)).toBe(1);
    });
});

describe("updateSavedMeal (update_saved_meal)", () => {
    test("changes only the given keys, null clears, updated_at moves, items kept when null", async () => {
        const saved = await createSavedMeal(
            USER,
            input("Lunch", { fiber_g: 5 }),
            [item(1)],
        );
        await Bun.sleep(5);
        const updated = await updateSavedMeal(
            USER,
            saved.id,
            { calories: 450.6, fiber_g: null } as never,
            null,
        );
        expect(updated).toMatchObject({
            name: "Lunch",
            calories: 451,
            fiber_g: null,
            protein_g: 30,
        });
        expect(updated!.items).toHaveLength(1);
        expect(updated!.updated_at > saved.updated_at).toBe(true);
        expect(updated!.created_at).toBe(saved.created_at);
    });

    test("replaces ingredients when given (including with an empty list)", async () => {
        const saved = await createSavedMeal(USER, input("Lunch"), [
            item(1),
            item(2),
        ]);
        const swapped = await updateSavedMeal(USER, saved.id, {}, [
            item(1, { name: "new" }),
        ]);
        expect(swapped!.items.map((i) => i.name)).toEqual(["new"]);
        const cleared = await updateSavedMeal(USER, saved.id, {}, []);
        expect(cleared!.items).toEqual([]);
        expect(await getAllSavedMealItems(USER)).toEqual([]);
    });

    test("renaming onto another saved meal's name throws and rolls the item change back", async () => {
        const a = await createSavedMeal(USER, input("A"), [
            item(1, { name: "keep" }),
        ]);
        await createSavedMeal(USER, input("B"), []);
        const err = await updateSavedMeal(USER, a.id, { name: "b" }, [
            item(1, { name: "lost" }),
        ]).catch((e) => e);
        expect(err).toBeInstanceOf(SavedMealNameTaken);
        const after = await getSavedMeal(USER, a.id);
        expect(after!.name).toBe("A");
        expect(after!.items.map((i) => i.name)).toEqual(["keep"]);
    });

    test("renaming updates the case-insensitive key", async () => {
        const a = await createSavedMeal(USER, input("Old"), []);
        await updateSavedMeal(USER, a.id, { name: "Fresh" }, null);
        await expect(
            createSavedMeal(USER, input("fresh"), []),
        ).rejects.toBeInstanceOf(SavedMealNameTaken);
        await createSavedMeal(USER, input("old"), []); // the old name is free again
    });

    test("null for an unknown id, a non-uuid or another owner's row", async () => {
        const other = await createSavedMeal(OTHER, input("Theirs"), []);
        expect(
            await updateSavedMeal(USER, other.id, { calories: 1 }, null),
        ).toBeNull();
        expect(
            await updateSavedMeal(USER, "nope", { calories: 1 }, null),
        ).toBeNull();
        expect((await getSavedMeal(OTHER, other.id))!.calories).toBe(500);
    });
});

describe("updateSavedMealIfUnchanged", () => {
    test("lands while the snapshot holds, conflicts after it moved", async () => {
        const saved = await createSavedMeal(USER, input("Guarded"), []);
        const guard = snapshotGuardOf(saved as never);
        const ok = await updateSavedMealIfUnchanged(
            USER,
            saved.id,
            { calories: 111 } as never,
            guard,
        );
        expect(ok!.calories).toBe(111);
        await expect(
            updateSavedMealIfUnchanged(
                USER,
                saved.id,
                { calories: 222 } as never,
                guard,
            ),
        ).rejects.toBeInstanceOf(SnapshotConflictError);
        expect((await getSavedMeal(USER, saved.id))!.calories).toBe(111);
    });

    test("null when the saved meal does not exist", async () => {
        expect(
            await updateSavedMealIfUnchanged(
                USER,
                "00000000-0000-4000-8000-000000000000",
                {},
                {},
            ),
        ).toBeNull();
    });
});

describe("reads, search, delete", () => {
    test("getSavedMeals orders by name ignoring case and filters by nameContains", async () => {
        await createSavedMeal(USER, input("banana"), []);
        await createSavedMeal(USER, input("Apple"), []);
        await createSavedMeal(USER, input("cherry pie"), []);
        expect((await getSavedMeals(USER)).map((s) => s.name)).toEqual([
            "Apple",
            "banana",
            "cherry pie",
        ]);
        expect(
            (await getSavedMeals(USER, { nameContains: " PIE " })).map(
                (s) => s.name,
            ),
        ).toEqual(["cherry pie"]);
        expect(await getSavedMeals(USER, { nameContains: "%" })).toEqual([]);
    });

    test("findSavedMealsByName is exact and case-insensitive", async () => {
        const a = await createSavedMeal(USER, input("Big Salad"), [item(1)]);
        expect(
            (await findSavedMealsByName(USER, "  big salad ")).map((s) => s.id),
        ).toEqual([a.id]);
        expect(await findSavedMealsByName(USER, "big")).toEqual([]);
        expect(await findSavedMealsByName(USER, "   ")).toEqual([]);
    });

    test("searchSavedMeals matches name, description and one ingredient; counts total", async () => {
        await createSavedMeal(
            USER,
            input("Pasta night", { description: "tomato sauce" }),
            [item(1, { name: "spaghetti" })],
        );
        await createSavedMeal(USER, input("Soup", { description: "plain" }), [
            item(1, { name: "Tomato" }),
        ]);
        await createSavedMeal(
            USER,
            input("Toast", { description: "plain" }),
            [],
        );
        const r = await searchSavedMeals(USER, ["tomato"]);
        expect(r.total).toBe(2);
        expect(r.saved.map((s) => s.name)).toEqual(["Pasta night", "Soup"]);
        expect(r.saved[0]).toMatchObject({ item_count: 1, calories: 500 });
        expect(await searchSavedMeals(USER, [])).toEqual({
            saved: [],
            total: 0,
        });
    });

    test("searchSavedMeals cuts to the limit by name but reports the full total", async () => {
        for (let i = 0; i < 25; i++)
            await createSavedMeal(
                USER,
                input(`bowl ${String(i).padStart(2, "0")}`),
                [],
            );
        const r = await searchSavedMeals(USER, ["bowl"]);
        expect(r.total).toBe(25);
        expect(r.saved).toHaveLength(20);
        expect(r.saved[0]!.name).toBe("bowl 00");
    });

    test("deleteSavedMeal returns the row, cascades items, null the second time", async () => {
        const a = await createSavedMeal(USER, input("Gone"), [item(1)]);
        expect((await deleteSavedMeal(USER, a.id))!.name).toBe("Gone");
        expect(await getAllSavedMealItems(USER)).toEqual([]);
        expect(await deleteSavedMeal(USER, a.id)).toBeNull();
    });

    test("export readers return rows as stored (no internal name_key)", async () => {
        await createSavedMeal(
            USER,
            input("Exp", { nutrient_sources: { calories: { s: "estimate" } } }),
            [item(1)],
        );
        const [row] = await getAllSavedMeals(USER);
        expect(row).toMatchObject({ name: "Exp", user_id: USER });
        expect("name_key" in (row as object)).toBe(false);
        expect((await getAllSavedMealItems(USER))[0]).toMatchObject({
            name: "ingredient 1",
            position: 1,
        });
    });

    test("another owner's saved meals are invisible everywhere", async () => {
        const theirs = await createSavedMeal(OTHER, input("Secret"), [item(1)]);
        expect(await getSavedMeal(USER, theirs.id)).toBeNull();
        expect(await getSavedMeals(USER)).toEqual([]);
        expect(await findSavedMealsByName(USER, "Secret")).toEqual([]);
        expect((await searchSavedMeals(USER, ["secret"])).total).toBe(0);
        expect(await deleteSavedMeal(USER, theirs.id)).toBeNull();
        expect(await getAllSavedMeals(USER)).toEqual([]);
        expect(await getAllSavedMealItems(USER)).toEqual([]);
        expect(
            getDb().query("SELECT count(*) n FROM saved_meals").get(),
        ).toEqual({ n: 1 });
    });
});
