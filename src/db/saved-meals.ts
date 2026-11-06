/**
 * Saved meals (reusable named meals) and their ingredients. SQLite port of the
 * saved-meal half of src/supabase.ts, including the insert_saved_meal /
 * update_saved_meal RPCs as explicit transactions.
 */
import { decodeEscapeSequences } from "../normalize.js";
import { toStoredInteger } from "../units.js";
import {
    escapeLikePattern,
    tokenizeQuery,
    type SavedMealSummary,
} from "../search.js";
import { MAX_SAVED_MEALS_PER_USER, type MealItemValues } from "../meal-items.js";
import { getDb } from "./conn.js";
import {
    fromJson,
    isUniqueViolation,
    likeAll,
    toJson,
    tx,
    ts,
    type Row,
} from "./util.js";
import {
    NUTRIENT_KEYS,
    insertItems,
    isUuid,
    itemsByParent,
    nutrientsFromRow,
    provenanceFromRow,
    withProvenance,
} from "./shared.js";
import { SnapshotConflictError, guardMatches } from "./meals.js";
import type {
    MealSnapshotGuard,
    SavedMeal,
    SavedMealInput,
    SavedMealItemRow,
    SavedMealWithItems,
} from "./types.js";

/** A saved meal with this name already exists for the user (case-insensitive).
 *  `existingId` names it so the caller can point at it. */
export class SavedMealNameTaken extends Error {
    readonly existingId: string | null;

    constructor(existingId: string | null) {
        super("A saved meal with this name already exists.");
        this.name = "SavedMealNameTaken";
        this.existingId = existingId;
    }
}

export function savedMealFromRow(row: Row): SavedMeal {
    return {
        id: String(row.id),
        user_id: String(row.user_id),
        name: String(row.name),
        description: String(row.description),
        meal_type: row.meal_type == null ? null : String(row.meal_type),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        ...nutrientsFromRow(row),
        ...provenanceFromRow({
            nutrient_sources: fromJson(row.nutrient_sources),
            source_detail: fromJson(row.source_detail),
        }),
    };
}

/** Column -> value of the keys PRESENT in the input (so an update leaves the
 *  others alone; a present null clears its column). name_key follows name. */
function savedMealColumns(input: Partial<SavedMealInput>): Row {
    const out: Row = {};
    if (input.name !== undefined) {
        out.name = input.name;
        out.name_key = input.name.toLowerCase();
    }
    if (input.description !== undefined)
        out.description = decodeEscapeSequences(input.description);
    if (input.meal_type !== undefined) out.meal_type = input.meal_type;
    for (const key of NUTRIENT_KEYS) {
        const value = input[key];
        if (value === undefined) continue;
        out[key] =
            value === null
                ? null
                : key === "calories"
                  ? toStoredInteger(value)
                  : value;
    }
    if (input.nutrient_sources !== undefined)
        out.nutrient_sources = toJson(input.nutrient_sources);
    if (input.source_detail !== undefined)
        out.source_detail = toJson(input.source_detail);
    return out;
}

function savedMealIdByName(userId: string, name: string | undefined): string | null {
    const wanted = name?.trim();
    if (!wanted) return null;
    const row = getDb()
        .query<{ id: string }, [string, string]>(
            "SELECT id FROM saved_meals WHERE user_id = ? AND name_key = ?",
        )
        .get(userId, wanted.toLowerCase());
    return row?.id ?? null;
}

/** Attaches each saved meal's items, then orders by name (case-insensitive). */
function withItems(userId: string, saved: SavedMeal[]): SavedMealWithItems[] {
    const items = itemsByParent(
        "saved_meal_items",
        "saved_meal_id",
        userId,
        saved.map((s) => s.id),
    );
    return saved
        .map((s) => ({ ...s, items: items.get(s.id) ?? [] }))
        .sort((a, b) => {
            const x = a.name.toLowerCase();
            const y = b.name.toLowerCase();
            return x < y ? -1 : x > y ? 1 : 0;
        });
}

/** Creates a saved meal and its ingredients in one transaction. A taken name
 *  throws SavedMealNameTaken; nothing is written then. */
export async function createSavedMeal(
    userId: string,
    input: SavedMealInput,
    items: MealItemValues[],
): Promise<SavedMealWithItems> {
    const cols = savedMealColumns(input);
    const names = ["user_id", ...Object.keys(cols)];
    try {
        const row = tx((db) => {
            const inserted = db
                .query(
                    `INSERT INTO saved_meals (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING *`,
                )
                .get(userId, ...(Object.values(cols) as never[])) as Row;
            insertItems(db, "saved_meal_items", "saved_meal_id", String(inserted.id), userId, items);
            return inserted;
        });
        return { ...savedMealFromRow(row), items };
    } catch (error) {
        if (isUniqueViolation(error) && String((error as Error).message).includes("name_key"))
            throw new SavedMealNameTaken(savedMealIdByName(userId, input.name));
        throw new Error(
            `Failed to save meal: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** Every saved meal of the user, by name, each with its ingredients. */
export async function getSavedMeals(
    userId: string,
    opts: { nameContains?: string } = {},
): Promise<SavedMealWithItems[]> {
    const needle = opts.nameContains?.trim();
    let sql = "SELECT * FROM saved_meals WHERE user_id = ?";
    const params: unknown[] = [userId];
    if (needle) {
        sql += " AND ulower(name) LIKE ? ESCAPE '\\'";
        params.push(`%${escapeLikePattern(needle.toLowerCase())}%`);
    }
    sql += " ORDER BY created_at ASC, id ASC";
    const rows = getDb().query(sql).all(...(params as never[])) as Row[];
    return withItems(userId, rows.map(savedMealFromRow));
}

/** One saved meal by id, or null (also for a non-uuid or another owner's id). */
export async function getSavedMeal(
    userId: string,
    id: string,
): Promise<SavedMealWithItems | null> {
    if (!isUuid(id)) return null;
    const row = getDb()
        .query("SELECT * FROM saved_meals WHERE id = ? AND user_id = ?")
        .get(id, userId) as Row | null;
    if (!row) return null;
    return withItems(userId, [savedMealFromRow(row)])[0] ?? null;
}

/** Saved meals whose name is `name`, ignoring case. */
export async function findSavedMealsByName(
    userId: string,
    name: string,
): Promise<SavedMealWithItems[]> {
    const wanted = name.trim();
    if (!wanted) return [];
    const rows = getDb()
        .query("SELECT * FROM saved_meals WHERE user_id = ? AND name_key = ?")
        .all(userId, wanted.toLowerCase()) as Row[];
    return withItems(userId, rows.map(savedMealFromRow));
}

export async function countSavedMeals(userId: string): Promise<number> {
    const row = getDb()
        .query<{ n: number }, [string]>(
            "SELECT count(*) AS n FROM saved_meals WHERE user_id = ?",
        )
        .get(userId);
    return row?.n ?? 0;
}

/** UPDATE saved_meals SET <cols>, updated_at WHERE id AND user RETURNING *. */
function applySavedUpdate(
    db: ReturnType<typeof getDb>,
    userId: string,
    id: string,
    fields: Partial<SavedMealInput>,
): Row | null {
    const cols = { ...savedMealColumns(fields), updated_at: ts() };
    const names = Object.keys(cols);
    return db
        .query(
            `UPDATE saved_meals SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ? AND user_id = ? RETURNING *`,
        )
        .get(...(Object.values(cols) as never[]), id, userId) as Row | null;
}

function nameTaken(error: unknown): boolean {
    return isUniqueViolation(error) && String((error as Error).message).includes("name_key");
}

/** Updates a saved meal's own figures and labels (no items) as one guarded
 *  write: it lands only while the row still holds `guard`, else it throws
 *  SnapshotConflictError. A name taken by another saved meal throws
 *  SavedMealNameTaken. Null when this owner has no saved meal with `id`. */
export async function updateSavedMealIfUnchanged(
    userId: string,
    id: string,
    fields: Partial<SavedMealInput>,
    guard: MealSnapshotGuard,
): Promise<SavedMealWithItems | null> {
    if (!isUuid(id)) return null;
    try {
        const row = tx((db) => {
            const current = db
                .query("SELECT * FROM saved_meals WHERE id = ? AND user_id = ?")
                .get(id, userId) as Row | null;
            if (!current) return null;
            const parsed = {
                ...current,
                nutrient_sources: fromJson(current.nutrient_sources),
                source_detail: fromJson(current.source_detail),
            };
            if (!guardMatches(parsed, guard)) throw new SnapshotConflictError(id);
            return applySavedUpdate(db, userId, id, fields);
        });
        if (!row) return null;
        return withItems(userId, [savedMealFromRow(row)])[0] ?? null;
    } catch (error) {
        if (error instanceof SnapshotConflictError) throw error;
        if (nameTaken(error))
            throw new SavedMealNameTaken(savedMealIdByName(userId, fields.name));
        throw new Error(
            `Failed to update saved meal: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** Updates a saved meal. `items` replaces its ingredients when given, and
 *  keeps them when null. Null when this owner has no saved meal with `id`. */
export async function updateSavedMeal(
    userId: string,
    id: string,
    fields: Partial<SavedMealInput>,
    items: MealItemValues[] | null,
): Promise<SavedMealWithItems | null> {
    if (!isUuid(id)) return null;
    try {
        const row = tx((db) => {
            const updated = applySavedUpdate(db, userId, id, fields);
            if (!updated) return null;
            if (items !== null) {
                db.query(
                    "DELETE FROM saved_meal_items WHERE saved_meal_id = ? AND user_id = ?",
                ).run(id, userId);
                insertItems(db, "saved_meal_items", "saved_meal_id", id, userId, items);
            }
            return updated;
        });
        if (!row) return null;
        const saved = savedMealFromRow(row);
        if (items !== null) return { ...saved, items };
        return withItems(userId, [saved])[0] ?? null;
    } catch (error) {
        if (nameTaken(error))
            throw new SavedMealNameTaken(savedMealIdByName(userId, fields.name));
        throw new Error(
            `Failed to update saved meal: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** Deletes a saved meal and its ingredients. Logged meals copied from it keep
 *  their values (saved_meal_id goes null). Returns the deleted row or null. */
export async function deleteSavedMeal(
    userId: string,
    id: string,
): Promise<SavedMeal | null> {
    if (!isUuid(id)) return null;
    const row = getDb()
        .query("DELETE FROM saved_meals WHERE id = ? AND user_id = ? RETURNING *")
        .get(id, userId) as Row | null;
    return row ? savedMealFromRow(row) : null;
}

export const SAVED_MEAL_SEARCH_LIMIT = 20;

function bySavedMealName(a: SavedMeal, b: SavedMeal): number {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Saved meals matching any of `queries`: a name or description holding every
 *  token of a query, or one ingredient name that does. Summaries, the first
 *  SAVED_MEAL_SEARCH_LIMIT by name; `total` counts every match. */
export async function searchSavedMeals(
    userId: string,
    queries: string[],
): Promise<{ saved: SavedMealSummary[]; total: number }> {
    const tokenized = queries.map(tokenizeQuery).filter((t) => t.length > 0);
    if (tokenized.length === 0) return { saved: [], total: 0 };

    const cap = MAX_SAVED_MEALS_PER_USER;
    const run = (cond: string, condParams: unknown[]): Row[] =>
        getDb()
            .query(
                `SELECT * FROM saved_meals WHERE user_id = ? AND ${cond} ORDER BY name_key ASC, id ASC LIMIT ?`,
            )
            .all(...([userId, ...condParams, cap] as never[])) as Row[];

    const found = new Map<string, SavedMeal>();
    const collect = (rows: Row[]) => {
        for (const row of rows) {
            const saved = savedMealFromRow(row);
            found.set(saved.id, saved);
        }
    };
    for (const tokens of tokenized) {
        for (const column of ["name", "description"]) {
            const m = likeAll(column, tokens, escapeLikePattern);
            collect(run(m.sql, m.params));
        }
        const item = likeAll("i.name", tokens, escapeLikePattern);
        collect(
            run(
                `EXISTS (SELECT 1 FROM saved_meal_items i WHERE i.saved_meal_id = saved_meals.id AND i.user_id = saved_meals.user_id AND ${item.sql})`,
                item.params,
            ),
        );
    }

    const saved = [...found.values()].sort(bySavedMealName).slice(0, SAVED_MEAL_SEARCH_LIMIT);
    const items = itemsByParent(
        "saved_meal_items",
        "saved_meal_id",
        userId,
        saved.map((s) => s.id),
    );
    return {
        saved: saved.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            meal_type: s.meal_type,
            calories: s.calories,
            protein_g: s.protein_g,
            carbs_g: s.carbs_g,
            fat_g: s.fat_g,
            item_count: items.get(s.id)?.length ?? 0,
        })),
        total: found.size,
    };
}

// ---------- Export readers ----------

/** Every saved meal of the user, oldest first, as stored. */
export function getAllSavedMeals(userId: string): Promise<SavedMeal[]> {
    const rows = getDb()
        .query("SELECT * FROM saved_meals WHERE user_id = ? ORDER BY created_at ASC, id ASC")
        .all(userId) as Row[];
    return Promise.resolve(
        rows.map((r) => {
            const { name_key: _key, ...rest } = r;
            return withProvenance({
                ...rest,
                nutrient_sources: fromJson(r.nutrient_sources),
                source_detail: fromJson(r.source_detail),
            });
        }) as unknown as SavedMeal[],
    );
}

/** Every saved-meal ingredient of the user, as stored. */
export function getAllSavedMealItems(userId: string): Promise<SavedMealItemRow[]> {
    const rows = getDb()
        .query(
            "SELECT * FROM saved_meal_items WHERE user_id = ? ORDER BY saved_meal_id ASC, position ASC, id ASC",
        )
        .all(userId) as Row[];
    return Promise.resolve(
        rows.map((r) =>
            withProvenance({
                ...r,
                nutrient_sources: fromJson(r.nutrient_sources),
                source_detail: fromJson(r.source_detail),
            }),
        ) as unknown as SavedMealItemRow[],
    );
}
