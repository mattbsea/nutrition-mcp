/**
 * Read-only data for the dashboard pages, computed from the repository with the
 * same helpers the MCP tools use (day bucketing, activity credit, goals) so a
 * number on a page is the number Claude would report. All times are the owner's
 * profile timezone.
 */
import { activityByDate, type ActivityTotals } from "../activity.js";
import {
    OWNER_ID,
    getActivityInRange,
    getLatestWeight,
    getMealById,
    getMealItems,
    getMealsInRange,
    getNutritionGoals,
    getProfile,
    getWaterInRange,
    getWeightInRange,
    searchMeals,
    getPreferredWeightUnit,
    getUserTimezone,
} from "../db/repo.js";
import type { Meal, NutritionGoals, Profile } from "../db/repo.js";
import type { MealItemValues } from "../meal-items.js";
import { buildDailyBuckets, type DailyBucket } from "../insights.js";
import { dateInTz, shiftLocalDate, todayInTz } from "../tz.js";
import { fromGrams, type WeightUnit } from "../units.js";

export interface DayTotals {
    date: string;
    meals: number;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
    sugar_g: number;
    added_sugar_g: number;
    saturated_fat_g: number;
    sodium_mg: number;
    caffeine_mg: number;
    alcohol_g: number;
    water_ml: number;
    burned_kcal: number;
    credited_kcal: number;
    net_kcal: number;
}

/** The profile's weight unit; kg until one is chosen. */
const weightUnit = async (): Promise<WeightUnit> =>
    (await getPreferredWeightUnit(OWNER_ID)) ?? "kg";

const ZERO_ACTIVITY: ActivityTotals = { burned_kcal: 0, credited_kcal: 0 };

function dayTotals(b: DailyBucket, act: ActivityTotals | undefined): DayTotals {
    const a = act ?? ZERO_ACTIVITY;
    return {
        date: b.date,
        meals: b.meals.length,
        calories: b.calories,
        protein_g: b.protein_g,
        carbs_g: b.carbs_g,
        fat_g: b.fat_g,
        fiber_g: b.fiber_g,
        sugar_g: b.sugar_g,
        added_sugar_g: b.added_sugar_g,
        saturated_fat_g: b.saturated_fat_g,
        sodium_mg: b.sodium_mg,
        caffeine_mg: b.caffeine_mg,
        alcohol_g: b.alcohol_g,
        water_ml: b.waterMl,
        burned_kcal: a.burned_kcal,
        credited_kcal: a.credited_kcal,
        net_kcal: b.calories - a.credited_kcal,
    };
}

export interface WeightPoint {
    date: string;
    value: number;
}

export interface TodayData {
    tz: string;
    date: string;
    goals: NutritionGoals | null;
    totals: DayTotals;
    weightUnit: WeightUnit;
    latestWeight: { value: number; date: string } | null;
    /** Today's meals, oldest first; empty when nothing is logged yet. */
    meals: Meal[];
    /** When today is empty: the latest meals of the last week, newest first. */
    recent: Meal[];
    alcoholTracking: boolean;
}

export async function loadToday(): Promise<TodayData> {
    const tz = await getUserTimezone(OWNER_ID);
    const date = todayInTz(tz);
    const [meals, water, activity, goals, profile, latest, unit] =
        await Promise.all([
            getMealsInRange(OWNER_ID, date, date, tz),
            getWaterInRange(OWNER_ID, date, date, tz),
            getActivityInRange(OWNER_ID, date, date, tz),
            getNutritionGoals(OWNER_ID),
            getProfile(OWNER_ID),
            getLatestWeight(OWNER_ID),
            weightUnit(),
        ]);
    const [bucket] = buildDailyBuckets(meals, water, date, date, tz);
    const act = activityByDate(activity, tz).get(date);
    let recent: Meal[] = [];
    if (meals.length === 0) {
        const week = await getMealsInRange(
            OWNER_ID,
            shiftLocalDate(date, -7),
            date,
            tz,
        );
        recent = week.slice(-8).reverse();
    }
    return {
        tz,
        date,
        goals,
        totals: dayTotals(bucket!, act),
        weightUnit: unit,
        latestWeight: latest
            ? {
                  value: fromGrams(latest.weight_g, unit),
                  date: dateInTz(latest.logged_at, tz),
              }
            : null,
        meals,
        recent,
        alcoholTracking: Boolean(
            (profile as Profile | null)?.alcohol_tracking_enabled,
        ),
    };
}

export const TREND_RANGES = [7, 30, 90] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

export function parseRange(raw: string | undefined): TrendRange {
    const n = Number(raw);
    return (TREND_RANGES as readonly number[]).includes(n)
        ? (n as TrendRange)
        : 30;
}

export interface TrendsData {
    tz: string;
    days: TrendRange;
    from: string;
    to: string;
    goals: NutritionGoals | null;
    series: DayTotals[];
    weightUnit: WeightUnit;
    weights: WeightPoint[];
    /** Averages over days with at least one meal. */
    loggedDays: number;
    avgCalories: number | null;
    avgProtein: number | null;
}

export async function loadTrends(days: TrendRange): Promise<TrendsData> {
    const tz = await getUserTimezone(OWNER_ID);
    const to = todayInTz(tz);
    const from = shiftLocalDate(to, -(days - 1));
    const [meals, water, activity, weights, goals, unit] = await Promise.all([
        getMealsInRange(OWNER_ID, from, to, tz),
        getWaterInRange(OWNER_ID, from, to, tz),
        getActivityInRange(OWNER_ID, from, to, tz),
        getWeightInRange(OWNER_ID, from, to, tz),
        getNutritionGoals(OWNER_ID),
        weightUnit(),
    ]);
    const buckets = buildDailyBuckets(meals, water, from, to, tz);
    const act = activityByDate(activity, tz);
    const series = buckets.map((b) => dayTotals(b, act.get(b.date)));
    // One weight per day: the last reading of that day.
    const byDay = new Map<string, number>();
    for (const w of weights)
        byDay.set(dateInTz(w.logged_at, tz), fromGrams(w.weight_g, unit));
    const weightPoints = [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, value }));
    const logged = series.filter((d) => d.meals > 0);
    const avg = (f: (d: DayTotals) => number) =>
        logged.length
            ? logged.reduce((s, d) => s + f(d), 0) / logged.length
            : null;
    return {
        tz,
        days,
        from,
        to,
        goals,
        series,
        weightUnit: unit,
        weights: weightPoints,
        loggedDays: logged.length,
        avgCalories: avg((d) => d.calories),
        avgProtein: avg((d) => d.protein_g),
    };
}

export interface MealsDayData {
    tz: string;
    date: string;
    today: string;
    meals: Meal[];
    totals: DayTotals;
}

/** A well-formed calendar date or null. */
export function parseDate(raw: string | undefined): string | null {
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const d = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw
        ? null
        : raw;
}

export async function loadMealsDay(
    requested: string | null,
): Promise<MealsDayData> {
    const tz = await getUserTimezone(OWNER_ID);
    const today = todayInTz(tz);
    const date = requested ?? today;
    const [meals, water, activity] = await Promise.all([
        getMealsInRange(OWNER_ID, date, date, tz),
        getWaterInRange(OWNER_ID, date, date, tz),
        getActivityInRange(OWNER_ID, date, date, tz),
    ]);
    const [bucket] = buildDailyBuckets(meals, water, date, date, tz);
    return {
        tz,
        date,
        today,
        meals,
        totals: dayTotals(bucket!, activityByDate(activity, tz).get(date)),
    };
}

export const SEARCH_LIMIT = 50;

export async function searchMealsFor(
    query: string,
): Promise<{ tz: string; meals: Meal[] }> {
    const tz = await getUserTimezone(OWNER_ID);
    const meals = await searchMeals(OWNER_ID, [query], { limit: SEARCH_LIMIT });
    return { tz, meals };
}

export async function loadMeal(
    id: string,
): Promise<{ tz: string; meal: Meal; items: MealItemValues[] } | null> {
    const tz = await getUserTimezone(OWNER_ID);
    const meal = await getMealById(OWNER_ID, id);
    if (!meal) return null;
    const items = (await getMealItems(OWNER_ID, [meal.id])).get(meal.id) ?? [];
    return { tz, meal, items };
}
