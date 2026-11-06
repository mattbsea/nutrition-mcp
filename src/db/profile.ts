/** The single profile row and the nutrition goals (+ effective-dated history). */
import { isWeightUnit, isLengthUnit, toStoredInteger, type WeightUnit, type LengthUnit } from "../units.js";
import { isDrinkUnit, type DrinkUnit } from "../alcohol.js";
import { activityCreditPct } from "../activity.js";
import { ToolError, newErrorRef } from "../errors.js";
import {
    GOAL_COLUMNS,
    pickGoals,
    sameGoals,
    withCurrentGoals,
    type NutritionGoalsHistoryRow,
} from "../goals-history.js";
import { getDb } from "./conn.js";
import { round2, tx, ts, type Row } from "./util.js";
import type { NutritionGoals, NutritionGoalsInput, Profile } from "./types.js";

// ---------- Profile ----------

function profileFromRow(row: Row): Profile {
    return {
        ...(row as unknown as Profile),
        widgets_enabled: Number(row.widgets_enabled) !== 0,
        alcohol_tracking_enabled: Number(row.alcohol_tracking_enabled) !== 0,
    };
}

export async function getProfile(userId: string): Promise<Profile | null> {
    const row = getDb()
        .query("SELECT * FROM profiles WHERE user_id = ?")
        .get(userId) as Row | null;
    return row ? profileFromRow(row) : null;
}

// The timezone the user actually chose with set_timezone, or null if never,
// regardless of whether a profile row exists (a row can exist with it null).
export function timezoneFromProfile(
    profile: Profile | null | undefined,
): string | null {
    return profile?.timezone ?? null;
}

export async function getUserTimezone(userId: string): Promise<string> {
    return timezoneFromProfile(await getProfile(userId)) ?? "UTC";
}

export function localeFromProfile(
    profile: Profile | null | undefined,
): string | null {
    return profile?.locale ?? null;
}

export async function getUserLocale(userId: string): Promise<string> {
    return localeFromProfile(await getProfile(userId)) ?? "en";
}

export function preferredWeightUnitFromProfile(
    profile: Profile | null | undefined,
): WeightUnit | null {
    const unit = profile?.preferred_weight_unit;
    return isWeightUnit(unit) ? unit : null;
}

export async function getPreferredWeightUnit(
    userId: string,
): Promise<WeightUnit | null> {
    return preferredWeightUnitFromProfile(await getProfile(userId));
}

export function preferredLengthUnitFromProfile(
    profile: Profile | null | undefined,
): LengthUnit | null {
    const unit = profile?.preferred_length_unit;
    return isLengthUnit(unit) ? unit : null;
}

export async function getPreferredLengthUnit(
    userId: string,
): Promise<LengthUnit | null> {
    return preferredLengthUnitFromProfile(await getProfile(userId));
}

// Defaults to true when no profile exists: widgets are on until opted out.
export function widgetsEnabledFromProfile(
    profile: Profile | null | undefined,
): boolean {
    return profile?.widgets_enabled ?? true;
}

export async function getWidgetsEnabled(userId: string): Promise<boolean> {
    return widgetsEnabledFromProfile(await getProfile(userId));
}

// Defaults to FALSE: alcohol tracking is opt-in, so the fallback must be off.
export function alcoholTrackingEnabledFromProfile(
    profile: Profile | null | undefined,
): boolean {
    return profile?.alcohol_tracking_enabled ?? false;
}

export async function getAlcoholTrackingEnabled(
    userId: string,
): Promise<boolean> {
    return alcoholTrackingEnabledFromProfile(await getProfile(userId));
}

export function activityCreditPctFromProfile(
    profile: Profile | null | undefined,
): number {
    return activityCreditPct(profile?.activity_credit_pct);
}

export async function getActivityCreditPct(userId: string): Promise<number> {
    return activityCreditPctFromProfile(await getProfile(userId));
}

export function preferredDrinkUnitFromProfile(
    profile: Profile | null | undefined,
): DrinkUnit | null {
    const unit = profile?.preferred_drink_unit;
    return isDrinkUnit(unit) ? unit : null;
}

export async function getPreferredDrinkUnit(
    userId: string,
): Promise<DrinkUnit | null> {
    return preferredDrinkUnitFromProfile(await getProfile(userId));
}

/**
 * Upserts the fields given in `patch`, leaving other columns untouched. On
 * first insert an omitted column falls back to its default (widgets on,
 * alcohol tracking off; everything else NULL = never chosen). `null` is
 * meaningful for the unit preferences and activity_credit_pct (clears them),
 * so only `undefined` is skipped.
 */
export async function upsertProfile(
    userId: string,
    patch: {
        timezone?: string;
        preferred_weight_unit?: WeightUnit | null;
        preferred_length_unit?: LengthUnit | null;
        widgets_enabled?: boolean;
        alcohol_tracking_enabled?: boolean;
        preferred_drink_unit?: DrinkUnit | null;
        activity_credit_pct?: number | null;
        locale?: string;
    },
): Promise<Profile> {
    const cols: Row = { user_id: userId, updated_at: ts() };
    if (patch.timezone !== undefined) cols.timezone = patch.timezone;
    if (patch.preferred_weight_unit !== undefined)
        cols.preferred_weight_unit = patch.preferred_weight_unit;
    if (patch.preferred_length_unit !== undefined)
        cols.preferred_length_unit = patch.preferred_length_unit;
    if (patch.widgets_enabled !== undefined)
        cols.widgets_enabled = patch.widgets_enabled ? 1 : 0;
    if (patch.alcohol_tracking_enabled !== undefined)
        cols.alcohol_tracking_enabled = patch.alcohol_tracking_enabled ? 1 : 0;
    if (patch.preferred_drink_unit !== undefined)
        cols.preferred_drink_unit = patch.preferred_drink_unit;
    if (patch.activity_credit_pct !== undefined)
        cols.activity_credit_pct = patch.activity_credit_pct;
    if (patch.locale !== undefined) cols.locale = patch.locale;

    const names = Object.keys(cols);
    try {
        const row = getDb()
            .query(
                `INSERT INTO profiles (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})
                 ON CONFLICT (user_id) DO UPDATE SET ${names
                     .filter((n) => n !== "user_id")
                     .map((n) => `${n} = excluded.${n}`)
                     .join(", ")}
                 RETURNING *`,
            )
            .get(...(Object.values(cols) as never[])) as Row;
        return profileFromRow(row);
    } catch (error) {
        throw new Error(
            `Failed to save profile: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

// ---------- Nutrition goals ----------

function goalsFromRow(row: Row): NutritionGoals {
    return row as unknown as NutritionGoals;
}

export async function getNutritionGoals(
    userId: string,
): Promise<NutritionGoals | null> {
    const row = getDb()
        .query("SELECT * FROM nutrition_goals WHERE user_id = ?")
        .get(userId) as Row | null;
    return row ? goalsFromRow(row) : null;
}

const gram = (v: number | null | undefined): number | null =>
    v == null ? null : round2(v);
const wholeNumber = (v: number | null | undefined): number | null =>
    v == null ? null : toStoredInteger(v);

/**
 * Replaces the goals row wholesale (a goal not given becomes NULL, as the
 * upstream upsert did) and records the change in the history. daily_calories
 * and daily_water_ml are integers; the gram/mg targets are rounded to 2
 * decimals like Postgres numeric(6,2)/(7,2).
 */
export async function upsertNutritionGoals(
    userId: string,
    input: NutritionGoalsInput,
): Promise<NutritionGoals> {
    const db = getDb();
    // The row as it was before this save, so recordGoalsHistory can date a
    // change history missed at the time it was actually made.
    const prior = await getNutritionGoals(userId);

    const cols: Row = {
        user_id: userId,
        daily_calories: wholeNumber(input.daily_calories),
        daily_protein_g: gram(input.daily_protein_g),
        daily_carbs_g: gram(input.daily_carbs_g),
        daily_fat_g: gram(input.daily_fat_g),
        daily_saturated_fat_g: gram(input.daily_saturated_fat_g),
        daily_fiber_g: gram(input.daily_fiber_g),
        daily_sugar_g: gram(input.daily_sugar_g),
        daily_added_sugar_g: gram(input.daily_added_sugar_g),
        daily_alcohol_g: gram(input.daily_alcohol_g),
        daily_caffeine_mg: gram(input.daily_caffeine_mg),
        daily_sodium_mg: gram(input.daily_sodium_mg),
        daily_water_ml: wholeNumber(input.daily_water_ml),
        target_weight_g: input.target_weight_g ?? null,
        updated_at: ts(),
    };
    const names = Object.keys(cols);
    let saved: NutritionGoals;
    try {
        saved = goalsFromRow(
            db
                .query(
                    `INSERT INTO nutrition_goals (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})
                     ON CONFLICT (user_id) DO UPDATE SET ${names
                         .filter((n) => n !== "user_id")
                         .map((n) => `${n} = excluded.${n}`)
                         .join(", ")}
                     RETURNING *`,
                )
                .get(...(Object.values(cols) as never[])) as Row,
        );
    } catch (error) {
        throw new Error(
            `Failed to save goals: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    recordGoalsHistory(userId, prior, saved);
    return saved;
}

const HISTORY_INSERT = `INSERT INTO nutrition_goals_history (user_id, effective_at, ${GOAL_COLUMNS.join(", ")}) VALUES (?, ?, ${GOAL_COLUMNS.map(() => "?").join(", ")})`;

/**
 * Brings `nutrition_goals_history` up to date with this save: first any change
 * history missed (prior row differs from the latest history row), dated to the
 * prior row's own updated_at, then the goals just saved, dated to this save.
 * Both inserts commit together. A failure throws after the goal was saved; the
 * message says so and that repeating the call heals the history.
 */
function recordGoalsHistory(
    userId: string,
    prior: NutritionGoals | null,
    saved: NutritionGoals,
): void {
    const goals = pickGoals(saved as unknown as Row);
    try {
        tx((db) => {
            const latest = db
                .query(
                    `SELECT effective_at, ${GOAL_COLUMNS.join(", ")} FROM nutrition_goals_history WHERE user_id = ? ORDER BY effective_at DESC, id DESC LIMIT 1`,
                )
                .get(userId) as Row | null;
            let tail = latest ? pickGoals(latest) : null;

            if (prior) {
                const priorGoals = pickGoals(prior as unknown as Row);
                const priorAt = Date.parse(prior.updated_at);
                const latestAt = latest
                    ? Date.parse(String(latest.effective_at))
                    : Number.NEGATIVE_INFINITY;
                if (
                    !(tail && sameGoals(tail, priorGoals)) &&
                    Number.isFinite(priorAt) &&
                    priorAt > latestAt
                ) {
                    db.query(HISTORY_INSERT).run(
                        userId,
                        prior.updated_at,
                        ...(GOAL_COLUMNS.map((c) => priorGoals[c] ?? null) as never[]),
                    );
                    tail = priorGoals;
                }
            }
            if (tail && sameGoals(tail, goals)) return;
            db.query(HISTORY_INSERT).run(
                userId,
                saved.updated_at,
                ...(GOAL_COLUMNS.map((c) => goals[c] ?? null) as never[]),
            );
        });
    } catch (err) {
        const ref = newErrorRef();
        console.warn(
            `[goals-history] record failed ref=${ref}: ${JSON.stringify((err instanceof Error ? err.message : String(err)).slice(0, 500))}`,
        );
        throw new ToolError(
            `Failed to record this change in the goals history (ref ${ref}). The new goals themselves were saved. Calling set_nutrition_goals again with the same values records the change, dated to when it was saved; it does not save anything twice.`,
        );
    }
}

/**
 * The stored `nutrition_goals_history` rows, oldest first (effective_at, then
 * id), as goalsOnDate expects.
 */
function getStoredGoalsHistory(userId: string): NutritionGoalsHistoryRow[] {
    const rows = getDb()
        .query(
            `SELECT id, effective_at, ${GOAL_COLUMNS.join(", ")} FROM nutrition_goals_history WHERE user_id = ? ORDER BY effective_at ASC, id ASC`,
        )
        .all(userId) as Row[];
    return rows.map((r) => ({
        effective_at: new Date(String(r.effective_at)).toISOString(),
        ...pickGoals(r),
    }));
}

/** Every change to the goals, oldest first: the stored history plus, via
 *  withCurrentGoals, a change the current row holds that history does not. */
export async function getNutritionGoalsHistory(
    userId: string,
): Promise<NutritionGoalsHistoryRow[]> {
    return withCurrentGoals(
        getStoredGoalsHistory(userId),
        await getNutritionGoals(userId),
    );
}
