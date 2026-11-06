/** Shared food lookup cache (Open Food Facts + USDA FoodData Central). It holds
 *  public reference data, not owner data, so it has no owner column. */
import {
    referenceFromFood,
    referenceFromUsda,
    type RecordSource,
    type ReferenceRecord,
} from "../provenance.js";
import {
    USDA_CACHE_SOURCE,
    usdaRecordFromPayload,
    usdaSourceId,
    type UsdaRecord,
} from "../usda-record.js";
import { fromCachedPayload, type FoodResult } from "../foods.js";
import { getDb } from "./conn.js";
import { fromJson, ts } from "./util.js";

/** The cached payload and fetch time of one entry, or null. Best effort: any
 *  failure is a miss, so callers fetch upstream. TTLs are the caller's call. */
export async function readFoodCache(
    source: string,
    sourceId: string,
): Promise<{ payload: unknown; fetched_at: string } | null> {
    try {
        const row = getDb()
            .query<{ payload: string; fetched_at: string }, [string, string]>(
                "SELECT payload, fetched_at FROM food_cache WHERE source = ? AND source_id = ?",
            )
            .get(source, sourceId);
        if (!row) return null;
        const payload = fromJson(row.payload);
        return payload === null ? null : { payload, fetched_at: row.fetched_at };
    } catch {
        return null;
    }
}

/** Upserts one cache entry (best effort: a failed write only costs a refetch). */
export async function writeFoodCache(
    source: string,
    sourceId: string,
    payload: unknown,
    fetchedAt: Date | number = new Date(),
): Promise<void> {
    try {
        getDb()
            .query(
                `INSERT INTO food_cache (source, source_id, payload, fetched_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (source, source_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
            )
            .run(source, sourceId, JSON.stringify(payload), ts(fetchedAt));
    } catch {
        // best-effort; ignore
    }
}

/** Deletes entries fetched more than `maxAgeMs` ago; returns how many. */
export function pruneFoodCache(maxAgeMs: number, now: Date = new Date()): number {
    return getDb()
        .query("DELETE FROM food_cache WHERE fetched_at < ?")
        .run(new Date(now.getTime() - maxAgeMs).toISOString()).changes;
}

/**
 * A cached food record for provenance, with no TTL: a record past its cache
 * TTL still verifies a logged value. A miss (or a row that does not normalise
 * or belongs to another id) labels the value "estimate" and never fails.
 */
export async function getCachedFoodRecord(
    source: RecordSource,
    id: string,
): Promise<ReferenceRecord | null> {
    try {
        const hit = await readFoodCache(source, id);
        if (!hit) return null;
        if (source === "openfoodfacts") {
            const cached = fromCachedPayload(hit.payload as FoodResult);
            return cached ? referenceFromFood(cached.food, id, hit.fetched_at) : null;
        }
        const record = usdaRecordFromPayload(hit.payload);
        if (!record || String(record.fdc_id) !== id) return null;
        return referenceFromUsda(record, hit.fetched_at);
    } catch {
        return null;
    }
}

/** The USDA cache row for one FDC id with its fetch time in epoch ms (the
 *  caller applies the TTL), or null. */
export async function readUsdaFoodCache(
    fdcId: number,
): Promise<{ record: UsdaRecord; fetchedAt: number } | null> {
    try {
        const hit = await readFoodCache(USDA_CACHE_SOURCE, usdaSourceId(fdcId));
        if (!hit) return null;
        const record = usdaRecordFromPayload(hit.payload);
        if (!record || record.fdc_id !== fdcId) return null;
        const fetchedAt = Date.parse(hit.fetched_at);
        if (!Number.isFinite(fetchedAt)) return null;
        return { record, fetchedAt };
    } catch {
        return null;
    }
}

export async function writeUsdaFoodCache(
    record: UsdaRecord,
    fetchedAt: number,
): Promise<void> {
    await writeFoodCache(USDA_CACHE_SOURCE, usdaSourceId(record.fdc_id), record, fetchedAt);
}
