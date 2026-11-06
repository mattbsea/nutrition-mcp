import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { closeDb, setDb } from "./conn.js";
import { openDb } from "./migrate.js";
import {
    OWNER_ID,
    createSavedMeal,
    deleteAllUserData,
    insertBodyMeasurement,
    insertMeal,
    insertWater,
    insertWeight,
    updateMeal,
    upsertProfile,
} from "./repo.js";
import { item } from "./test-helpers.js";

const dirs: string[] = [];
afterEach(() => {
    closeDb();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Distinctive, never-occurring-in-SQLite text, one per table that stores free text.
const MARKERS = [
    "zq-meal-description-7741",
    "zq-meal-notes-7742",
    "zq-ingredient-name-7743",
    "zq-saved-meal-name-7744",
    "zq-water-notes-7745",
    "zq-weight-notes-7746",
    "zq-body-notes-7747",
    "zq-edited-away-7748",
];

const bytesOf = (path: string): string =>
    existsSync(path) ? readFileSync(path).toString("latin1") : "";

function residue(dbPath: string): string[] {
    const all = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
        .map(bytesOf)
        .join("\0");
    return MARKERS.filter((m) => all.includes(m));
}

async function populate() {
    const meal = await insertMeal(OWNER_ID, {
        description: MARKERS[0]!,
        notes: MARKERS[1]!,
        meal_type: "lunch",
        calories: 500,
        logged_at: "2026-03-14T10:00:00.000Z",
        items: [item(1, { name: MARKERS[2]! })],
    });
    await createSavedMeal(
        OWNER_ID,
        {
            name: MARKERS[3]!,
            description: "saved",
            meal_type: null,
            calories: 1,
            protein_g: 1,
            carbs_g: 1,
            fat_g: 1,
        } as never,
        [item(1)],
    );
    await insertWater(OWNER_ID, {
        amount_ml: 250,
        notes: MARKERS[4]!,
        logged_at: "2026-03-14T10:00:00.000Z",
    });
    await insertWeight(OWNER_ID, {
        weight_g: 80000,
        notes: MARKERS[5]!,
        logged_at: "2026-03-14T10:00:00.000Z",
    });
    await insertBodyMeasurement(OWNER_ID, {
        kind: "waist",
        value_mm: 800,
        value_entered: 80,
        entered_unit: "cm",
        notes: MARKERS[6]!,
        logged_at: "2026-03-14T10:00:00.000Z",
    });
    await upsertProfile(OWNER_ID, { timezone: "UTC" });
    // An edit leaves the OLD text in the page history / log; it must go too.
    await updateMeal(OWNER_ID, meal.meal.id, { description: MARKERS[7]! });
    await updateMeal(OWNER_ID, meal.meal.id, { description: MARKERS[0]! });
}

function freshDb() {
    const dir = mkdtempSync(join(tmpdir(), "resid-"));
    dirs.push(dir);
    const path = join(dir, "nutrition.db");
    setDb(openDb(path));
    return path;
}

describe("delete_account leaves no copy of the deleted text on disk", () => {
    test("the scan can see the markers while the data exists (so a clean result means something)", async () => {
        const path = freshDb();
        await populate();
        const found = residue(path);
        expect(found).toContain(MARKERS[0]!);
        expect(found).toContain(MARKERS[5]!);
    });

    test("after deleteAllUserData none of them is in nutrition.db, -wal or -shm", async () => {
        const path = freshDb();
        await populate();
        await deleteAllUserData(OWNER_ID);
        expect(residue(path)).toEqual([]);
        // The log was truncated, not merely left behind.
        expect(bytesOf(`${path}-wal`).length).toBe(0);
    });

    test("and still none after the connection is closed (the final checkpoint)", async () => {
        const path = freshDb();
        await populate();
        await deleteAllUserData(OWNER_ID);
        closeDb();
        expect(residue(path)).toEqual([]);
    });

    test("control: WITHOUT secure_delete and the checkpoint the markers do survive a plain DELETE", async () => {
        const dir = mkdtempSync(join(tmpdir(), "resid-"));
        dirs.push(dir);
        const path = join(dir, "plain.db");
        const db = new Database(path, { create: true });
        db.exec("PRAGMA journal_mode = WAL; PRAGMA secure_delete = OFF");
        db.exec("CREATE TABLE t (v TEXT)");
        db.query("INSERT INTO t VALUES (?)").run(MARKERS[0]!);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.query("DELETE FROM t").run();
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        // Folded into the main file, the freed page still holds the text.
        expect(residue(path)).toContain(MARKERS[0]!);
        db.close();
    });

    test("the connection keeps secure_delete on", () => {
        freshDb();
        const { getDb } = require("./conn.js") as typeof import("./conn.js");
        expect(
            getDb()
                .query<{ secure_delete: number }, []>("PRAGMA secure_delete")
                .get()!.secure_delete,
        ).toBe(1);
    });

    test("an in-memory database (tests) is unaffected by the checkpoint", async () => {
        setDb(openDb(":memory:"));
        await insertWater(OWNER_ID, {
            amount_ml: 100,
            logged_at: "2026-03-14T10:00:00.000Z",
        });
        await expect(deleteAllUserData(OWNER_ID)).resolves.toBeUndefined();
    });
});
