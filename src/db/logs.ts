/**
 * The simple timestamped logs: water, weight, body measurements and active
 * calories (manual rows plus the Apple Health day totals).
 */
import { zonedDayStartUtc, zonedNextDayStartUtc } from "../tz.js";
import { decodeEscapeSequences } from "../normalize.js";
import type { BodyMeasurementKind, LengthUnit } from "../units.js";
import { activityIdempotencyKey } from "../activity.js";
import { ToolError } from "../errors.js";
import { getDb } from "./conn.js";
import { isUniqueViolation, normId, ts, tx, type Row } from "./util.js";
import { deriveIdempotencyKey } from "./shared.js";
import { selectLoggedWindow } from "./meals.js";
import type {
    ActiveCaloriesEntry,
    ActiveCaloriesInput,
    ActiveCaloriesInsertResult,
    BodyMeasurementEntry,
    BodyMeasurementInput,
    BodyMeasurementInsertResult,
    HealthActivityDayWrite,
    WaterEntry,
    WaterInput,
    WaterInsertResult,
    WeightEntry,
    WeightInput,
    WeightInsertResult,
} from "./types.js";

type LogTable =
    "water_log" | "weight_log" | "body_measurement_log" | "active_calories_log";

/**
 * Inserts a row unless this owner already has one with the same idempotency
 * key, in which case that row comes back with `deduplicated: true`. Lookup and
 * insert share one write transaction; a unique violation (which cannot occur
 * after the lookup) is still resolved to the existing row.
 */
function insertIdempotent(
    table: LogTable,
    noun: string,
    userId: string,
    idempotencyKey: string,
    buildCols: () => Row,
): { row: Row; deduplicated: boolean } {
    const lookup = () =>
        getDb()
            .query(
                `SELECT * FROM ${table} WHERE user_id = ? AND idempotency_key = ?`,
            )
            .get(userId, idempotencyKey) as Row | null;
    try {
        // Built inside the try so an invalid logged_at reports as
        // "Failed to insert <noun>: ...", like every other write failure.
        const cols = buildCols();
        return tx((db) => {
            const existing = db
                .query(
                    `SELECT * FROM ${table} WHERE user_id = ? AND idempotency_key = ?`,
                )
                .get(userId, idempotencyKey) as Row | null;
            if (existing) return { row: existing, deduplicated: true };
            const all = {
                user_id: userId,
                ...cols,
                idempotency_key: idempotencyKey,
            };
            const names = Object.keys(all);
            const row = db
                .query(
                    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING *`,
                )
                .get(...(Object.values(all) as never[])) as Row;
            return { row, deduplicated: false };
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            const raced = lookup();
            if (raced) return { row: raced, deduplicated: true };
        }
        throw new Error(
            `Failed to insert ${noun}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function deleteById(
    table: LogTable,
    noun: string,
    userId: string,
    id: string,
): boolean {
    try {
        return (
            getDb()
                .query(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`)
                .run(normId(id), userId).changes > 0
        );
    } catch (error) {
        throw new Error(
            `Failed to delete ${noun}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function countRows(table: LogTable, userId: string): number {
    return (
        getDb()
            .query<{ n: number }, [string]>(
                `SELECT count(*) AS n FROM ${table} WHERE user_id = ?`,
            )
            .get(userId)?.n ?? 0
    );
}

function allRows(table: LogTable, userId: string): Row[] {
    return getDb()
        .query(
            `SELECT * FROM ${table} WHERE user_id = ? ORDER BY logged_at ASC, id ASC`,
        )
        .all(userId) as Row[];
}

function window(
    table: LogTable,
    userId: string,
    startDate: string,
    endDate: string,
    tz: string,
    filter?: { kind: string },
): Row[] {
    return selectLoggedWindow(
        table,
        userId,
        zonedDayStartUtc(startDate, tz),
        zonedNextDayStartUtc(endDate, tz),
        filter,
    );
}

// ---------- Water ----------

export async function insertWater(
    userId: string,
    input: WaterInput,
): Promise<WaterInsertResult> {
    const loggedAt = input.logged_at ?? new Date().toISOString();
    const key =
        input.idempotency_key ??
        deriveIdempotencyKey([userId, input.amount_ml, input.notes, loggedAt]);
    const { row, deduplicated } = insertIdempotent(
        "water_log",
        "water",
        userId,
        key,
        () => ({
            amount_ml: input.amount_ml,
            logged_at: ts(loggedAt),
            notes: input.notes ?? null,
        }),
    );
    return { entry: row as unknown as WaterEntry, deduplicated };
}

export async function getWaterByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<WaterEntry[]> {
    return getWaterInRange(userId, date, date, tz);
}

export async function getWaterInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<WaterEntry[]> {
    return window(
        "water_log",
        userId,
        startDate,
        endDate,
        tz,
    ) as unknown as WaterEntry[];
}

export async function countWater(userId: string): Promise<number> {
    return countRows("water_log", userId);
}

export async function getAllWater(userId: string): Promise<WaterEntry[]> {
    return allRows("water_log", userId) as unknown as WaterEntry[];
}

export async function deleteWater(
    userId: string,
    id: string,
): Promise<boolean> {
    return deleteById("water_log", "water", userId, id);
}

// ---------- Active calories ----------

/** One burn, mirroring insertWater. `credit_pct` is the caller's snapshot of
 *  the profile value at write time and is stored as given. */
export async function insertActiveCalories(
    userId: string,
    input: ActiveCaloriesInput,
): Promise<ActiveCaloriesInsertResult> {
    const loggedAt = input.logged_at ?? new Date().toISOString();
    const key =
        input.idempotency_key ??
        activityIdempotencyKey([userId, input.kcal, input.notes, loggedAt]);
    const { row, deduplicated } = insertIdempotent(
        "active_calories_log",
        "active calories",
        userId,
        key,
        () => ({
            logged_at: ts(loggedAt),
            kcal: input.kcal,
            credit_pct: input.credit_pct,
            notes: input.notes ?? null,
        }),
    );
    return { entry: row as unknown as ActiveCaloriesEntry, deduplicated };
}

export async function getActivityInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<ActiveCaloriesEntry[]> {
    return window(
        "active_calories_log",
        userId,
        startDate,
        endDate,
        tz,
    ) as unknown as ActiveCaloriesEntry[];
}

export async function countActiveCalories(userId: string): Promise<number> {
    return countRows("active_calories_log", userId);
}

export async function getAllActiveCalories(
    userId: string,
): Promise<ActiveCaloriesEntry[]> {
    return allRows(
        "active_calories_log",
        userId,
    ) as unknown as ActiveCaloriesEntry[];
}

export async function deleteActiveCalories(
    userId: string,
    id: string,
): Promise<boolean> {
    return deleteById("active_calories_log", "active calories", userId, id);
}

/**
 * Writes the activity sync's day totals: one row per local date, inserted or
 * REPLACED (never added to) inside one transaction (the
 * sync_health_active_calories function). The unique key is (owner, source_date)
 * among source = 'apple_health' rows only, so a manually logged row is never
 * touched. An existing day keeps its credit_pct snapshot; only kcal and
 * logged_at are overwritten, and only when one of them differs. Returns how
 * many rows were inserted or changed. The caller validates every value.
 */
export async function syncHealthActiveCalories(
    userId: string,
    days: readonly HealthActivityDayWrite[],
): Promise<number> {
    if (days.length === 0) return 0;
    try {
        return tx((db) => {
            const upsert = db.query(
                `INSERT INTO active_calories_log (user_id, logged_at, kcal, credit_pct, source, source_date)
                 VALUES (?, ?, ?, ?, 'apple_health', ?)
                 ON CONFLICT (user_id, source_date) WHERE source = 'apple_health'
                 DO UPDATE SET kcal = excluded.kcal, logged_at = excluded.logged_at
                 WHERE active_calories_log.kcal IS NOT excluded.kcal
                    OR active_calories_log.logged_at IS NOT excluded.logged_at`,
            );
            let changed = 0;
            for (const d of days) {
                changed += upsert.run(
                    userId,
                    ts(d.logged_at),
                    d.kcal,
                    d.credit_pct,
                    d.date,
                ).changes;
            }
            return changed;
        });
    } catch (error) {
        throw new Error(
            `Failed to store Apple Health active calories: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

// ---------- Weight ----------

export async function insertWeight(
    userId: string,
    input: WeightInput,
): Promise<WeightInsertResult> {
    const loggedAt = input.logged_at ?? new Date().toISOString();
    const key =
        input.idempotency_key ??
        deriveIdempotencyKey([userId, input.weight_g, input.notes, loggedAt]);
    const { row, deduplicated } = insertIdempotent(
        "weight_log",
        "weight",
        userId,
        key,
        () => ({
            weight_g: input.weight_g,
            logged_at: ts(loggedAt),
            notes: input.notes ?? null,
        }),
    );
    return { entry: row as unknown as WeightEntry, deduplicated };
}

export async function getWeightByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<WeightEntry[]> {
    return getWeightInRange(userId, date, date, tz);
}

export async function getWeightInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<WeightEntry[]> {
    return window(
        "weight_log",
        userId,
        startDate,
        endDate,
        tz,
    ) as unknown as WeightEntry[];
}

export async function countWeight(userId: string): Promise<number> {
    return countRows("weight_log", userId);
}

export async function getAllWeight(userId: string): Promise<WeightEntry[]> {
    return allRows("weight_log", userId) as unknown as WeightEntry[];
}

/** Most recent weight entry overall, or null. */
export async function getLatestWeight(
    userId: string,
): Promise<WeightEntry | null> {
    const row = getDb()
        .query(
            "SELECT * FROM weight_log WHERE user_id = ? ORDER BY logged_at DESC, id DESC LIMIT 1",
        )
        .get(userId);
    return (row as WeightEntry | null) ?? null;
}

/** Applies `update` (column -> value, fixed names) to one owned row. */
function updateRow(
    table: LogTable,
    userId: string,
    id: string,
    update: Row,
): Row | null {
    const names = Object.keys(update);
    if (names.length === 0) {
        return getDb()
            .query(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`)
            .get(normId(id), userId) as Row | null;
    }
    return getDb()
        .query(
            `UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ? AND user_id = ? RETURNING *`,
        )
        .get(
            ...(Object.values(update) as never[]),
            normId(id),
            userId,
        ) as Row | null;
}

export async function updateWeight(
    userId: string,
    id: string,
    fields: { weight_g?: number; logged_at?: string; notes?: string | null },
): Promise<WeightEntry> {
    const update: Row = {};
    if (fields.weight_g !== undefined) update.weight_g = fields.weight_g;
    if (fields.logged_at !== undefined) update.logged_at = ts(fields.logged_at);
    if (fields.notes !== undefined)
        update.notes =
            fields.notes != null ? decodeEscapeSequences(fields.notes) : null;
    let row: Row | null;
    try {
        row = updateRow("weight_log", userId, id, update);
    } catch (error) {
        throw new Error(
            `Failed to update weight: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!row) throw new ToolError(`No weight entry found with id ${id}.`);
    return row as unknown as WeightEntry;
}

export async function deleteWeight(
    userId: string,
    id: string,
): Promise<boolean> {
    return deleteById("weight_log", "weight", userId, id);
}

// ---------- Body measurements ----------

// The digest is POSITIONAL, so this field list is frozen (see
// deriveIdempotencyKey). `kind` keeps waist 80 cm and hips 80 cm at the same
// instant as two rows; value_mm means 80 cm and 31.5 in are one measurement.
export function bodyMeasurementIdempotencyKey(
    userId: string,
    input: Pick<BodyMeasurementInput, "kind" | "value_mm" | "notes">,
    loggedAt: string,
): string {
    return deriveIdempotencyKey([
        userId,
        input.kind,
        input.value_mm,
        input.notes,
        loggedAt,
    ]);
}

export async function insertBodyMeasurement(
    userId: string,
    input: BodyMeasurementInput,
): Promise<BodyMeasurementInsertResult> {
    const loggedAt = input.logged_at ?? new Date().toISOString();
    // Decoded before hashing, as upstream does for this table.
    const notes =
        input.notes != null ? decodeEscapeSequences(input.notes) : undefined;
    const key =
        input.idempotency_key ??
        bodyMeasurementIdempotencyKey(
            userId,
            { kind: input.kind, value_mm: input.value_mm, notes },
            loggedAt,
        );
    const { row, deduplicated } = insertIdempotent(
        "body_measurement_log",
        "body measurement",
        userId,
        key,
        () => ({
            kind: input.kind,
            value_mm: input.value_mm,
            value_entered: input.value_entered,
            entered_unit: input.entered_unit,
            logged_at: ts(loggedAt),
            notes: notes ?? null,
        }),
    );
    return { entry: row as unknown as BodyMeasurementEntry, deduplicated };
}

/** Every measurement in the local-date window, oldest first; `kind` narrows it. */
export async function getBodyMeasurementsInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
    kind?: BodyMeasurementKind,
): Promise<BodyMeasurementEntry[]> {
    return window(
        "body_measurement_log",
        userId,
        startDate,
        endDate,
        tz,
        kind ? { kind } : undefined,
    ) as unknown as BodyMeasurementEntry[];
}

export async function getBodyMeasurement(
    userId: string,
    id: string,
): Promise<BodyMeasurementEntry | null> {
    const row = getDb()
        .query(
            "SELECT * FROM body_measurement_log WHERE id = ? AND user_id = ?",
        )
        .get(normId(id), userId);
    return (row as BodyMeasurementEntry | null) ?? null;
}

/** The three value fields describe one reading: all together or none. `kind`
 *  is not editable and the idempotency key is not recomputed. */
export async function updateBodyMeasurement(
    userId: string,
    id: string,
    fields: {
        value_mm?: number;
        value_entered?: number;
        entered_unit?: LengthUnit;
        logged_at?: string;
        notes?: string | null;
    },
): Promise<BodyMeasurementEntry> {
    const valueFields = [
        fields.value_mm,
        fields.value_entered,
        fields.entered_unit,
    ].filter((v) => v !== undefined).length;
    if (valueFields !== 0 && valueFields !== 3) {
        // A handler bug, not caller input: deliberately a plain Error.
        throw new Error(
            "updateBodyMeasurement: value fields must be passed together",
        );
    }
    const update: Row = {};
    if (valueFields === 3) {
        update.value_mm = fields.value_mm;
        update.value_entered = fields.value_entered;
        update.entered_unit = fields.entered_unit;
    }
    if (fields.logged_at !== undefined) update.logged_at = ts(fields.logged_at);
    if (fields.notes !== undefined)
        update.notes =
            fields.notes != null ? decodeEscapeSequences(fields.notes) : null;
    let row: Row | null;
    try {
        row = updateRow("body_measurement_log", userId, id, update);
    } catch (error) {
        throw new Error(
            `Failed to update body measurement: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (!row) throw new ToolError(`No body measurement found with id ${id}.`);
    return row as unknown as BodyMeasurementEntry;
}

export async function deleteBodyMeasurement(
    userId: string,
    id: string,
): Promise<boolean> {
    return deleteById("body_measurement_log", "body measurement", userId, id);
}

export function getAllBodyMeasurements(
    userId: string,
): Promise<BodyMeasurementEntry[]> {
    return Promise.resolve(
        allRows(
            "body_measurement_log",
            userId,
        ) as unknown as BodyMeasurementEntry[],
    );
}
