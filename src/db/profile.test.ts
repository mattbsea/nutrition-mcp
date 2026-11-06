import { describe, expect, test } from "bun:test";
import { ToolError } from "../errors.js";
import { getDb } from "./conn.js";
import {
    getActivityCreditPct,
    getAlcoholTrackingEnabled,
    getNutritionGoals,
    getNutritionGoalsHistory,
    getPreferredDrinkUnit,
    getPreferredLengthUnit,
    getPreferredWeightUnit,
    getProfile,
    getUserLocale,
    getUserTimezone,
    getWidgetsEnabled,
    upsertNutritionGoals,
    upsertProfile,
} from "./repo.js";
import { OTHER, USER, useMemoryDb } from "./test-helpers.js";

useMemoryDb();

describe("profile defaults (no row)", () => {
    test("every reader falls back as upstream does", async () => {
        expect(await getProfile(USER)).toBeNull();
        expect(await getUserTimezone(USER)).toBe("UTC");
        expect(await getUserLocale(USER)).toBe("en");
        expect(await getWidgetsEnabled(USER)).toBe(true);
        expect(await getAlcoholTrackingEnabled(USER)).toBe(false);
        expect(await getPreferredWeightUnit(USER)).toBeNull();
        expect(await getPreferredLengthUnit(USER)).toBeNull();
        expect(await getPreferredDrinkUnit(USER)).toBeNull();
        expect(await getActivityCreditPct(USER)).toBe(100);
    });
});

describe("upsertProfile", () => {
    test("first insert: omitted columns take defaults, 'never chosen' stays null", async () => {
        const p = await upsertProfile(USER, { preferred_weight_unit: "lb" });
        expect(p).toMatchObject({
            user_id: USER,
            timezone: null,
            locale: null,
            preferred_weight_unit: "lb",
            preferred_length_unit: null,
            preferred_drink_unit: null,
            activity_credit_pct: null,
            widgets_enabled: true,
            alcohol_tracking_enabled: false,
        });
        expect(typeof p.created_at).toBe("string");
        // A row can exist while the timezone was never chosen (issue #99).
        expect(await getUserTimezone(USER)).toBe("UTC");
    });

    test("later patches change only what is given; null clears; booleans round-trip", async () => {
        const first = await upsertProfile(USER, { timezone: "America/Denver", locale: "fr", activity_credit_pct: 50 });
        await Bun.sleep(5);
        const second = await upsertProfile(USER, {
            widgets_enabled: false,
            alcohol_tracking_enabled: true,
            preferred_drink_unit: "uk",
            preferred_length_unit: "in",
            activity_credit_pct: null,
        });
        expect(second).toMatchObject({
            timezone: "America/Denver",
            locale: "fr",
            widgets_enabled: false,
            alcohol_tracking_enabled: true,
            preferred_drink_unit: "uk",
            preferred_length_unit: "in",
            activity_credit_pct: null,
        });
        expect(second.created_at).toBe(first.created_at);
        expect(second.updated_at > first.updated_at).toBe(true);
        expect(await getWidgetsEnabled(USER)).toBe(false);
        expect(await getAlcoholTrackingEnabled(USER)).toBe(true);
        expect(await getUserTimezone(USER)).toBe("America/Denver");
        expect(await getActivityCreditPct(USER)).toBe(100);
        expect(getDb().query("SELECT count(*) n FROM profiles").get()).toEqual({ n: 1 });
    });

    test("rejects out-of-domain values at the database", async () => {
        await expect(upsertProfile(USER, { preferred_weight_unit: "stone" as never })).rejects.toThrow(/Failed to save profile/);
        await expect(upsertProfile(USER, { activity_credit_pct: 101 })).rejects.toThrow(/Failed to save profile/);
    });

    test("another owner's profile is invisible", async () => {
        await upsertProfile(OTHER, { timezone: "Asia/Tokyo" });
        expect(await getProfile(USER)).toBeNull();
        expect(await getUserTimezone(USER)).toBe("UTC");
    });
});

describe("nutrition goals", () => {
    test("upsert replaces the row wholesale (omitted goals become null) and rounds", async () => {
        await upsertNutritionGoals(USER, { daily_calories: 2000, daily_protein_g: 150.456, daily_fiber_g: 30 });
        const saved = await upsertNutritionGoals(USER, { daily_calories: 2100.4, daily_protein_g: 150.455, daily_sodium_mg: 2300 });
        expect(saved).toMatchObject({
            user_id: USER,
            daily_calories: 2100,
            daily_protein_g: 150.46,
            daily_fiber_g: null,
            daily_sodium_mg: 2300,
        });
        expect(await getNutritionGoals(USER)).toEqual(saved);
        expect(getDb().query("SELECT count(*) n FROM nutrition_goals").get()).toEqual({ n: 1 });
    });

    test("rejects a negative ceiling or non-positive target weight", async () => {
        await expect(upsertNutritionGoals(USER, { daily_sugar_g: -1 })).rejects.toThrow(/Failed to save goals/);
        await expect(upsertNutritionGoals(USER, { target_weight_g: 0 })).rejects.toThrow(/Failed to save goals/);
    });

    test("a zero ceiling is a real limit, not 'unset'", async () => {
        const saved = await upsertNutritionGoals(USER, { daily_alcohol_g: 0, daily_sodium_mg: 0 });
        expect(saved.daily_alcohol_g).toBe(0);
        expect(saved.daily_sodium_mg).toBe(0);
    });
});

describe("goals history (effective-dated)", () => {
    const history = () => getNutritionGoalsHistory(USER);
    const rowCount = () =>
        (getDb().query("SELECT count(*) n FROM nutrition_goals_history").get() as { n: number }).n;

    test("no goals, no history", async () => {
        expect(await history()).toEqual([]);
    });

    test("the first save records one history row at the save's instant", async () => {
        const saved = await upsertNutritionGoals(USER, { daily_calories: 2000 });
        const h = await history();
        expect(h).toHaveLength(1);
        expect(h[0]).toMatchObject({ daily_calories: 2000, effective_at: new Date(saved.updated_at).toISOString() });
    });

    test("saving the same values again adds nothing", async () => {
        await upsertNutritionGoals(USER, { daily_calories: 2000, daily_protein_g: 120 });
        await Bun.sleep(3);
        await upsertNutritionGoals(USER, { daily_calories: 2000, daily_protein_g: 120 });
        expect(rowCount()).toBe(1);
    });

    test("a change appends a row; history stays oldest first with both values", async () => {
        await upsertNutritionGoals(USER, { daily_calories: 2000 });
        await Bun.sleep(3);
        await upsertNutritionGoals(USER, { daily_calories: 1800 });
        const h = await history();
        expect(h.map((r) => r.daily_calories)).toEqual([2000, 1800]);
        expect(h[0]!.effective_at < h[1]!.effective_at).toBe(true);
    });

    test("a goal row written without history is merged on read, then backfilled by the next save at its own date", async () => {
        const at = "2026-01-01T00:00:00.000Z";
        getDb()
            .query("INSERT INTO nutrition_goals (user_id, daily_calories, updated_at) VALUES (?, 1900, ?)")
            .run(USER, at);
        expect(await history()).toEqual([expect.objectContaining({ daily_calories: 1900, effective_at: at })]);
        await upsertNutritionGoals(USER, { daily_calories: 1700 });
        const h = await history();
        expect(h.map((r) => [r.daily_calories, r.effective_at === at])).toEqual([
            [1900, true],
            [1700, false],
        ]);
    });

    test("a failing history write is a ToolError, but the goals were saved and a retry heals it", async () => {
        const db = getDb();
        db.exec("ALTER TABLE nutrition_goals_history RENAME TO hist_hidden");
        const err = await upsertNutritionGoals(USER, { daily_calories: 2222 }).catch((e) => e);
        expect(err).toBeInstanceOf(ToolError);
        expect(String(err.message)).toContain("The new goals themselves were saved");
        expect((await getNutritionGoals(USER))!.daily_calories).toBe(2222);
        db.exec("ALTER TABLE hist_hidden RENAME TO nutrition_goals_history");
        await upsertNutritionGoals(USER, { daily_calories: 2222 });
        expect((await history()).map((r) => r.daily_calories)).toEqual([2222]);
    });

    test("history of another owner is invisible", async () => {
        await upsertNutritionGoals(OTHER, { daily_calories: 3000 });
        expect(await history()).toEqual([]);
        expect(await getNutritionGoals(USER)).toBeNull();
    });
});
