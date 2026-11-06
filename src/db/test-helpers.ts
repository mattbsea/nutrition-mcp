import { afterEach, beforeEach } from "bun:test";
import type { MealItemValues } from "../meal-items.js";
import { closeDb, setDb } from "./conn.js";
import { openDb } from "./migrate.js";
import { OWNER_ID } from "./owner.js";

export const USER = OWNER_ID;
/** A second principal, only ever used to prove the owner predicate hides it. */
export const OTHER = "intruder";

/** Fresh in-memory database per test, installed as the process connection. */
export function useMemoryDb(): void {
    beforeEach(() => setDb(openDb(":memory:")));
    afterEach(() => closeDb());
}

export function item(
    position: number,
    overrides: Partial<MealItemValues> = {},
): MealItemValues {
    return {
        position,
        name: `ingredient ${position}`,
        amount: 100,
        unit: "g",
        calories: 100,
        protein_g: 5,
        carbs_g: 10,
        fat_g: 2,
        saturated_fat_g: null,
        trans_fat_g: null,
        fiber_g: null,
        sugar_g: null,
        added_sugar_g: null,
        alcohol_g: null,
        caffeine_mg: null,
        sodium_mg: null,
        ...overrides,
    };
}
