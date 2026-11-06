/**
 * Synthetic data for the dashboard tests and the screenshot script. Invented
 * foods and numbers only; nothing here resembles a real person's log.
 */
import {
    OWNER_ID,
    createSqliteHealthSyncStore,
    insertActiveCalories,
    insertMeal,
    insertWater,
    insertWeight,
    upsertNutritionGoals,
    upsertProfile,
} from "../db/repo.js";
import type { MealInput } from "../db/repo.js";
import { shiftLocalDate, todayInTz } from "../tz.js";

const FOODS: Omit<MealInput, "logged_at">[] = [
    {
        description: "Oat porridge with berries",
        meal_type: "breakfast",
        calories: 380,
        protein_g: 14,
        carbs_g: 62,
        fat_g: 8,
        fiber_g: 9,
        sugar_g: 14,
    },
    {
        description: "Chicken and rice bowl",
        meal_type: "lunch",
        calories: 640,
        protein_g: 46,
        carbs_g: 72,
        fat_g: 16,
        fiber_g: 5,
        sodium_mg: 820,
    },
    {
        description: "Apple and almonds",
        meal_type: "snack",
        calories: 210,
        protein_g: 6,
        carbs_g: 24,
        fat_g: 11,
        fiber_g: 6,
        sugar_g: 16,
    },
    {
        description: "Lentil curry with flatbread",
        meal_type: "dinner",
        calories: 720,
        protein_g: 32,
        carbs_g: 98,
        fat_g: 20,
        fiber_g: 18,
        sodium_mg: 1100,
    },
    {
        description: "Greek yoghurt",
        meal_type: "snack",
        calories: 150,
        protein_g: 17,
        carbs_g: 8,
        fat_g: 5,
    },
    {
        description: "Veggie omelette",
        meal_type: "breakfast",
        calories: 420,
        protein_g: 28,
        carbs_g: 10,
        fat_g: 29,
    },
    {
        description: "Tuna salad sandwich",
        meal_type: "lunch",
        calories: 560,
        protein_g: 34,
        carbs_g: 58,
        fat_g: 20,
    },
    {
        description: "Baked salmon with potatoes",
        meal_type: "dinner",
        calories: 690,
        protein_g: 42,
        carbs_g: 55,
        fat_g: 31,
    },
];

export const DEMO_GOALS = {
    daily_calories: 2200,
    daily_protein_g: 140,
    daily_carbs_g: 250,
    daily_fat_g: 70,
    daily_fiber_g: 30,
    daily_sugar_g: 60,
    daily_sodium_mg: 2300,
    daily_water_ml: 2500,
};

/**
 * `days` days of history ending today (UTC), a few meals a day, water, a weight
 * reading every other day, and active calories most days. Deterministic.
 */
export async function seedDemoData(days = 45, tz = "UTC"): Promise<void> {
    await upsertProfile(OWNER_ID, {
        timezone: tz,
        preferred_weight_unit: "kg",
    });
    await upsertNutritionGoals(OWNER_ID, DEMO_GOALS);
    const today = todayInTz(tz);
    let n = 0;
    for (let back = days - 1; back >= 0; back--) {
        const date = shiftLocalDate(today, -back);
        const meals = 3 + (back % 3 === 0 ? 1 : 0);
        for (let k = 0; k < meals; k++) {
            const food = FOODS[(n + k * 3) % FOODS.length]!;
            const hour = [8, 12, 16, 19][k]!;
            // Today only gets the meals that already "happened" by 09:00 UTC so
            // the page is stable whenever the script runs.
            if (back === 0 && hour > 12) continue;
            await insertMeal(OWNER_ID, {
                ...food,
                calories:
                    (food.calories ?? 0) + ((back * 7 + k * 13) % 80) - 40,
                logged_at: `${date}T${String(hour).padStart(2, "0")}:15:00Z`,
            });
            n++;
        }
        for (let w = 0; w < 4 + (back % 3); w++) {
            await insertWater(OWNER_ID, {
                amount_ml: 400,
                logged_at: `${date}T${String(8 + w * 3).padStart(2, "0")}:40:00Z`,
            });
        }
        if (back % 2 === 0) {
            await insertWeight(OWNER_ID, {
                weight_g: 82_000 - (days - back) * 55 + ((back * 37) % 300),
                logged_at: `${date}T07:05:00Z`,
            });
        }
        if (back % 5 !== 4) {
            await insertActiveCalories(OWNER_ID, {
                kcal: 180 + ((back * 41) % 420),
                credit_pct: 100,
                logged_at: `${date}T18:30:00Z`,
            });
        }
    }
    const store = createSqliteHealthSyncStore();
    await store.touchSync(OWNER_ID, new Date().toISOString());
}
