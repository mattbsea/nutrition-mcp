/** Whole-owner operations: delete everything, export file naming. */
import { getDb } from "./conn.js";
import { tx } from "./util.js";

/**
 * File name of the whole-account export archive, one per owner (each export
 * overwrites the last). With the cloud build this was a Storage key; the
 * add-on will use it as a path under /data/exports (step A2/A3).
 */
export function exportArchivePath(userId: string): string {
    return `${userId}/nutrition-mcp-export.zip`;
}

/**
 * Tables holding owner data, children before parents. (Foreign keys would
 * cascade anyway; naming every table keeps each one in the deletion record.)
 * The shared food_cache holds public reference data and is kept.
 */
const OWNER_TABLES = [
    "health_sync_sent",
    "health_sync_days",
    "health_sync_state",
    "water_log",
    "active_calories_log",
    "weight_log",
    "body_measurement_log",
    "nutrition_goals_history",
    "nutrition_goals",
    "profiles",
    "meal_items",
    "saved_meal_items",
    "saved_meals",
    "meals",
] as const;

/**
 * Deletes every row of this owner in ONE transaction: all or nothing. Export
 * archives live on disk, outside the database; removing the export archive
 * (exports/ under DATA_DIR) is the caller's job (and cannot be part of the
 * transaction).
 */
export async function deleteAllUserData(userId: string): Promise<void> {
    try {
        tx((db) => {
            for (const table of OWNER_TABLES) {
                db.query(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
            }
        });
        // The deleted rows are still in the write-ahead log until it is
        // checkpointed. TRUNCATE folds it into the database file (where
        // secure_delete has already zeroed the freed pages) and empties it, so
        // no copy of the deleted text remains in nutrition.db or its -wal.
        getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
        throw new Error(
            `Failed to delete user data: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
