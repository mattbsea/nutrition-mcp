/** Helpers shared by the meal, saved-meal and log repos. */
import type { Database } from "bun:sqlite";
import type {
    MealItemValues,
    MealNutrientKey,
    NutrientValues,
} from "../meal-items.js";
import {
    parseNutrientSources,
    parseSourceDetail,
    type NutrientSources,
    type SourceDetail,
} from "../provenance.js";
import { getDb } from "./conn.js";
import {
    chunks,
    fromJson,
    marks,
    normId,
    numOrNull,
    toJson,
    type Row,
} from "./util.js";

/** Nutrient columns, in MEAL_NUTRIENT_KEYS order. */
export const NUTRIENT_KEYS: readonly MealNutrientKey[] = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "saturated_fat_g",
    "trans_fat_g",
    "fiber_g",
    "sugar_g",
    "added_sugar_g",
    "alcohol_g",
    "caffeine_mg",
    "sodium_mg",
];

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A canonical 8-4-4-4-12 hex UUID, any case. Kept as the gate before id
 *  lookups so callers' behaviour for malformed ids (not found) is unchanged. */
export function isUuid(v: string): boolean {
    return UUID_RE.test(v);
}

/** sha256 over the NUL-joined parts, "auto:"-prefixed (see db/repo.ts). */
export function deriveIdempotencyKey(
    parts: (string | number | null | undefined)[],
): string {
    const digest = new Bun.CryptoHasher("sha256")
        .update(parts.map((p) => p ?? "").join("\u0000"))
        .digest("hex");
    return `auto:${digest}`;
}

export function nutrientsFromRow(row: Row): NutrientValues {
    const out = {} as NutrientValues;
    for (const key of NUTRIENT_KEYS) out[key] = numOrNull(row[key]);
    return out;
}

/** The provenance columns of a row, shape-checked. A key is only present when
 *  the row carries its column. */
export function provenanceFromRow(row: Row): {
    nutrient_sources?: NutrientSources | null;
    source_detail?: SourceDetail | null;
} {
    const out: {
        nutrient_sources?: NutrientSources | null;
        source_detail?: SourceDetail | null;
    } = {};
    if ("nutrient_sources" in row)
        out.nutrient_sources = parseNutrientSources(row.nutrient_sources);
    if ("source_detail" in row)
        out.source_detail = parseSourceDetail(row.source_detail);
    return out;
}

/** A row read by a whole-table export reader, with its provenance parsed. */
export function withProvenance<T extends object>(row: T): T {
    return { ...row, ...provenanceFromRow(row as Row) };
}

/** One item row, as src/meal-items.ts values. */
export function itemFromRow(row: Row): MealItemValues {
    return {
        ...nutrientsFromRow(row),
        position: Number(row.position),
        name: String(row.name),
        amount: numOrNull(row.amount),
        unit: row.unit == null ? null : String(row.unit),
        calories: Number(row.calories),
        protein_g: Number(row.protein_g),
        carbs_g: Number(row.carbs_g),
        fat_g: Number(row.fat_g),
        ...provenanceFromRow({
            nutrient_sources: fromJson(row.nutrient_sources),
            source_detail: fromJson(row.source_detail),
        }),
    };
}

const ITEM_COLUMNS = [
    "position",
    "name",
    "amount",
    "unit",
    ...NUTRIENT_KEYS,
    "nutrient_sources",
    "source_detail",
] as const;

/** Inserts item rows for one parent. Every column is written, null where the
 *  value is absent. Runs inside the caller's transaction. */
export function insertItems(
    db: Database,
    table: "meal_items" | "saved_meal_items",
    parentColumn: "meal_id" | "saved_meal_id",
    parentId: string,
    userId: string,
    items: readonly MealItemValues[],
): void {
    if (items.length === 0) return;
    const stmt = db.query(
        `INSERT INTO ${table} (${parentColumn}, user_id, ${ITEM_COLUMNS.join(", ")}) VALUES (${marks(ITEM_COLUMNS.length + 2)})`,
    );
    for (const item of items) {
        const rec = item as unknown as Row;
        const values = ITEM_COLUMNS.map((c) =>
            c === "nutrient_sources" || c === "source_detail"
                ? toJson(rec[c])
                : (rec[c] ?? null),
        );
        stmt.run(parentId, userId, ...(values as never[]));
    }
}

/** Item rows of many parents, grouped by parent id, ordered by position. */
export function itemsByParent(
    table: "meal_items" | "saved_meal_items",
    parentColumn: "meal_id" | "saved_meal_id",
    userId: string,
    parentIds: readonly string[],
): Map<string, MealItemValues[]> {
    const byParent = new Map<string, MealItemValues[]>();
    const ids = [...new Set(parentIds.filter(isUuid).map(normId))];
    for (const chunk of chunks(ids, 500)) {
        const rows = getDb()
            .query(
                `SELECT * FROM ${table} WHERE user_id = ? AND ${parentColumn} IN (${marks(chunk.length)}) ORDER BY ${parentColumn} ASC, position ASC, id ASC`,
            )
            .all(userId, ...chunk) as Row[];
        for (const row of rows) {
            const parent = String(row[parentColumn]);
            const list = byParent.get(parent) ?? [];
            list.push(itemFromRow(row));
            byParent.set(parent, list);
        }
    }
    return byParent;
}
