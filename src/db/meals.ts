/**
 * Logged meals and their ingredient rows. SQLite port of the meal half of
 * src/supabase.ts, including the insert_meal_with_items / update_meal_with_items
 * RPCs (now explicit transactions). Every statement carries `user_id = ?`.
 */
import { zonedDayStartUtc, zonedNextDayStartUtc } from "../tz.js";
import { decodeEscapeSequences } from "../normalize.js";
import { toStoredInteger } from "../units.js";
import { escapeLikePattern, tokenizeQuery } from "../search.js";
import type { MealItemValues, MealNutrientKey } from "../meal-items.js";
import { ToolError } from "../errors.js";
import { getDb } from "./conn.js";
import {
    canonicalJson,
    chunks,
    fromJson,
    isUniqueViolation,
    likeAll,
    marks,
    toJson,
    ts,
    tx,
    type Row,
} from "./util.js";
import {
    NUTRIENT_KEYS,
    deriveIdempotencyKey,
    insertItems,
    isUuid,
    itemsByParent,
    withProvenance,
} from "./shared.js";
import type {
    Meal,
    MealFieldUpdate,
    MealInput,
    MealInsertResult,
    MealItemRow,
    MealSnapshotGuard,
} from "./types.js";

// ---------- Idempotency ----------

/**
 * The server-derived idempotency key for a meal write, over the resolved
 * logged_at. DO NOT ADD FIELDS TO THE DIGEST (see the warning in
 * src/supabase.ts mealIdempotencyKey, which this mirrors byte for byte):
 * appending one changes every derived key and turns a clean no-op re-log into
 * a duplicate row.
 */
export function mealIdempotencyKey(
    userId: string,
    input: MealInput,
    loggedAt: string,
): string {
    return deriveIdempotencyKey([
        userId,
        input.description,
        input.meal_type,
        input.calories,
        input.protein_g,
        input.carbs_g,
        input.fat_g,
        input.notes,
        loggedAt,
    ]);
}

/**
 * The idempotency key updateMeal should persist for `fields` applied on top of
 * `existing`, or null when the row's current key must be left alone (a
 * caller-supplied key is never overridden; only "auto:" keys are recomputed).
 */
export function updatedMealIdempotencyKey(
    userId: string,
    existing: Meal,
    fields: Partial<MealInput>,
): string | null {
    if (!existing.idempotency_key?.startsWith("auto:")) return null;
    const merged: MealInput = {
        description: fields.description ?? existing.description,
        meal_type:
            (fields.meal_type as MealInput["meal_type"] | undefined) ??
            (existing.meal_type as MealInput["meal_type"]),
        calories:
            fields.calories !== undefined
                ? toStoredInteger(fields.calories)
                : (existing.calories ?? undefined),
        protein_g: fields.protein_g ?? existing.protein_g ?? undefined,
        carbs_g: fields.carbs_g ?? existing.carbs_g ?? undefined,
        fat_g: fields.fat_g ?? existing.fat_g ?? undefined,
        notes: fields.notes ?? existing.notes ?? undefined,
    };
    // Re-serialise through Date so a stored instant hashes in the one form
    // every write path hashes (toISOString).
    const loggedAt =
        fields.logged_at ?? new Date(existing.logged_at).toISOString();
    return mealIdempotencyKey(userId, merged, loggedAt);
}

// ---------- Row mapping ----------

export function mealFromRow(row: Row): Meal {
    const out: Row = { ...row };
    out.nutrient_sources = fromJson(row.nutrient_sources);
    out.source_detail = fromJson(row.source_detail);
    return out as unknown as Meal;
}

const mealOf = (row: unknown): Meal => mealFromRow(row as Row);

// ---------- Insert ----------

/** Column -> value for a new meals row (everything but id/user_id). */
function mealColumns(
    meal: MealInput,
    loggedAt: string,
    idempotencyKey: string,
): Row {
    return {
        logged_at: ts(loggedAt),
        meal_type: meal.meal_type ?? null,
        description: decodeEscapeSequences(meal.description),
        calories: meal.calories ?? null,
        protein_g: meal.protein_g ?? null,
        carbs_g: meal.carbs_g ?? null,
        fat_g: meal.fat_g ?? null,
        saturated_fat_g: meal.saturated_fat_g ?? null,
        trans_fat_g: meal.trans_fat_g ?? null,
        fiber_g: meal.fiber_g ?? null,
        sugar_g: meal.sugar_g ?? null,
        added_sugar_g: meal.added_sugar_g ?? null,
        alcohol_g: meal.alcohol_g ?? null,
        caffeine_mg: meal.caffeine_mg ?? null,
        sodium_mg: meal.sodium_mg ?? null,
        notes: meal.notes != null ? decodeEscapeSequences(meal.notes) : null,
        idempotency_key: idempotencyKey,
        saved_meal_id: meal.saved_meal_id ?? null,
        nutrient_sources: toJson(meal.nutrient_sources),
        source_detail: toJson(meal.source_detail),
    };
}

/**
 * Logs a meal (and its ingredients, and/or the saved meal it came from) in one
 * transaction. An existing row with the same idempotency key is returned with
 * `deduplicated: true` and nothing is written (items included).
 */
export async function insertMeal(
    userId: string,
    input: MealInput,
): Promise<MealInsertResult> {
    // calories is an integer column: round before anything reads the input,
    // the digest included, or a re-log would derive its key from 388.54 while
    // the stored row said 389.
    const meal: MealInput =
        input.calories == null
            ? input
            : { ...input, calories: toStoredInteger(input.calories) };
    const loggedAt = meal.logged_at ?? new Date().toISOString();
    const idempotencyKey =
        meal.idempotency_key ?? mealIdempotencyKey(userId, meal, loggedAt);

    try {
        return tx((db) => {
            const existing = db
                .query(
                    "SELECT * FROM meals WHERE user_id = ? AND idempotency_key = ?",
                )
                .get(userId, idempotencyKey);
            if (existing) {
                return { meal: mealOf(existing), deduplicated: true };
            }
            if (meal.saved_meal_id) {
                // The FK only proves the id exists; also require it be this
                // owner's. Same message the FK failure produced upstream.
                const owned = db
                    .query(
                        "SELECT 1 AS ok FROM saved_meals WHERE id = ? AND user_id = ?",
                    )
                    .get(meal.saved_meal_id, userId);
                if (!owned) {
                    throw new ToolError(
                        `No saved meal found with id ${meal.saved_meal_id}; it may have just been deleted.`,
                    );
                }
            }
            const cols = mealColumns(meal, loggedAt, idempotencyKey);
            const names = ["user_id", ...Object.keys(cols)];
            const row = db
                .query(
                    `INSERT INTO meals (${names.join(", ")}) VALUES (${marks(names.length)}) RETURNING *`,
                )
                .get(userId, ...(Object.values(cols) as never[]));
            const inserted = mealOf(row);
            insertItems(db, "meal_items", "meal_id", inserted.id, userId, meal.items ?? []);
            return { meal: inserted, deduplicated: false };
        });
    } catch (error) {
        if (error instanceof ToolError) throw error;
        if (isUniqueViolation(error)) {
            // Cannot normally happen (the lookup above ran in the same write
            // transaction), but resolve it the way the race path always did.
            const raced = getDb()
                .query("SELECT * FROM meals WHERE user_id = ? AND idempotency_key = ?")
                .get(userId, idempotencyKey);
            if (raced) return { meal: mealOf(raced), deduplicated: true };
        }
        throw new Error(
            `Failed to insert meal: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

// ---------- Windowed / bulk reads ----------

export async function getMealsByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<Meal[]> {
    return getMealsInRange(userId, date, date, tz);
}

export async function getMealsInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<Meal[]> {
    return selectLoggedWindow(
        "meals",
        userId,
        zonedDayStartUtc(startDate, tz),
        zonedNextDayStartUtc(endDate, tz),
    ).map(mealOf);
}

/**
 * Every row of `table` with start <= logged_at < end, oldest first, `id` as the
 * tie-break (date-only imports share one logged_at). One query: unlike
 * PostgREST there is no row cap to page around.
 */
export function selectLoggedWindow(
    table:
        | "meals"
        | "water_log"
        | "weight_log"
        | "body_measurement_log"
        | "active_calories_log",
    userId: string,
    startUtc: Date,
    endUtc: Date,
    filter?: { kind: string },
): Row[] {
    const extra = filter ? " AND kind = ?" : "";
    const params: unknown[] = [userId, startUtc.toISOString(), endUtc.toISOString()];
    if (filter) params.push(filter.kind);
    return getDb()
        .query(
            `SELECT * FROM ${table} WHERE user_id = ? AND logged_at >= ? AND logged_at < ?${extra} ORDER BY logged_at ASC, id ASC`,
        )
        .all(...(params as never[])) as Row[];
}

/** Whether any meal is logged before local `date` in `tz`. */
export async function hasMealsBefore(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<boolean> {
    const row = getDb()
        .query("SELECT 1 AS ok FROM meals WHERE user_id = ? AND logged_at < ? LIMIT 1")
        .get(userId, zonedDayStartUtc(date, tz).toISOString());
    return row != null;
}

export async function countMeals(userId: string): Promise<number> {
    const row = getDb()
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM meals WHERE user_id = ?")
        .get(userId);
    return row?.n ?? 0;
}

/** Which of `keys` are already present as idempotency keys. */
export async function existingIdempotencyKeys(
    userId: string,
    keys: string[],
): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunks([...new Set(keys)], 500)) {
        const rows = getDb()
            .query<{ idempotency_key: string }, string[]>(
                `SELECT idempotency_key FROM meals WHERE user_id = ? AND idempotency_key IN (${marks(chunk.length)})`,
            )
            .all(userId, ...chunk);
        for (const r of rows) found.add(r.idempotency_key);
    }
    return found;
}

/** Which of `ids` are meals this owner has (lower-cased). */
export async function existingMealIds(
    userId: string,
    ids: string[],
): Promise<Set<string>> {
    const found = new Set<string>();
    const uuids = [...new Set(ids.filter(isUuid).map((i) => i.toLowerCase()))];
    for (const chunk of chunks(uuids, 500)) {
        const rows = getDb()
            .query<{ id: string }, string[]>(
                `SELECT id FROM meals WHERE user_id = ? AND id IN (${marks(chunk.length)})`,
            )
            .all(userId, ...chunk);
        for (const r of rows) found.add(r.id.toLowerCase());
    }
    return found;
}

/** All meals, oldest first (export). */
export async function getAllMeals(userId: string): Promise<Meal[]> {
    return (
        getDb()
            .query("SELECT * FROM meals WHERE user_id = ? ORDER BY logged_at ASC, id ASC")
            .all(userId) as Row[]
    )
        .map(mealOf)
        .map(withProvenance);
}

export async function getMealById(
    userId: string,
    id: string,
): Promise<Meal | null> {
    if (!isUuid(id)) return null;
    const row = getDb()
        .query("SELECT * FROM meals WHERE id = ? AND user_id = ?")
        .get(id, userId);
    return row ? mealOf(row) : null;
}

// ---------- Search ----------

/**
 * Keyword search over past meals. Each query string is an alternative (OR'd
 * across); within one alternative every word token must match (AND'd) the
 * description, the notes, or one single ingredient name. Case-insensitive for
 * all of Unicode (ulower), newest first.
 */
export async function searchMeals(
    userId: string,
    queries: string[],
    opts: { limit?: number; sinceIso?: string } = {},
): Promise<Meal[]> {
    const limit = opts.limit ?? 50;
    const tokenized = queries.map(tokenizeQuery).filter((t) => t.length > 0);
    if (tokenized.length === 0) return [];

    const since = opts.sinceIso ? " AND logged_at >= ?" : "";
    const run = (cond: string, condParams: unknown[]): Row[] =>
        getDb()
            .query(
                `SELECT * FROM meals WHERE user_id = ?${since} AND ${cond} ORDER BY logged_at DESC LIMIT ?`,
            )
            .all(
                ...([userId, ...(opts.sinceIso ? [ts(opts.sinceIso)] : []), ...condParams, limit] as never[]),
            ) as Row[];

    const results: Row[][] = [];
    for (const tokens of tokenized) {
        for (const column of ["description", "notes"]) {
            const m = likeAll(column, tokens, escapeLikePattern);
            results.push(run(m.sql, m.params));
        }
        // One ingredient has to hold every token.
        const item = likeAll("i.name", tokens, escapeLikePattern);
        results.push(
            run(
                `EXISTS (SELECT 1 FROM meal_items i WHERE i.meal_id = meals.id AND i.user_id = meals.user_id AND ${item.sql})`,
                item.params,
            ),
        );
    }

    const seen = new Set<string>();
    const merged: Meal[] = [];
    for (const rows of results) {
        for (const row of rows) {
            const meal = mealOf(row);
            if (!seen.has(meal.id)) {
                seen.add(meal.id);
                merged.push(meal);
            }
        }
    }
    merged.sort((a, b) => b.logged_at.localeCompare(a.logged_at));
    return merged.slice(0, limit);
}

// ---------- Delete ----------

/** True when a row matched and was deleted (its items cascade). */
export async function deleteMeal(userId: string, id: string): Promise<boolean> {
    const res = getDb()
        .query("DELETE FROM meals WHERE id = ? AND user_id = ?")
        .run(id, userId);
    return res.changes > 0;
}

// ---------- Update ----------

/** A guarded write found its row, but the row no longer holds the snapshot. */
export class SnapshotConflictError extends Error {
    override name = "SnapshotConflictError";
    constructor(readonly rowId: string) {
        super(`row ${rowId} changed since it was read`);
    }
}

/** The snapshot of one row as a guard: all twelve nutrient columns and both
 *  label columns, with a missing column read as null. */
export function snapshotGuardOf(
    row: {
        nutrient_sources?: unknown;
        source_detail?: unknown;
    } & Partial<Record<MealNutrientKey, number | null>>,
): MealSnapshotGuard {
    const guard: MealSnapshotGuard = {
        nutrient_sources: row.nutrient_sources ?? null,
        source_detail: row.source_detail ?? null,
    };
    for (const key of NUTRIENT_KEYS) guard[key] = row[key] ?? null;
    return guard;
}

/** Whether a (JSON-parsed) stored row still equals `guard`. null = IS NULL,
 *  objects compare as JSON ignoring key order, numbers numerically. */
export function guardMatches(row: Row, guard: MealSnapshotGuard): boolean {
    for (const [column, expected] of Object.entries(guard)) {
        if (expected === undefined) continue;
        const actual = row[column];
        if (expected === null) {
            if (actual != null) return false;
        } else if (typeof expected === "object") {
            if (actual == null || canonicalJson(actual) !== canonicalJson(expected))
                return false;
        } else if (actual == null || Number(actual) !== expected) {
            return false;
        }
    }
    return true;
}

/** Builds the `column -> value` map of changed meal columns. */
function mealUpdateColumns(fields: MealFieldUpdate, nullableCalories: boolean): Row {
    const update: Row = {};
    if (fields.description !== undefined)
        update.description = decodeEscapeSequences(fields.description);
    if (fields.meal_type !== undefined) update.meal_type = fields.meal_type;
    if (fields.calories !== undefined)
        update.calories =
            fields.calories == null
                ? nullableCalories
                    ? null
                    : fields.calories
                : toStoredInteger(fields.calories);
    for (const key of NUTRIENT_KEYS) {
        if (key === "calories" || fields[key] === undefined) continue;
        update[key] = fields[key];
    }
    if (fields.nutrient_sources !== undefined)
        update.nutrient_sources = toJson(fields.nutrient_sources);
    if (fields.source_detail !== undefined)
        update.source_detail = toJson(fields.source_detail);
    if (fields.logged_at !== undefined) update.logged_at = ts(fields.logged_at);
    if (fields.notes !== undefined)
        update.notes =
            fields.notes != null ? decodeEscapeSequences(fields.notes) : null;
    return update;
}

/** UPDATE meals SET <update> WHERE id AND user RETURNING * (the column names
 *  come from mealUpdateColumns' fixed set, never from input). */
function applyMealUpdate(
    db: ReturnType<typeof getDb>,
    userId: string,
    id: string,
    update: Row,
): Meal | null {
    const names = Object.keys(update);
    if (names.length === 0) {
        const row = db
            .query("SELECT * FROM meals WHERE id = ? AND user_id = ?")
            .get(id, userId);
        return row ? mealOf(row) : null;
    }
    const row = db
        .query(
            `UPDATE meals SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ? AND user_id = ? RETURNING *`,
        )
        .get(...(Object.values(update) as never[]), id, userId);
    return row ? mealOf(row) : null;
}

/**
 * Updates a logged meal. With `guard`, the write lands only while the row
 * still holds that snapshot; otherwise SnapshotConflictError and nothing is
 * written. (Compared inside the write transaction, so the check and the write
 * cannot be separated by another writer.)
 */
export async function updateMeal(
    userId: string,
    id: string,
    fields: Partial<MealInput>,
    guard?: MealSnapshotGuard,
): Promise<Meal> {
    try {
        return tx((db) => {
            const existingRow = db
                .query("SELECT * FROM meals WHERE id = ? AND user_id = ?")
                .get(id, userId);
            if (!existingRow) throw new ToolError(`No meal found with id ${id}.`);
            const existing = mealOf(existingRow);
            if (guard && !guardMatches(existing as unknown as Row, guard))
                throw new SnapshotConflictError(id);

            const update = mealUpdateColumns(fields as MealFieldUpdate, false);
            const newKey = updatedMealIdempotencyKey(userId, existing, fields);
            if (newKey !== null) update.idempotency_key = newKey;
            const row = applyMealUpdate(db, userId, id, update);
            if (!row) throw new ToolError(`No meal found with id ${id}.`);
            return row;
        });
    } catch (error) {
        if (error instanceof ToolError || error instanceof SnapshotConflictError)
            throw error;
        throw new Error(
            `Failed to update meal: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

// ---------- Ingredients ----------

/** Ingredients of logged meals, grouped by meal id, in position order. */
export function getMealItems(
    userId: string,
    mealIds: string[],
): Promise<Map<string, MealItemValues[]>> {
    return Promise.resolve(itemsByParent("meal_items", "meal_id", userId, mealIds));
}

export async function countMealItems(
    userId: string,
    mealId: string,
): Promise<number> {
    const row = getDb()
        .query<{ n: number }, [string, string]>(
            "SELECT count(*) AS n FROM meal_items WHERE user_id = ? AND meal_id = ?",
        )
        .get(userId, mealId);
    return row?.n ?? 0;
}

/**
 * Replaces a logged meal's ingredients and the meal fields in one transaction
 * (update_meal_with_items). `fields` holds the summed totals plus any other
 * changed field; null clears a column. The idempotency key is recomputed
 * exactly as updateMeal does.
 */
export async function replaceMealItems(
    userId: string,
    id: string,
    fields: MealFieldUpdate,
    items: MealItemValues[],
): Promise<Meal> {
    try {
        return tx((db) => {
            const existingRow = db
                .query("SELECT * FROM meals WHERE id = ? AND user_id = ?")
                .get(id, userId);
            if (!existingRow) throw new ToolError(`No meal found with id ${id}.`);
            const existing = mealOf(existingRow);

            const update = mealUpdateColumns(fields, true);
            const newKey = updatedMealIdempotencyKey(
                userId,
                existing,
                fields as Partial<MealInput>,
            );
            if (newKey !== null) update.idempotency_key = newKey;
            const row = applyMealUpdate(db, userId, id, update);
            if (!row) throw new ToolError(`No meal found with id ${id}.`);

            db.query("DELETE FROM meal_items WHERE meal_id = ? AND user_id = ?").run(id, userId);
            insertItems(db, "meal_items", "meal_id", id, userId, items);
            return row;
        });
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new Error(
            `Failed to update meal: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** Every logged-meal ingredient, in meal then position order (export). */
export function getAllMealItems(userId: string): Promise<MealItemRow[]> {
    const rows = getDb()
        .query(
            "SELECT * FROM meal_items WHERE user_id = ? ORDER BY meal_id ASC, position ASC, id ASC",
        )
        .all(userId) as Row[];
    return Promise.resolve(
        rows.map((r) =>
            withProvenance({
                ...r,
                nutrient_sources: fromJson(r.nutrient_sources),
                source_detail: fromJson(r.source_detail),
            }),
        ) as unknown as MealItemRow[],
    );
}
