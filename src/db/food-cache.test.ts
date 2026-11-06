import { describe, expect, test } from "bun:test";
import { getDb } from "./conn.js";
import {
    getCachedFoodRecord,
    pruneFoodCache,
    readFoodCache,
    readUsdaFoodCache,
    writeFoodCache,
    writeUsdaFoodCache,
} from "./repo.js";
import { useMemoryDb } from "./test-helpers.js";

useMemoryDb();

const DAY = 86_400_000;

describe("food_cache", () => {
    test("write then read round-trips the JSON payload and fetch time", async () => {
        const at = new Date("2026-03-01T10:00:00.000Z");
        await writeFoodCache(
            "openfoodfacts",
            "123",
            { name: "Oats", kcal: 370 },
            at,
        );
        expect(await readFoodCache("openfoodfacts", "123")).toEqual({
            payload: { name: "Oats", kcal: 370 },
            fetched_at: "2026-03-01T10:00:00.000Z",
        });
        expect(await readFoodCache("openfoodfacts", "999")).toBeNull();
        expect(await readFoodCache("usda", "123")).toBeNull();
    });

    test("a second write for the same key replaces payload and time (upsert)", async () => {
        await writeFoodCache(
            "openfoodfacts",
            "1",
            { v: 1 },
            new Date("2026-03-01T00:00:00Z"),
        );
        await writeFoodCache(
            "openfoodfacts",
            "1",
            { v: 2 },
            new Date("2026-03-05T00:00:00Z"),
        );
        expect((await readFoodCache("openfoodfacts", "1"))!).toEqual({
            payload: { v: 2 },
            fetched_at: "2026-03-05T00:00:00.000Z",
        });
        expect(
            getDb().query("SELECT count(*) n FROM food_cache").get(),
        ).toEqual({ n: 1 });
    });

    test("source and id are part of the key", async () => {
        await writeFoodCache("usda", "1", { a: 1 });
        await writeFoodCache("openfoodfacts", "1", { a: 2 });
        expect((await readFoodCache("usda", "1"))!.payload).toEqual({ a: 1 });
        expect((await readFoodCache("openfoodfacts", "1"))!.payload).toEqual({
            a: 2,
        });
    });

    test("TTL: callers get the age and prune removes only what is older than the cutoff", async () => {
        const now = new Date("2026-03-31T00:00:00.000Z");
        await writeFoodCache(
            "usda",
            "old",
            { x: 1 },
            new Date(now.getTime() - 40 * DAY),
        );
        await writeFoodCache(
            "usda",
            "fresh",
            { x: 2 },
            new Date(now.getTime() - 5 * DAY),
        );
        const old = (await readFoodCache("usda", "old"))!;
        const age = now.getTime() - Date.parse(old.fetched_at);
        expect(age > 30 * DAY).toBe(true); // the caller's 30-day TTL would refetch this
        expect(pruneFoodCache(30 * DAY, now)).toBe(1);
        expect(await readFoodCache("usda", "old")).toBeNull();
        expect(await readFoodCache("usda", "fresh")).not.toBeNull();
        expect(pruneFoodCache(30 * DAY, now)).toBe(0);
    });

    test("a write that fails (bad payload) is swallowed, a read of corrupt JSON is a miss", async () => {
        await writeFoodCache("usda", "bad", { n: 1n as never }); // BigInt cannot be stringified
        expect(await readFoodCache("usda", "bad")).toBeNull();
        getDb()
            .query(
                "INSERT INTO food_cache (source, source_id, payload) VALUES ('usda', 'x', '{}')",
            )
            .run();
        getDb().exec("PRAGMA ignore_check_constraints = ON");
        getDb()
            .query(
                "UPDATE food_cache SET payload = 'not json' WHERE source_id = 'x'",
            )
            .run();
        expect(await readFoodCache("usda", "x")).toBeNull();
    });

    test("the payload must be valid JSON (CHECK)", () => {
        expect(() =>
            getDb()
                .query(
                    "INSERT INTO food_cache (source, source_id, payload) VALUES ('a', 'b', 'nope')",
                )
                .run(),
        ).toThrow();
    });
});

describe("USDA cache and provenance lookups", () => {
    test("an invalid USDA payload is a miss; unknown ids are misses", async () => {
        await writeFoodCache("usda", "usda:123", { not: "a record" });
        expect(await readUsdaFoodCache(123)).toBeNull();
        expect(await readUsdaFoodCache(124)).toBeNull();
        expect(await getCachedFoodRecord("usda", "123")).toBeNull();
        expect(await getCachedFoodRecord("openfoodfacts", "nope")).toBeNull();
    });

    test("a real USDA record round-trips through write/read with its fetch time", async () => {
        const record = {
            fdc_id: 171077,
            name: "Oats, raw",
            data_type: "SR Legacy" as const,
            per100g: {
                calories: 389,
                protein_g: 16.9,
                carbs_g: 66.3,
                fat_g: 6.9,
            },
            portions: [{ label: "1 cup", grams: 81 }],
        };
        const fetchedAt = Date.parse("2026-03-01T00:00:00Z");
        await writeUsdaFoodCache(record, fetchedAt);
        const hit = await readUsdaFoodCache(171077);
        expect(hit).not.toBeNull();
        expect(hit!.record).toEqual(record);
        expect(hit!.fetchedAt).toBe(fetchedAt);
        // The row is keyed by the decimal FDC id under source "usda".
        expect((await readFoodCache("usda", "171077"))!.payload).toEqual(
            record,
        );
        // Provenance lookup ignores the TTL and returns a reference record.
        expect(await getCachedFoodRecord("usda", "171077")).not.toBeNull();
        // ...but only for the matching id.
        expect(await readUsdaFoodCache(171078)).toBeNull();
    });
});
