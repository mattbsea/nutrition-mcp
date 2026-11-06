import { describe, expect, test } from "bun:test";
import { ToolError } from "../errors.js";
import { getDb } from "./conn.js";
import {
    countActiveCalories,
    countWater,
    countWeight,
    deleteActiveCalories,
    deleteBodyMeasurement,
    deleteWater,
    deleteWeight,
    getActivityInRange,
    getAllActiveCalories,
    getAllBodyMeasurements,
    getAllWater,
    getAllWeight,
    getBodyMeasurement,
    getBodyMeasurementsInRange,
    getLatestWeight,
    getWaterByDate,
    getWaterInRange,
    getWeightByDate,
    getWeightInRange,
    insertActiveCalories,
    insertBodyMeasurement,
    insertWater,
    insertWeight,
    syncHealthActiveCalories,
    updateBodyMeasurement,
    updateWeight,
} from "./repo.js";
import { OTHER, USER, useMemoryDb } from "./test-helpers.js";

useMemoryDb();

const AT = "2026-03-14T12:00:00.000Z";

describe("water", () => {
    test("insert, dedupe on an identical retry, explicit key, window, delete", async () => {
        const a = await insertWater(USER, {
            amount_ml: 250,
            logged_at: AT,
            notes: "glass",
        });
        expect(a.deduplicated).toBe(false);
        expect(a.entry).toMatchObject({
            amount_ml: 250,
            user_id: USER,
            notes: "glass",
            logged_at: AT,
        });
        expect(a.entry.idempotency_key).toStartWith("auto:");
        const b = await insertWater(USER, {
            amount_ml: 250,
            logged_at: AT,
            notes: "glass",
        });
        expect(b.deduplicated).toBe(true);
        expect(b.entry.id).toBe(a.entry.id);
        // different time -> a separate drink
        await insertWater(USER, {
            amount_ml: 250,
            logged_at: "2026-03-14T13:00:00.000Z",
            notes: "glass",
        });
        const keyed = await insertWater(USER, {
            amount_ml: 100,
            logged_at: "2026-03-14T14:00:00.000Z",
            idempotency_key: "w1",
        });
        expect(
            (await insertWater(USER, { amount_ml: 999, idempotency_key: "w1" }))
                .entry.id,
        ).toBe(keyed.entry.id);
        expect(await countWater(USER)).toBe(3);
        expect(
            (await getWaterByDate(USER, "2026-03-14")).map((w) => w.amount_ml),
        ).toEqual([250, 250, 100]);
        expect(await getWaterInRange(USER, "2026-03-15", "2026-03-16")).toEqual(
            [],
        );
        expect(await getAllWater(USER)).toHaveLength(3);
        expect(await deleteWater(USER, a.entry.id)).toBe(true);
        expect(await deleteWater(USER, a.entry.id)).toBe(false);
    });

    test("rejects non-positive and fractional millilitres", async () => {
        await expect(insertWater(USER, { amount_ml: 0 })).rejects.toThrow(
            /Failed to insert water/,
        );
        await expect(insertWater(USER, { amount_ml: 12.5 })).rejects.toThrow(
            /Failed to insert water/,
        );
        expect(await countWater(USER)).toBe(0);
    });

    test("a missing logged_at is stamped with the arrival time", async () => {
        const before = Date.now();
        const { entry } = await insertWater(USER, { amount_ml: 100 });
        expect(Date.parse(entry.logged_at)).toBeGreaterThanOrEqual(before - 1);
    });

    test("owner predicate", async () => {
        const theirs = await insertWater(OTHER, {
            amount_ml: 500,
            logged_at: AT,
        });
        expect(await countWater(USER)).toBe(0);
        expect(await getAllWater(USER)).toEqual([]);
        expect(await getWaterInRange(USER, "2026-03-14", "2026-03-14")).toEqual(
            [],
        );
        expect(await deleteWater(USER, theirs.entry.id)).toBe(false);
        expect(await countWater(OTHER)).toBe(1);
    });
});

describe("weight", () => {
    test("insert/dedupe/window/latest/update/delete", async () => {
        const a = await insertWeight(USER, {
            weight_g: 80000,
            logged_at: "2026-03-10T07:00:00.000Z",
        });
        await insertWeight(USER, {
            weight_g: 79500,
            logged_at: "2026-03-14T07:00:00.000Z",
            notes: "morning",
        });
        expect(
            (
                await insertWeight(USER, {
                    weight_g: 80000,
                    logged_at: "2026-03-10T07:00:00.000Z",
                })
            ).deduplicated,
        ).toBe(true);
        expect(await countWeight(USER)).toBe(2);
        expect((await getLatestWeight(USER))!.weight_g).toBe(79500);
        expect(
            (await getWeightByDate(USER, "2026-03-10")).map((w) => w.weight_g),
        ).toEqual([80000]);
        expect(
            (await getWeightInRange(USER, "2026-03-01", "2026-03-31")).map(
                (w) => w.weight_g,
            ),
        ).toEqual([80000, 79500]);
        const upd = await updateWeight(USER, a.entry.id, {
            weight_g: 80100,
            notes: "a\\u0041",
        });
        expect(upd).toMatchObject({
            weight_g: 80100,
            notes: "aA",
            logged_at: "2026-03-10T07:00:00.000Z",
        });
        expect(
            (await updateWeight(USER, a.entry.id, { notes: null })).notes,
        ).toBeNull();
        await expect(
            updateWeight(USER, "missing", { weight_g: 1 }),
        ).rejects.toBeInstanceOf(ToolError);
        expect(await getAllWeight(USER)).toHaveLength(2);
        expect(await deleteWeight(USER, a.entry.id)).toBe(true);
        expect(await deleteWeight(USER, a.entry.id)).toBe(false);
    });

    test("no entries -> latest is null; zero or negative weight is rejected", async () => {
        expect(await getLatestWeight(USER)).toBeNull();
        await expect(insertWeight(USER, { weight_g: 0 })).rejects.toThrow();
        await expect(insertWeight(USER, { weight_g: -3 })).rejects.toThrow();
    });

    test("owner predicate, including update", async () => {
        const theirs = await insertWeight(OTHER, {
            weight_g: 70000,
            logged_at: AT,
        });
        expect(await getLatestWeight(USER)).toBeNull();
        await expect(
            updateWeight(USER, theirs.entry.id, { weight_g: 1 }),
        ).rejects.toBeInstanceOf(ToolError);
        expect(await deleteWeight(USER, theirs.entry.id)).toBe(false);
        expect((await getLatestWeight(OTHER))!.weight_g).toBe(70000);
    });
});

describe("body measurements", () => {
    const waist = {
        kind: "waist" as const,
        value_mm: 800,
        value_entered: 80,
        entered_unit: "cm" as const,
        logged_at: AT,
    };

    test("insert/dedupe; kind separates same-instant readings; value_mm decides identity", async () => {
        const a = await insertBodyMeasurement(USER, waist);
        expect(a.entry).toMatchObject({
            kind: "waist",
            value_mm: 800,
            value_entered: 80,
            entered_unit: "cm",
        });
        expect((await insertBodyMeasurement(USER, waist)).deduplicated).toBe(
            true,
        );
        // same mm entered in inches is the same measurement
        expect(
            (
                await insertBodyMeasurement(USER, {
                    ...waist,
                    value_entered: 31.5,
                    entered_unit: "in",
                })
            ).deduplicated,
        ).toBe(true);
        expect(
            (await insertBodyMeasurement(USER, { ...waist, kind: "hips" }))
                .deduplicated,
        ).toBe(false);
        expect(await getAllBodyMeasurements(USER)).toHaveLength(2);
    });

    test("range read, kind filter, get by id, delete", async () => {
        const a = await insertBodyMeasurement(USER, waist);
        await insertBodyMeasurement(USER, {
            ...waist,
            kind: "neck",
            value_mm: 380,
            value_entered: 38,
        });
        expect(
            await getBodyMeasurementsInRange(USER, "2026-03-14", "2026-03-14"),
        ).toHaveLength(2);
        expect(
            (
                await getBodyMeasurementsInRange(
                    USER,
                    "2026-03-14",
                    "2026-03-14",
                    "UTC",
                    "neck",
                )
            ).map((m) => m.kind),
        ).toEqual(["neck"]);
        expect((await getBodyMeasurement(USER, a.entry.id))!.id).toBe(
            a.entry.id,
        );
        expect(await getBodyMeasurement(USER, "missing")).toBeNull();
        expect(await deleteBodyMeasurement(USER, a.entry.id)).toBe(true);
        expect(await deleteBodyMeasurement(USER, a.entry.id)).toBe(false);
    });

    test("update: the three value fields travel together; kind is not editable", async () => {
        const a = await insertBodyMeasurement(USER, waist);
        const upd = await updateBodyMeasurement(USER, a.entry.id, {
            value_mm: 790,
            value_entered: 79,
            entered_unit: "cm",
            notes: "x",
        });
        expect(upd).toMatchObject({
            value_mm: 790,
            value_entered: 79,
            kind: "waist",
            notes: "x",
        });
        await expect(
            updateBodyMeasurement(USER, a.entry.id, { value_mm: 700 }),
        ).rejects.toThrow(/passed together/);
        await expect(
            updateBodyMeasurement(USER, "missing", { notes: "n" }),
        ).rejects.toBeInstanceOf(ToolError);
    });

    test("notes are decoded BEFORE the dedupe digest is computed", async () => {
        const a = await insertBodyMeasurement(USER, { ...waist, notes: "after\\u0041" });
        expect(a.entry.notes).toBe("afterA");
        // The same note typed already-decoded is the same measurement.
        const b = await insertBodyMeasurement(USER, { ...waist, notes: "afterA" });
        expect(b.deduplicated).toBe(true);
        expect(b.entry.id).toBe(a.entry.id);
    });

    test("rejects an unknown kind or unit at the database", async () => {
        await expect(
            insertBodyMeasurement(USER, { ...waist, kind: "elbow" as never }),
        ).rejects.toThrow();
        await expect(
            insertBodyMeasurement(USER, {
                ...waist,
                entered_unit: "ft" as never,
            }),
        ).rejects.toThrow();
    });

    test("owner predicate", async () => {
        const theirs = await insertBodyMeasurement(OTHER, waist);
        expect(await getBodyMeasurement(USER, theirs.entry.id)).toBeNull();
        expect(await getAllBodyMeasurements(USER)).toEqual([]);
        await expect(
            updateBodyMeasurement(USER, theirs.entry.id, { notes: "n" }),
        ).rejects.toBeInstanceOf(ToolError);
        expect(await deleteBodyMeasurement(USER, theirs.entry.id)).toBe(false);
    });
});

describe("active calories (manual)", () => {
    test("insert stores the credit snapshot as given and dedupes a retry", async () => {
        const a = await insertActiveCalories(USER, {
            kcal: 300,
            credit_pct: 50,
            logged_at: AT,
            notes: "run",
        });
        expect(a.entry).toMatchObject({
            kcal: 300,
            credit_pct: 50,
            source: null,
            source_date: null,
        });
        expect(
            (
                await insertActiveCalories(USER, {
                    kcal: 300,
                    credit_pct: 75,
                    logged_at: AT,
                    notes: "run",
                })
            ).deduplicated,
        ).toBe(true);
        expect(await countActiveCalories(USER)).toBe(1);
        expect(
            await getActivityInRange(USER, "2026-03-14", "2026-03-14"),
        ).toHaveLength(1);
        expect(await getAllActiveCalories(USER)).toHaveLength(1);
        expect(await deleteActiveCalories(USER, a.entry.id)).toBe(true);
        expect(await deleteActiveCalories(USER, a.entry.id)).toBe(false);
    });

    test("kcal is bounded 1..10000 and credit_pct 0..100", async () => {
        await expect(
            insertActiveCalories(USER, { kcal: 0, credit_pct: 50 }),
        ).rejects.toThrow();
        await expect(
            insertActiveCalories(USER, { kcal: 10001, credit_pct: 50 }),
        ).rejects.toThrow();
        await expect(
            insertActiveCalories(USER, { kcal: 100, credit_pct: 101 }),
        ).rejects.toThrow();
    });
});

describe("syncHealthActiveCalories (sync_health_active_calories)", () => {
    const day = (date: string, kcal: number, credit_pct = 100) => ({
        date,
        kcal,
        credit_pct,
        logged_at: `${date}T12:00:00.000Z`,
    });

    test("inserts one row per local date, tagged apple_health", async () => {
        expect(
            await syncHealthActiveCalories(USER, [
                day("2026-03-13", 400),
                day("2026-03-14", 500),
            ]),
        ).toBe(2);
        const rows = await getAllActiveCalories(USER);
        expect(rows.map((r) => [r.source, r.source_date, r.kcal])).toEqual([
            ["apple_health", "2026-03-13", 400],
            ["apple_health", "2026-03-14", 500],
        ]);
    });

    test("REPLACES a day's total (never adds) and reports only real changes", async () => {
        await syncHealthActiveCalories(USER, [day("2026-03-14", 500)]);
        expect(
            await syncHealthActiveCalories(USER, [day("2026-03-14", 650)]),
        ).toBe(1);
        expect((await getAllActiveCalories(USER)).map((r) => r.kcal)).toEqual([
            650,
        ]);
        // identical total again: zero changed
        expect(
            await syncHealthActiveCalories(USER, [day("2026-03-14", 650)]),
        ).toBe(0);
        expect(await countActiveCalories(USER)).toBe(1);
    });

    test("an existing day keeps its credit_pct snapshot", async () => {
        await syncHealthActiveCalories(USER, [day("2026-03-14", 500, 60)]);
        await syncHealthActiveCalories(USER, [day("2026-03-14", 700, 100)]);
        const [row] = await getAllActiveCalories(USER);
        expect(row).toMatchObject({ kcal: 700, credit_pct: 60 });
    });

    test("a logged_at change alone counts as a change", async () => {
        await syncHealthActiveCalories(USER, [day("2026-03-14", 500)]);
        expect(
            await syncHealthActiveCalories(USER, [
                {
                    ...day("2026-03-14", 500),
                    logged_at: "2026-03-14T13:00:00.000Z",
                },
            ]),
        ).toBe(1);
    });

    test("preserves manual entries, even on the same day", async () => {
        const manual = await insertActiveCalories(USER, {
            kcal: 200,
            credit_pct: 100,
            logged_at: AT,
        });
        await syncHealthActiveCalories(USER, [day("2026-03-14", 900)]);
        await syncHealthActiveCalories(USER, [day("2026-03-14", 950)]);
        const rows = await getAllActiveCalories(USER);
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.id === manual.entry.id)).toMatchObject({
            kcal: 200,
            source: null,
        });
        expect(rows.find((r) => r.source === "apple_health")).toMatchObject({
            kcal: 950,
        });
    });

    test("is all-or-nothing: one invalid day rolls the whole batch back", async () => {
        await expect(
            syncHealthActiveCalories(USER, [
                day("2026-03-13", 400),
                day("2026-03-14", 0),
            ]),
        ).rejects.toThrow(/Failed to store Apple Health active calories/);
        expect(await countActiveCalories(USER)).toBe(0);
    });

    test("an empty batch is a no-op", async () => {
        expect(await syncHealthActiveCalories(USER, [])).toBe(0);
    });

    test("source and source_date must be set together", () => {
        expect(() =>
            getDb()
                .query(
                    "INSERT INTO active_calories_log (user_id, kcal, credit_pct, source) VALUES (?, 10, 100, 'apple_health')",
                )
                .run(USER),
        ).toThrow();
    });

    test("owner predicate: another owner's same-date total is a separate row", async () => {
        await syncHealthActiveCalories(OTHER, [day("2026-03-14", 111)]);
        await syncHealthActiveCalories(USER, [day("2026-03-14", 222)]);
        expect((await getAllActiveCalories(USER)).map((r) => r.kcal)).toEqual([
            222,
        ]);
        expect((await getAllActiveCalories(OTHER)).map((r) => r.kcal)).toEqual([
            111,
        ]);
    });
});
