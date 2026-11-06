import {
    test,
    expect,
    describe,
    beforeAll,
    afterAll,
    beforeEach,
    afterEach,
    spyOn,
} from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    OWNER_ID,
    exportArchivePath,
    insertMeal,
    insertWater,
} from "./db/repo.js";
import { useMemoryDb } from "./db/test-helpers.js";
import { verifyExportLink } from "./export-files.js";
import {
    buildActiveCaloriesCsv,
    buildBodyMeasurementsCsv,
    buildConnectionsCsv,
    buildExportReadme,
    buildGoalsCsv,
    buildGoalsHistoryCsv,
    buildHealthSyncCsv,
    buildMealItemsCsv,
    buildMealsCsv,
    buildProfileCsv,
    buildSavedMealItemsCsv,
    buildSavedMealsCsv,
    buildWaterCsv,
    buildWeightCsv,
    EXPORT_ARCHIVE_FILES,
    exportAllData,
    type MealItemExportRow,
    type SavedMealExportRow,
    type SavedMealItemExportRow,
} from "./export.js";
import { HEALTH_SYNC_FIELDS } from "./health-sync.js";
import type { NutritionGoalsHistoryRow } from "./goals-history.js";
import type {
    BodyMeasurementEntry,
    HealthSyncDayRow,
    HealthSyncLinkStatus,
    HealthSyncStore,
    Meal,
    NutritionGoals,
    Profile,
    WaterEntry,
    WeightEntry,
} from "./db/repo.js";
import { buildZip } from "./zip.js";

function meal(overrides: Partial<Meal> = {}): Meal {
    return {
        id: "11111111-1111-1111-1111-111111111111",
        user_id: "user-1",
        logged_at: "2026-06-20T14:30:00.000Z",
        meal_type: "lunch",
        description: "Grilled chicken",
        calories: 500,
        protein_g: 40,
        carbs_g: 10,
        fat_g: 20,
        saturated_fat_g: 8,
        trans_fat_g: 0.5,
        fiber_g: 7,
        sugar_g: 12,
        added_sugar_g: 9,
        alcohol_g: 3,
        caffeine_mg: 95,
        sodium_mg: 640,
        notes: null,
        idempotency_key: null,
        saved_meal_id: null,
        ...overrides,
    };
}

const HEADER =
    "id,logged_at,timezone,meal_type,description,calories,protein_g,carbs_g,fat_g,saturated_fat_g,trans_fat_g,fiber_g,sugar_g,added_sugar_g,alcohol_g,caffeine_mg,sodium_mg,notes,saved_meal_id,provenance_version,nutrient_sources,source_detail";

/**
 * Minimal RFC-4180 reader: splits a CSV document into rows of fields, honouring
 * quoted fields that contain commas, newlines, and doubled quotes. Needed so the
 * alignment tests below count *fields*, not commas.
 */
function parseCsv(csv: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < csv.length; i++) {
        const ch = csv[i];
        if (inQuotes) {
            if (ch === '"') {
                if (csv[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (ch !== "\r") {
            field += ch;
        }
    }
    row.push(field);
    rows.push(row);
    return rows;
}

/** Zip a parsed CSV's header row against one data row into a lookup by name. */
function fieldsByName(csv: string, rowIndex = 1): Record<string, string> {
    const rows = parseCsv(csv);
    const header = rows[0]!;
    const row = rows[rowIndex]!;
    // Guard the whole premise of a by-name lookup: a short or long data row
    // would otherwise silently produce undefined/dropped fields.
    expect(row.length).toBe(header.length);
    const out: Record<string, string> = {};
    header.forEach((name, i) => {
        out[name] = row[i]!;
    });
    return out;
}

test("emits a header even with no meals", () => {
    expect(buildMealsCsv([], "UTC")).toBe(HEADER);
});

test("header and data rows have identical field counts", () => {
    // Every column populated, plus a row of all-null optionals and a row whose
    // text fields need quoting — misaligning CSV_COLUMNS against the positional
    // row builder changes the data-row width and fails here.
    const csv = buildMealsCsv(
        [
            meal(),
            meal({
                calories: null,
                protein_g: null,
                carbs_g: null,
                fat_g: null,
                saturated_fat_g: null,
                trans_fat_g: null,
                fiber_g: null,
                sugar_g: null,
                added_sugar_g: null,
                alcohol_g: null,
                caffeine_mg: null,
                meal_type: null,
                notes: null,
            }),
            meal({
                description: 'Salad, "the big one"',
                notes: "line1\nline2",
            }),
        ],
        "UTC",
    );
    const rows = parseCsv(csv);
    expect(rows[0]!.length).toBe(HEADER.split(",").length);
    expect(rows).toHaveLength(4);
    for (const row of rows.slice(1)) {
        expect(row.length).toBe(rows[0]!.length);
    }
});

test("every value lands under its own header name", () => {
    // Distinct values per column: a shifted field lands under the wrong name and
    // fails, even when the row width still happens to match.
    const f = fieldsByName(
        buildMealsCsv(
            [
                meal({
                    calories: 500,
                    protein_g: 40,
                    carbs_g: 10,
                    fat_g: 20,
                    saturated_fat_g: 8,
                    trans_fat_g: 0.5,
                    fiber_g: 7,
                    sugar_g: 12,
                    added_sugar_g: 9,
                    alcohol_g: 3,
                    caffeine_mg: 95,
                    notes: "post-run",
                    saved_meal_id: "33333333-3333-4333-8333-333333333333",
                }),
            ],
            "UTC",
        ),
    );
    expect(f).toEqual({
        id: "11111111-1111-1111-1111-111111111111",
        logged_at: "2026-06-20 14:30:00",
        timezone: "UTC",
        meal_type: "lunch",
        description: "Grilled chicken",
        calories: "500",
        protein_g: "40",
        carbs_g: "10",
        fat_g: "20",
        saturated_fat_g: "8",
        trans_fat_g: "0.5",
        fiber_g: "7",
        sugar_g: "12",
        added_sugar_g: "9",
        alcohol_g: "3",
        caffeine_mg: "95",
        sodium_mg: "640",
        notes: "post-run",
        saved_meal_id: "33333333-3333-4333-8333-333333333333",
        provenance_version: "1",
        nutrient_sources: "",
        source_detail: "",
    });
});

test("meals.csv keeps its byte-identical shape with a trailing empty saved_meal_id", () => {
    // A meal not logged from a saved meal leaves the last cell empty, so the
    // row still ends in a comma-free field and the earlier columns are untouched.
    const csv = buildMealsCsv([meal({ notes: null })], "UTC");
    const [header, row] = csv.split("\n");
    expect(
        header!.endsWith(
            ",notes,saved_meal_id,provenance_version,nutrient_sources,source_detail",
        ),
    ).toBe(true);
    // Provenance written as "1", no sources recorded: the two JSON cells are empty.
    expect(row!.endsWith(",,1,,")).toBe(true);
    expect(row!.split(",").length).toBe(HEADER.split(",").length);
});

test("meals.csv names the saved meal a meal was logged from", () => {
    const f = fieldsByName(
        buildMealsCsv(
            [meal({ saved_meal_id: "44444444-4444-4444-8444-444444444444" })],
            "UTC",
        ),
    );
    expect(f.saved_meal_id).toBe("44444444-4444-4444-8444-444444444444");
});

const ITEM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAVED_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function mealItem(
    overrides: Partial<MealItemExportRow> = {},
): MealItemExportRow {
    return {
        id: ITEM_ID,
        meal_id: "11111111-1111-1111-1111-111111111111",
        user_id: "user-1",
        position: 1,
        name: "Стріпси оригінальні",
        amount: 170,
        unit: "g",
        calories: 425,
        protein_g: 34,
        carbs_g: 22,
        fat_g: 22,
        saturated_fat_g: 9,
        trans_fat_g: 0.1,
        fiber_g: 1.5,
        sugar_g: 0.4,
        added_sugar_g: 0.2,
        alcohol_g: null,
        caffeine_mg: null,
        sodium_mg: 780,
        ...overrides,
    };
}

function savedMeal(
    overrides: Partial<SavedMealExportRow> = {},
): SavedMealExportRow {
    return {
        id: SAVED_ID,
        user_id: "user-1",
        name: "Protein shake",
        description: "Whey, oat milk, banana",
        meal_type: "snack",
        calories: 320,
        protein_g: 30,
        carbs_g: 35,
        fat_g: 6,
        saturated_fat_g: 2,
        trans_fat_g: 0,
        fiber_g: 4,
        sugar_g: 20,
        added_sugar_g: 0,
        alcohol_g: null,
        caffeine_mg: null,
        sodium_mg: 150,
        created_at: "2026-06-20T14:30:00.000Z",
        updated_at: "2026-06-21T09:00:00.000Z",
        ...overrides,
    };
}

function savedMealItem(
    overrides: Partial<SavedMealItemExportRow> = {},
): SavedMealItemExportRow {
    return {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        saved_meal_id: SAVED_ID,
        user_id: "user-1",
        position: 2,
        name: "Oat milk",
        amount: 250,
        unit: "ml",
        calories: 120,
        protein_g: 1,
        carbs_g: 16,
        fat_g: 5,
        saturated_fat_g: 3,
        trans_fat_g: null,
        fiber_g: null,
        sugar_g: null,
        added_sugar_g: null,
        alcohol_g: null,
        caffeine_mg: null,
        ...overrides,
    };
}

const MEAL_ITEMS_HEADER =
    "meal_id,position,name,amount,unit,calories,protein_g,carbs_g,fat_g,saturated_fat_g,trans_fat_g,fiber_g,sugar_g,added_sugar_g,alcohol_g,caffeine_mg,sodium_mg,provenance_version,nutrient_sources,source_detail";
const SAVED_MEALS_HEADER =
    "id,name,description,meal_type,calories,protein_g,carbs_g,fat_g,saturated_fat_g,trans_fat_g,fiber_g,sugar_g,added_sugar_g,alcohol_g,caffeine_mg,sodium_mg,created_at,updated_at,timezone,provenance_version,nutrient_sources,source_detail";
const SAVED_MEAL_ITEMS_HEADER =
    "saved_meal_id,position,name,amount,unit,calories,protein_g,carbs_g,fat_g,saturated_fat_g,trans_fat_g,fiber_g,sugar_g,added_sugar_g,alcohol_g,caffeine_mg,sodium_mg,provenance_version,nutrient_sources,source_detail";

test("meal_items.csv, saved_meals.csv and saved_meal_items.csv are header-only when empty", () => {
    expect(buildMealItemsCsv([])).toBe(MEAL_ITEMS_HEADER);
    expect(buildSavedMealsCsv([], "UTC")).toBe(SAVED_MEALS_HEADER);
    expect(buildSavedMealItemsCsv([])).toBe(SAVED_MEAL_ITEMS_HEADER);
});

test("the ingredient and saved meal headers are pinned", () => {
    // Renaming one of these breaks whatever joins the files; the names match
    // meals.csv's nutrient columns and carry the caffeine unit, as it does there.
    expect(parseCsv(buildMealItemsCsv([]))[0]).toEqual(
        MEAL_ITEMS_HEADER.split(","),
    );
    expect(parseCsv(buildSavedMealsCsv([], "UTC"))[0]).toEqual(
        SAVED_MEALS_HEADER.split(","),
    );
    expect(parseCsv(buildSavedMealItemsCsv([]))[0]).toEqual(
        SAVED_MEAL_ITEMS_HEADER.split(","),
    );
});

test("every meal item value lands under its own header name", () => {
    const f = fieldsByName(buildMealItemsCsv([mealItem()]));
    expect(f).toEqual({
        meal_id: "11111111-1111-1111-1111-111111111111",
        position: "1",
        name: "Стріпси оригінальні",
        amount: "170",
        unit: "g",
        calories: "425",
        protein_g: "34",
        carbs_g: "22",
        fat_g: "22",
        saturated_fat_g: "9",
        trans_fat_g: "0.1",
        fiber_g: "1.5",
        sugar_g: "0.4",
        added_sugar_g: "0.2",
        alcohol_g: "",
        caffeine_mg: "",
        sodium_mg: "780",
        provenance_version: "1",
        nutrient_sources: "",
        source_detail: "",
    });
});

test("meal_items.csv leaves an ingredient with no amount or unit empty and quotes commas", () => {
    const csv = buildMealItemsCsv([
        mealItem({ amount: null, unit: null, name: 'Sauce, "hot"' }),
    ]);
    const f = fieldsByName(csv);
    expect(f.amount).toBe("");
    expect(f.unit).toBe("");
    expect(f.name).toBe('Sauce, "hot"');
});

test("meal_items.csv header and every data row have identical field counts", () => {
    const rows = parseCsv(
        buildMealItemsCsv([
            mealItem(),
            mealItem({
                position: 2,
                name: "Multi\nline, name",
                amount: null,
                unit: null,
                fiber_g: null,
                sugar_g: null,
                added_sugar_g: null,
                caffeine_mg: 80,
            }),
        ]),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
        expect(row.length).toBe(MEAL_ITEMS_HEADER.split(",").length);
    }
});

test("every saved meal value lands under its own header name, timestamps in the account zone", () => {
    const f = fieldsByName(buildSavedMealsCsv([savedMeal()], "Europe/Berlin"));
    expect(f).toEqual({
        id: SAVED_ID,
        name: "Protein shake",
        description: "Whey, oat milk, banana",
        meal_type: "snack",
        calories: "320",
        protein_g: "30",
        carbs_g: "35",
        fat_g: "6",
        saturated_fat_g: "2",
        trans_fat_g: "0",
        fiber_g: "4",
        sugar_g: "20",
        added_sugar_g: "0",
        alcohol_g: "",
        caffeine_mg: "",
        sodium_mg: "150",
        created_at: "2026-06-20 16:30:00",
        updated_at: "2026-06-21 11:00:00",
        timezone: "Europe/Berlin",
        provenance_version: "1",
        nutrient_sources: "",
        source_detail: "",
    });
});

test("saved_meals.csv keeps a zero and leaves a never-set value empty", () => {
    const f = fieldsByName(
        buildSavedMealsCsv(
            [
                savedMeal({
                    meal_type: null,
                    added_sugar_g: 0,
                    caffeine_mg: null,
                }),
            ],
            "UTC",
        ),
    );
    expect(f.added_sugar_g).toBe("0");
    expect(f.meal_type).toBe("");
    expect(f.caffeine_mg).toBe("");
});

test("saved_meals.csv quotes a description containing a comma, quote and newline", () => {
    const csv = buildSavedMealsCsv(
        [savedMeal({ description: 'Eggs, "poached"\nwith toast' })],
        "UTC",
    );
    expect(fieldsByName(csv).description).toBe('Eggs, "poached"\nwith toast');
});

test("saved_meals.csv and saved_meal_items.csv align every row with their headers", () => {
    const saved = parseCsv(
        buildSavedMealsCsv(
            [
                savedMeal(),
                savedMeal({
                    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    name: "Plain, bowl",
                    meal_type: null,
                    calories: null,
                    protein_g: null,
                    carbs_g: null,
                    fat_g: null,
                    saturated_fat_g: null,
                    trans_fat_g: null,
                    fiber_g: null,
                    sugar_g: null,
                    added_sugar_g: null,
                    alcohol_g: null,
                    caffeine_mg: null,
                }),
            ],
            "Europe/Berlin",
        ),
    );
    expect(saved).toHaveLength(3);
    for (const row of saved) {
        expect(row.length).toBe(SAVED_MEALS_HEADER.split(",").length);
    }
    const items = parseCsv(
        buildSavedMealItemsCsv([
            savedMealItem(),
            savedMealItem({
                position: 1,
                name: "Shaker; 500 ml",
                amount: null,
                unit: null,
            }),
        ]),
    );
    expect(items).toHaveLength(3);
    for (const row of items) {
        expect(row.length).toBe(SAVED_MEAL_ITEMS_HEADER.split(",").length);
    }
});

test("every saved meal ingredient value lands under its own header name", () => {
    const f = fieldsByName(buildSavedMealItemsCsv([savedMealItem()]));
    expect(f).toEqual({
        saved_meal_id: SAVED_ID,
        position: "2",
        name: "Oat milk",
        amount: "250",
        unit: "ml",
        calories: "120",
        protein_g: "1",
        carbs_g: "16",
        fat_g: "5",
        saturated_fat_g: "3",
        trans_fat_g: "",
        fiber_g: "",
        sugar_g: "",
        added_sugar_g: "",
        alcohol_g: "",
        caffeine_mg: "",
        sodium_mg: "",
        provenance_version: "1",
        nutrient_sources: "",
        source_detail: "",
    });
});

test("header column order is stable and importer-compatible", () => {
    // The importer matches columns by these exact names, so an export must be
    // re-importable without remapping. Renaming a column is a breaking change.
    expect(parseCsv(buildMealsCsv([], "UTC"))[0]).toEqual([
        "id",
        "logged_at",
        "timezone",
        "meal_type",
        "description",
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g",
        "saturated_fat_g",
        "trans_fat_g",
        "fiber_g",
        "sugar_g",
        // Right after sugar_g: the part of it that was added. The importer
        // matches by name, so exports without it still re-import.
        "added_sugar_g",
        "alcohol_g",
        // Between alcohol_g and notes, and spelled with its unit: the importer
        // matches on this exact string, and "caffeine" alone would let a grams
        // column bind to a milligram field.
        "caffeine_mg",
        // Milligrams too, beside caffeine, spelled with its unit for the same
        // reason.
        "sodium_mg",
        "notes",
        // Appended last: the importer matches by name, and a reader that
        // mapped the earlier columns by position is unaffected.
        "saved_meal_id",
        "provenance_version",
        "nutrient_sources",
        "source_detail",
    ]);
});

test("the caffeine header is the importer's own alias, in milligrams", async () => {
    // The re-import contract, checked against the importer rather than against
    // a copy of the name: the widget auto-maps by these aliases, so a rename on
    // either side silently turns a restored backup into a caffeine-less one.
    const { findColumn, normalizeHeader } = await import("./csv.js");
    const header = parseCsv(buildMealsCsv([], "UTC"))[0]!;

    expect(header).toContain("caffeine_mg");
    expect(normalizeHeader("caffeine_mg")).toBe("caffeine_mg");
    // "Caffeine (mg)" is what real exports write; both reach the same key.
    expect(findColumn(header, ["caffeine_mg", "caffeine"])).toBe(
        header.indexOf("caffeine_mg"),
    );
    // A grams spelling must NOT match our header, or a re-import could bind a
    // milligram column to a grams alias and be wrong by 1000x.
    expect(findColumn(header, ["caffeine_g"])).toBe(-1);
});

test("renders timestamps in UTC when tz is UTC", () => {
    const f = fieldsByName(buildMealsCsv([meal()], "UTC"));
    expect(f.logged_at).toBe("2026-06-20 14:30:00");
    expect(f.timezone).toBe("UTC");
});

test("renders timestamps in the user's timezone when set", () => {
    // 14:30 UTC is 16:30 in Berlin (CEST, summer).
    const f = fieldsByName(buildMealsCsv([meal()], "Europe/Berlin"));
    expect(f.logged_at).toBe("2026-06-20 16:30:00");
    expect(f.timezone).toBe("Europe/Berlin");
});

test("leaves null macros and notes as empty fields", () => {
    const f = fieldsByName(
        buildMealsCsv(
            [
                meal({
                    calories: null,
                    protein_g: null,
                    carbs_g: null,
                    fat_g: null,
                    saturated_fat_g: null,
                    trans_fat_g: null,
                    fiber_g: null,
                    sugar_g: null,
                    added_sugar_g: null,
                    alcohol_g: null,
                    caffeine_mg: null,
                    notes: null,
                }),
            ],
            "UTC",
        ),
    );
    for (const name of [
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g",
        "saturated_fat_g",
        "trans_fat_g",
        "fiber_g",
        "sugar_g",
        // NULL on every meal logged before added sugar was tracked: "not
        // recorded", which a 0 would turn into "none added".
        "added_sugar_g",
        "alcohol_g",
        // Every meal logged before caffeine existed carries NULL here, so this
        // is the common case, not an edge one: it must render as an empty cell,
        // never as a 0 that a re-import would read as "definitely no caffeine".
        "caffeine_mg",
        "notes",
    ]) {
        expect(f[name]).toBe("");
    }
    // Nulls stay empty rather than emitting "null"/"undefined".
    expect(buildMealsCsv([meal({ calories: null })], "UTC")).not.toContain(
        "null",
    );
});

test("quotes and escapes fields containing commas, quotes, and newlines", () => {
    const csv = buildMealsCsv(
        [
            meal({
                description: 'Salad, "the big one"',
                notes: "line1\nline2",
            }),
        ],
        "UTC",
    );
    expect(csv).toContain('"Salad, ""the big one"""');
    expect(csv).toContain('"line1\nline2"');
    // ...and the escaping survives a round trip through a real CSV reader,
    // with the embedded newline not splitting the row.
    const f = fieldsByName(csv);
    expect(f.description).toBe('Salad, "the big one"');
    expect(f.notes).toBe("line1\nline2");
    expect(f.fiber_g).toBe("7");
});

// ---------- The rest of the archive ----------
//
// Same shape of test as the meals ones above, applied per file: the header text
// is the contract, and the header/row field counts are what catches a column
// list that has drifted out of step with its positional row builder.

function water(overrides: Partial<WaterEntry> = {}): WaterEntry {
    return {
        id: "22222222-2222-2222-2222-222222222222",
        user_id: "user-1",
        amount_ml: 500,
        logged_at: "2026-06-20T14:30:00.000Z",
        notes: null,
        created_at: "2026-06-20T14:30:05.000Z",
        idempotency_key: null,
        ...overrides,
    };
}

function weight(overrides: Partial<WeightEntry> = {}): WeightEntry {
    return {
        id: "33333333-3333-3333-3333-333333333333",
        user_id: "user-1",
        weight_g: 75000,
        logged_at: "2026-06-20T14:30:00.000Z",
        notes: null,
        created_at: "2026-06-20T14:30:05.000Z",
        idempotency_key: null,
        ...overrides,
    };
}

function measurement(
    overrides: Partial<BodyMeasurementEntry> = {},
): BodyMeasurementEntry {
    return {
        id: "44444444-4444-4444-4444-444444444444",
        user_id: "user-1",
        kind: "waist",
        value_mm: 815,
        value_entered: 81.5,
        entered_unit: "cm",
        logged_at: "2026-06-20T14:30:00.000Z",
        notes: null,
        created_at: "2026-06-20T14:30:05.000Z",
        idempotency_key: null,
        ...overrides,
    };
}

function goals(overrides: Partial<NutritionGoals> = {}): NutritionGoals {
    return {
        user_id: "user-1",
        daily_calories: 2200,
        daily_protein_g: 150,
        daily_carbs_g: 220,
        daily_fat_g: 70,
        daily_saturated_fat_g: 20,
        daily_fiber_g: 30,
        daily_sugar_g: 40,
        daily_added_sugar_g: 25,
        daily_alcohol_g: 14,
        daily_caffeine_mg: 400,
        daily_sodium_mg: 2300,
        daily_water_ml: 2500,
        target_weight_g: 72000,
        updated_at: "2026-06-20T14:30:00.000Z",
        ...overrides,
    };
}

function goalsHistoryRow(
    overrides: Partial<NutritionGoalsHistoryRow> = {},
): NutritionGoalsHistoryRow {
    return {
        effective_at: "2026-06-20T14:30:00.000Z",
        daily_calories: 2200,
        daily_protein_g: 150,
        daily_carbs_g: 220,
        daily_fat_g: 70,
        daily_saturated_fat_g: 20,
        daily_fiber_g: 30,
        daily_sugar_g: 40,
        daily_added_sugar_g: 25,
        daily_alcohol_g: 14,
        daily_caffeine_mg: 400,
        daily_sodium_mg: 2300,
        daily_water_ml: 2500,
        target_weight_g: 72000,
        ...overrides,
    };
}

function profile(overrides: Partial<Profile> = {}): Profile {
    return {
        user_id: "user-1",
        timezone: "Europe/Berlin",
        preferred_weight_unit: "kg",
        widgets_enabled: true,
        alcohol_tracking_enabled: false,
        preferred_drink_unit: "us",
        locale: null,
        preferred_length_unit: null,
        activity_credit_pct: null,
        created_at: "2026-01-02T14:30:00.000Z",
        updated_at: "2026-06-20T14:30:00.000Z",
        ...overrides,
    };
}

const WATER_HEADER = "id,logged_at,timezone,amount_ml,notes,created_at";
const WEIGHT_HEADER =
    "id,logged_at,timezone,weight_g,weight_display,weight_unit,notes,created_at";
const GOALS_HEADER =
    "daily_calories,daily_protein_g,daily_carbs_g,daily_fat_g,daily_saturated_fat_g,daily_fiber_g,daily_sugar_g,daily_added_sugar_g,daily_alcohol_g,daily_caffeine_mg,daily_sodium_mg,daily_water_ml,target_weight_g,updated_at,timezone";
const GOALS_HISTORY_HEADER =
    "effective_at,timezone,daily_calories,daily_protein_g,daily_carbs_g,daily_fat_g,daily_saturated_fat_g,daily_fiber_g,daily_sugar_g,daily_added_sugar_g,daily_alcohol_g,daily_caffeine_mg,daily_sodium_mg,daily_water_ml,target_weight_g";
const PROFILE_HEADER =
    "timezone,preferred_weight_unit,preferred_drink_unit,alcohol_tracking_enabled,widgets_enabled,locale,created_at,updated_at,preferred_length_unit,activity_credit_pct";
const BODY_MEASUREMENT_HEADER =
    "id,logged_at,timezone,kind,value_mm,value_entered,entered_unit,notes,created_at";

test("water.csv header names carry the unit and the zone", () => {
    expect(parseCsv(buildWaterCsv([], "UTC"))[0]).toEqual([
        "id",
        "logged_at",
        "timezone",
        // Not "amount": the number is millilitres, and a header that does not
        // say so is how 500 ml is read back as 500 of something else.
        "amount_ml",
        "notes",
        // When the entry was written, appended so earlier positions hold.
        "created_at",
    ]);
    expect(buildWaterCsv([], "UTC")).toBe(WATER_HEADER);
});

test("water.csv header and data rows have identical field counts", () => {
    const csv = buildWaterCsv(
        [water(), water({ notes: null }), water({ notes: 'a, "b"\nc' })],
        "UTC",
    );
    const rows = parseCsv(csv);
    expect(rows[0]!.length).toBe(WATER_HEADER.split(",").length);
    expect(rows).toHaveLength(4);
    for (const row of rows.slice(1)) {
        expect(row.length).toBe(rows[0]!.length);
    }
});

test("every water value lands under its own header name", () => {
    const f = fieldsByName(
        buildWaterCsv([water({ notes: "after the run" })], "UTC"),
    );
    expect(f).toEqual({
        id: "22222222-2222-2222-2222-222222222222",
        logged_at: "2026-06-20 14:30:00",
        timezone: "UTC",
        amount_ml: "500",
        notes: "after the run",
        created_at: "2026-06-20 14:30:05",
    });
});

test("water.csv renders timestamps in the given zone, even across the date line", () => {
    // 23:30 UTC is already the next calendar day in Tokyo. A wall clock with
    // the wrong date is the failure mode that a "same time, different zone"
    // fixture cannot catch.
    const f = fieldsByName(
        buildWaterCsv(
            [water({ logged_at: "2026-06-20T23:30:00.000Z" })],
            "Asia/Tokyo",
        ),
    );
    expect(f.logged_at).toBe("2026-06-21 08:30:00");
    // The zone column must name the zone the wall clock beside it is in, or
    // the timestamp silently re-resolves against whatever zone reads it (#97).
    expect(f.timezone).toBe("Asia/Tokyo");
});

test("water.csv survives commas, quotes and newlines in notes", () => {
    const f = fieldsByName(
        buildWaterCsv(
            [water({ notes: 'glass, "the big one"\nrefilled' })],
            "UTC",
        ),
    );
    expect(f.notes).toBe('glass, "the big one"\nrefilled');
    expect(f.amount_ml).toBe("500");
});

test("weight.csv header names both the stored grams and the readable value", () => {
    expect(parseCsv(buildWeightCsv([], "UTC", "kg"))[0]).toEqual([
        "id",
        "logged_at",
        "timezone",
        "weight_g",
        "weight_display",
        "weight_unit",
        "notes",
        "created_at",
    ]);
    expect(buildWeightCsv([], "UTC", "kg")).toBe(WEIGHT_HEADER);
});

test("weight.csv header and data rows have identical field counts", () => {
    const csv = buildWeightCsv(
        [weight(), weight({ notes: null }), weight({ notes: 'a, "b"\nc' })],
        "UTC",
        "lb",
    );
    const rows = parseCsv(csv);
    expect(rows[0]!.length).toBe(WEIGHT_HEADER.split(",").length);
    expect(rows).toHaveLength(4);
    for (const row of rows.slice(1)) {
        expect(row.length).toBe(rows[0]!.length);
    }
});

test("weight_display converts the stored grams and weight_unit agrees", () => {
    const kg = fieldsByName(buildWeightCsv([weight()], "UTC", "kg"));
    expect(kg.weight_g).toBe("75000");
    expect(kg.weight_display).toBe("75");
    expect(kg.weight_unit).toBe("kg");

    // Same stored row, other preference: 75000 g is 165.3 lb. The grams column
    // is unchanged — the display column is derived, never the other way round.
    const lb = fieldsByName(buildWeightCsv([weight()], "UTC", "lb"));
    expect(lb.weight_g).toBe("75000");
    expect(lb.weight_display).toBe("165.3");
    expect(lb.weight_unit).toBe("lb");
});

test("every weight value lands under its own header name", () => {
    const f = fieldsByName(
        buildWeightCsv(
            [
                weight({
                    logged_at: "2026-06-20T23:30:00.000Z",
                    notes: "before breakfast",
                }),
            ],
            "Asia/Tokyo",
            "kg",
        ),
    );
    expect(f).toEqual({
        id: "33333333-3333-3333-3333-333333333333",
        logged_at: "2026-06-21 08:30:00",
        timezone: "Asia/Tokyo",
        weight_g: "75000",
        weight_display: "75",
        weight_unit: "kg",
        notes: "before breakfast",
        created_at: "2026-06-20 23:30:05",
    });
});

test("weight.csv survives commas, quotes and newlines in notes", () => {
    const f = fieldsByName(
        buildWeightCsv(
            [weight({ notes: 'fasted, "post-run"\nscale 2' })],
            "UTC",
            "kg",
        ),
    );
    expect(f.notes).toBe('fasted, "post-run"\nscale 2');
    expect(f.weight_display).toBe("75");
});

test("body_measurements.csv is header-only when nothing was measured", () => {
    expect(buildBodyMeasurementsCsv([], "UTC")).toBe(BODY_MEASUREMENT_HEADER);
});

test("body_measurements.csv header and data rows have identical field counts", () => {
    const csv = buildBodyMeasurementsCsv(
        [
            measurement(),
            measurement({ notes: null }),
            measurement({ notes: 'left side, "relaxed"\nafter run' }),
        ],
        "UTC",
    );
    const rows = parseCsv(csv);
    expect(rows[0]!.length).toBe(BODY_MEASUREMENT_HEADER.split(",").length);
    expect(rows).toHaveLength(4);
    for (const row of rows.slice(1)) {
        expect(row.length).toBe(rows[0]!.length);
    }
    expect(fieldsByName(csv, 3).notes).toBe('left side, "relaxed"\nafter run');
});

test("every body measurement value lands under its own header name", () => {
    const f = fieldsByName(
        buildBodyMeasurementsCsv(
            [measurement({ notes: "morning" })],
            "Europe/Berlin",
        ),
    );
    expect(f).toEqual({
        id: "44444444-4444-4444-4444-444444444444",
        logged_at: "2026-06-20 16:30:00",
        timezone: "Europe/Berlin",
        kind: "waist",
        value_mm: "815",
        value_entered: "81.5",
        entered_unit: "cm",
        notes: "morning",
        created_at: "2026-06-20 16:30:05",
    });
});

test("body_measurements.csv keeps an inch entry as typed beside its millimetres", () => {
    const f = fieldsByName(
        buildBodyMeasurementsCsv(
            [
                measurement({
                    value_mm: 819,
                    value_entered: 32.25,
                    entered_unit: "in",
                }),
            ],
            "UTC",
        ),
    );
    expect(f.value_mm).toBe("819");
    expect(f.value_entered).toBe("32.25");
    expect(f.entered_unit).toBe("in");
});

test("goals.csv is header-only when the account has never set goals", () => {
    // Header-only, not absent and not empty: the archive always has the same
    // six files with the same headers, so a reader never has to discover which
    // files this particular export happened to include.
    expect(buildGoalsCsv(null, "UTC")).toBe(GOALS_HEADER);
});

test("goals.csv header and its single row have identical field counts", () => {
    const rows = parseCsv(buildGoalsCsv(goals(), "UTC"));
    expect(rows[0]!.length).toBe(GOALS_HEADER.split(",").length);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.length).toBe(rows[0]!.length);
});

test("every goal value lands under its own header name", () => {
    const f = fieldsByName(buildGoalsCsv(goals(), "Europe/Berlin"));
    expect(f).toEqual({
        daily_calories: "2200",
        daily_protein_g: "150",
        daily_carbs_g: "220",
        daily_fat_g: "70",
        daily_saturated_fat_g: "20",
        daily_fiber_g: "30",
        daily_sugar_g: "40",
        daily_added_sugar_g: "25",
        daily_alcohol_g: "14",
        // Milligrams next to nine gram/ml columns, spelled so in the header.
        daily_caffeine_mg: "400",
        daily_sodium_mg: "2300",
        daily_water_ml: "2500",
        target_weight_g: "72000",
        updated_at: "2026-06-20 16:30:00",
        timezone: "Europe/Berlin",
    });
});

test("goals.csv exports the alcohol target regardless of the display opt-in", () => {
    // The builder takes no preference at all, and that is the point: the
    // alcohol opt-in governs what the tools *show*, while the export promises
    // everything that was logged. A gate here would look like a bug fix and be
    // a data loss.
    const f = fieldsByName(
        buildGoalsCsv(goals({ daily_alcohol_g: 14 }), "UTC"),
    );
    expect(f.daily_alcohol_g).toBe("14");
});

test("goals.csv leaves unset targets as empty fields", () => {
    const csv = buildGoalsCsv(
        goals({
            daily_calories: null,
            daily_protein_g: null,
            daily_carbs_g: null,
            daily_fat_g: null,
            daily_saturated_fat_g: null,
            daily_fiber_g: null,
            daily_sugar_g: null,
            daily_added_sugar_g: null,
            daily_alcohol_g: null,
            daily_caffeine_mg: null,
            daily_sodium_mg: null,
            daily_water_ml: null,
            target_weight_g: null,
        }),
        "UTC",
    );
    const f = fieldsByName(csv);
    for (const name of GOALS_HEADER.split(",")) {
        if (name === "updated_at" || name === "timezone") continue;
        expect(f[name]).toBe("");
    }
    expect(csv).not.toContain("null");
});

test("goals_history.csv is header-only when goals were never set", () => {
    expect(buildGoalsHistoryCsv([], "UTC")).toBe(GOALS_HISTORY_HEADER);
});

test("goals_history.csv names the goal columns exactly as goals.csv does", () => {
    // Same names and units, so one mapping reads both files; the history
    // swaps updated_at for effective_at and leads with the instant and zone.
    const goalCols = GOALS_HEADER.split(",").filter(
        (c) => c !== "updated_at" && c !== "timezone",
    );
    expect(GOALS_HISTORY_HEADER.split(",")).toEqual([
        "effective_at",
        "timezone",
        ...goalCols,
    ]);
});

test("goals_history.csv is byte-for-byte what its rows and zone determine", () => {
    const history = [
        goalsHistoryRow({ effective_at: "2026-01-05T08:00:00.000Z" }),
        goalsHistoryRow({
            effective_at: "2026-06-20T14:30:00.000Z",
            daily_calories: 2000,
            daily_sugar_g: null,
            daily_added_sugar_g: null,
            daily_alcohol_g: null,
            target_weight_g: null,
        }),
    ];
    const csv = buildGoalsHistoryCsv(history, "Europe/Berlin");
    expect(csv).toBe(
        [
            GOALS_HISTORY_HEADER,
            "2026-01-05 09:00:00,Europe/Berlin,2200,150,220,70,20,30,40,25,14,400,2300,2500,72000",
            "2026-06-20 16:30:00,Europe/Berlin,2000,150,220,70,20,30,,,,400,2300,2500,",
        ].join("\n"),
    );
    // Same inputs, same bytes: nothing in it depends on the clock or the host.
    expect(buildGoalsHistoryCsv(history, "Europe/Berlin")).toBe(csv);
});

test("goals_history.csv keeps the order it is given and aligns every field", () => {
    const rows = parseCsv(
        buildGoalsHistoryCsv(
            [
                goalsHistoryRow({ effective_at: "2026-01-01T00:00:00.000Z" }),
                goalsHistoryRow({ effective_at: "2026-02-01T00:00:00.000Z" }),
                goalsHistoryRow({ effective_at: "2026-03-01T00:00:00.000Z" }),
            ],
            "UTC",
        ),
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.length).toBe(rows[0]!.length);
    expect(rows.slice(1).map((r) => r[0])).toEqual([
        "2026-01-01 00:00:00",
        "2026-02-01 00:00:00",
        "2026-03-01 00:00:00",
    ]);
});

test("every goals history value lands under its own header name", () => {
    const f = fieldsByName(
        buildGoalsHistoryCsv([goalsHistoryRow()], "Europe/Berlin"),
    );
    expect(f).toEqual({
        effective_at: "2026-06-20 16:30:00",
        timezone: "Europe/Berlin",
        daily_calories: "2200",
        daily_protein_g: "150",
        daily_carbs_g: "220",
        daily_fat_g: "70",
        daily_saturated_fat_g: "20",
        daily_fiber_g: "30",
        daily_sugar_g: "40",
        daily_added_sugar_g: "25",
        // Not gated on the alcohol display opt-in, exactly like goals.csv.
        daily_alcohol_g: "14",
        daily_caffeine_mg: "400",
        daily_sodium_mg: "2300",
        daily_water_ml: "2500",
        // Canonical grams, as in goals.csv — no weight-unit conversion.
        target_weight_g: "72000",
    });
});

test("profile.csv is header-only when there is no profile row", () => {
    expect(buildProfileCsv(null, "UTC")).toBe(PROFILE_HEADER);
});

test("profile.csv header and its single row have identical field counts", () => {
    const rows = parseCsv(buildProfileCsv(profile(), "UTC"));
    expect(rows[0]!.length).toBe(PROFILE_HEADER.split(",").length);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.length).toBe(rows[0]!.length);
});

test("every profile value lands under its own header name", () => {
    const f = fieldsByName(buildProfileCsv(profile(), "Europe/Berlin"));
    expect(f).toEqual({
        timezone: "Europe/Berlin",
        preferred_weight_unit: "kg",
        preferred_drink_unit: "us",
        // A toggle that is off must read "false", not blank: blank is what an
        // unset preference looks like, and the two are different facts.
        alcohol_tracking_enabled: "false",
        widgets_enabled: "true",
        // Never ran set_language: empty, not a defaulted "en".
        locale: "",
        created_at: "2026-01-02 15:30:00",
        updated_at: "2026-06-20 16:30:00",
        // Never ran set_length_unit: empty, not derived from the weight unit.
        preferred_length_unit: "",
        // Never chosen: empty, the same as the other unset preferences.
        activity_credit_pct: "",
    });
});

test("profile.csv carries the chosen length unit", () => {
    const f = fieldsByName(
        buildProfileCsv(profile({ preferred_length_unit: "in" }), "UTC"),
    );
    expect(f.preferred_length_unit).toBe("in");
    expect(f.preferred_weight_unit).toBe("kg");
});

// The privacy policy says the export holds your settings; the widget
// language is one of them.
test("profile.csv carries the chosen widget language", () => {
    const f = fieldsByName(buildProfileCsv(profile({ locale: "uk" }), "UTC"));
    expect(f.locale).toBe("uk");
});

const README_OPTS = {
    generatedAt: new Date("2026-06-20T14:30:00.000Z"),
    tz: "Europe/Berlin",
    tzConfigured: true,
    weightUnit: "kg" as const,
    counts: {
        meals: 120,
        mealItems: 31,
        savedMeals: 9,
        savedMealItems: 14,
        water: 45,
        activeCalories: 5,
        weight: 12,
        bodyMeasurements: 7,
        goalsHistory: 4,
        connections: 2,
        healthSync: 6,
    },
};

test("README.txt says what the archive leaves out", () => {
    const readme = buildExportReadme(README_OPTS);
    expect(readme).toContain("Not in this archive");
    expect(readme).toContain("everything this server stores about you");
    expect(readme).toContain("server runtime log");
    expect(readme).toContain("never an access key");
    expect(readme).toContain("internal bookkeeping");
    expect(readme).not.toMatch(/sign-in|password|email/i);
});

test("the README names every file in the archive", () => {
    const readme = buildExportReadme(README_OPTS);
    for (const name of EXPORT_ARCHIVE_FILES) {
        expect(readme).toContain(name);
    }
});

test("the README states when, in which zone, and that the zone was chosen", () => {
    const readme = buildExportReadme(README_OPTS);
    expect(readme).toContain("2026-06-20 16:30:00");
    expect(readme).toContain("Europe/Berlin");
    expect(readme).toContain("120 rows");
    expect(readme).toContain("45 rows");
    expect(readme).toContain("12 rows");
    expect(readme).toContain("7 rows");
    expect(readme).toContain("connections.csv 2 rows");
    expect(readme).toContain("health_sync.csv 6 rows");
    expect(readme).toContain("goals_history.csv 4 rows");
});

test("the README says outright when the zone defaulted to UTC", () => {
    // An unconfigured timezone silently means UTC everywhere in this server,
    // and someone reading their own wall clocks back has to be told before they
    // interpret a single timestamp.
    const readme = buildExportReadme({
        ...README_OPTS,
        tz: "UTC",
        tzConfigured: false,
    });
    expect(readme).toContain("No timezone has ever been set");
    expect(readme).toContain("set_timezone");
});

test("the README spells out the mixed units", () => {
    const readme = buildExportReadme(README_OPTS);
    expect(readme).toContain("MILLIGRAMS");
    expect(readme).toContain("caffeine_mg");
    expect(readme).toContain("amount_ml");
    expect(readme).toContain("ethanol");
    expect(readme).toContain("weight_g");
    expect(readme).toContain("value_mm");
    // Added sugar is a part of sugar_g, not a sibling to sum with it.
    expect(readme).toMatch(
        /added_sugar_g counts only sugars added[^\n]*part of sugar_g[^\n]*daily_added_sugar_g is the daily limit for added sugars, separate from daily_sugar_g/,
    );
    // Sodium is milligrams, and is sodium rather than salt.
    expect(readme).toMatch(
        /sodium_mg and daily_sodium_mg are MILLIGRAMS of sodium, not salt[^\n]*daily_sodium_mg is the daily limit for sodium/,
    );
});

test("the README says only meals.csv can be re-imported", () => {
    const readme = buildExportReadme(README_OPTS);
    expect(readme).toContain("Only meals.csv can be read back in");
    expect(readme).toContain("start_meal_import");
    expect(readme).toContain("bulk_import_meals");
    expect(readme).toContain("export-only");
});

test("the README counts and joins the meal ingredient and saved meal files", () => {
    const readme = buildExportReadme(README_OPTS);
    expect(readme).toContain("meal_items.csv 31 rows");
    expect(readme).toContain("saved_meals.csv 9 rows");
    expect(readme).toContain("saved_meal_items.csv 14 rows");
    // Each join key is named, so the files can be read together.
    expect(readme).toContain("Joined to meals.csv by meal_id");
    expect(readme).toContain("joined to saved_meals.csv by saved_meal_id");
    expect(readme).toContain(
        "saved_meal_id, the saved meal it was logged from",
    );
    // Stored calorie totals are whole numbers while ingredient calories keep
    // their decimals, so the README never promises an exact sum (C19).
    expect(readme).not.toContain(
        "A meal's totals in meals.csv are the sum of its ingredients.",
    );
    expect(readme).toContain(
        "with calories rounded to a whole number and the other values to two decimals",
    );
    expect(readme).toContain(
        "its values in saved_meals.csv are their sum, rounded the same way",
    );
    // Editing or deleting a saved meal leaves logged meals alone, and the
    // README says so next to the file it describes.
    expect(readme).toContain("does not change meals you already logged");
    // The ingredients have no import path, and the export-only sentence says so.
    expect(readme).toMatch(
        /export-only — there is no import path for meal ingredients, saved meals/,
    );
});

// No column in the archive may be named after a secret. The export is a copy
// of the user's data, not a set of credentials, and the token/code columns
// hold hashes that are secrets-adjacent all the same.
const SECRET_HEADER = /token$|^code|hash|secret|password|challenge|verifier/i;

test("connections.csv, health_sync.csv and goals_history.csv are header-only when empty", () => {
    for (const csv of [
        buildConnectionsCsv("UTC"),
        buildConnectionsCsv("UTC", null),
        buildHealthSyncCsv([], "UTC"),
        buildGoalsHistoryCsv([], "UTC"),
    ]) {
        const rows = parseCsv(csv);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.length).toBeGreaterThan(1);
    }
});

test("no archive file has a token, hash or password column", () => {
    const headers = [
        buildMealsCsv([], "UTC"),
        buildWaterCsv([], "UTC"),
        buildWeightCsv([], "UTC", "kg"),
        buildGoalsCsv(null, "UTC"),
        buildGoalsHistoryCsv([], "UTC"),
        buildProfileCsv(null, "UTC"),
        buildConnectionsCsv("UTC"),
        buildHealthSyncCsv([], "UTC"),
    ].flatMap((csv) => parseCsv(csv)[0]!);
    for (const name of headers) expect(name).not.toMatch(SECRET_HEADER);
});

test("the activity shortcut's link is its own row, with no fields or start date", () => {
    const csv = buildConnectionsCsv("UTC", null, {
        fallback_tz: "Europe/Kyiv",
        created_at: "2026-11-02T10:00:00.000Z",
        last_used_at: "2026-11-02T11:00:00.000Z",
        last_sync_at: "2026-11-02T11:00:00.000Z",
        expires_at: "2027-01-31T11:00:00.000Z",
    });
    expect(fieldsByName(csv, 1)).toEqual({
        kind: "health_activity_sync",
        name: "Apple Health activity sync (iOS Shortcut)",
        created_at: "2026-11-02 10:00:00",
        expires_at: "2027-01-31 11:00:00",
        last_used_at: "2026-11-02 11:00:00",
        last_sync_at: "2026-11-02 11:00:00",
        timezone: "UTC",
        synced_fields: "",
        sync_start_date: "",
        device_timezone: "Europe/Kyiv",
    });
});

// ---------- The archive ----------

/**
 * Minimal ZIP reader: seek the EOCD, walk the central directory, follow each
 * record's offset to its payload. `src/zip.test.ts` is where the format itself
 * is verified against the spec; here all that is needed is names and contents.
 */
function readZipEntries(buf: Uint8Array): { name: string; content: string }[] {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const decoder = new TextDecoder();
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    expect(eocd).toBeGreaterThanOrEqual(0);

    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const out: { name: string; content: string }[] = [];
    for (let i = 0; i < count; i++) {
        expect(view.getUint32(p, true)).toBe(0x02014b50);
        const size = view.getUint32(p + 24, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const localOffset = view.getUint32(p + 42, true);
        const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;

        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLen + localExtraLen;
        out.push({
            name,
            content: decoder.decode(buf.subarray(start, start + size)),
        });
    }
    return out;
}

test("EXPORT_ARCHIVE_FILES is the archive's real, ordered file list", () => {
    // The constant exists so the tool text and the site copy can pin their
    // claim to the archive instead of restating it; `exportAllData` builds its
    // entries by mapping over it, keyed by a Record typed on this same list, so
    // a file added on one side without the other is a compile error.
    expect([...EXPORT_ARCHIVE_FILES]).toEqual([
        "meals.csv",
        "meal_items.csv",
        "saved_meals.csv",
        "saved_meal_items.csv",
        "water.csv",
        "active_calories.csv",
        "weight.csv",
        "body_measurements.csv",
        "goals.csv",
        "goals_history.csv",
        "profile.csv",
        "connections.csv",
        "health_sync.csv",
        "README.txt",
    ]);
});

test("an archive assembled from the builders reads back file for file", () => {
    // The same assembly `exportAllData` performs, minus the database reads: every builder's output goes in under its name in the constant's
    // order, and comes back out intact.
    const tz = "Europe/Berlin";
    const contents: Record<string, string> = {
        "meals.csv": buildMealsCsv([meal()], tz),
        "meal_items.csv": buildMealItemsCsv([mealItem()]),
        "saved_meals.csv": buildSavedMealsCsv([savedMeal()], tz),
        "saved_meal_items.csv": buildSavedMealItemsCsv([savedMealItem()]),
        "water.csv": buildWaterCsv([water()], tz),
        "active_calories.csv": buildActiveCaloriesCsv([activeCalories()], tz),
        "weight.csv": buildWeightCsv([weight()], tz, "kg"),
        "body_measurements.csv": buildBodyMeasurementsCsv([measurement()], tz),
        "goals.csv": buildGoalsCsv(goals(), tz),
        "goals_history.csv": buildGoalsHistoryCsv([goalsHistoryRow()], tz),
        "profile.csv": buildProfileCsv(profile(), tz),
        "connections.csv": buildConnectionsCsv(tz, healthLink()),
        "health_sync.csv": buildHealthSyncCsv([healthDay()], tz),
        "README.txt": buildExportReadme(README_OPTS),
    };
    const entries = readZipEntries(
        buildZip(
            EXPORT_ARCHIVE_FILES.map((name) => ({
                name,
                data: contents[name]!,
            })),
            new Date("2026-06-20T14:30:00.000Z"),
        ),
    );

    expect(entries.map((e) => e.name)).toEqual([...EXPORT_ARCHIVE_FILES]);
    for (const entry of entries) {
        expect(entry.content).toBe(contents[entry.name]!);
    }
    // The archived meal file must be the same bytes export_meals hands out, or
    // the one file in here that is re-importable quietly stops being so.
    expect(entries[0]!.content).toBe(buildMealsCsv([meal()], tz));
    // Every CSV in the archive carries its header even when its table is empty.
    for (const csv of [
        "meals.csv",
        "meal_items.csv",
        "saved_meals.csv",
        "saved_meal_items.csv",
        "water.csv",
        "active_calories.csv",
        "weight.csv",
        "body_measurements.csv",
        "goals_history.csv",
        "connections.csv",
        "health_sync.csv",
    ] as const) {
        expect(contents[csv]!.split("\n")[0]).not.toBe("");
    }
});

// ---------- Apple Health sync: health_sync.csv and the connections row ----------

function healthLink(
    over: Partial<HealthSyncLinkStatus> = {},
): HealthSyncLinkStatus {
    return {
        kind: "shortcut",
        fields: ["energy_kcal", "protein_g", "water_ml"],
        fallback_tz: "Europe/Kyiv",
        sync_start_date: "2026-09-26",
        created_at: "2026-09-27T06:00:00.000Z",
        last_used_at: "2026-10-02T05:10:00.000Z",
        last_sync_at: "2026-10-02T05:10:30.000Z",
        expires_at: "2026-12-31T05:10:00.000Z",
        sent_through: "2026-10-01",
        ...over,
    };
}

function healthDay(over: Partial<HealthSyncDayRow> = {}): HealthSyncDayRow {
    return {
        user_id: "user-1",
        date: "2026-10-01",
        timezone: "Europe/Kyiv",
        sent_values: { energy_kcal: 2140, protein_g: 96.5, water_ml: 1800 },
        topup_seq: 1,
        offer_count: 2,
        notified: { stuck: "2026-10-01:t1" },
        first_sent_at: "2026-10-02T02:05:00.000Z",
        last_sent_at: "2026-10-02T09:00:00.000Z",
        ...over,
    };
}

test("the health_sync link is one connections row of its own kind, never its token", () => {
    const csv = buildConnectionsCsv("Europe/Berlin", healthLink());
    expect(parseCsv(csv)).toHaveLength(2);
    expect(fieldsByName(csv, 1)).toEqual({
        kind: "health_sync",
        name: "Apple Health sync (iOS Shortcut)",
        created_at: "2026-09-27 08:00:00",
        expires_at: "2026-12-31 06:10:00",
        last_used_at: "2026-10-02 07:10:00",
        last_sync_at: "2026-10-02 07:10:30",
        timezone: "Europe/Berlin",
        synced_fields: "energy_kcal protein_g water_ml",
        sync_start_date: "2026-09-26",
        // A stored setting, not the render zone of the row's timestamps.
        device_timezone: "Europe/Kyiv",
    });
    expect(csv).not.toMatch(/nmhs_|token_hash/);
});

test("a never-used, never-synced link leaves those cells empty", () => {
    const f = fieldsByName(
        buildConnectionsCsv(
            "UTC",
            healthLink({
                last_used_at: null,
                last_sync_at: null,
                fallback_tz: null,
            }),
        ),
    );
    expect(f.kind).toBe("health_sync");
    expect(f.last_used_at).toBe("");
    expect(f.last_sync_at).toBe("");
    expect(f.device_timezone).toBe("");
});

test("health_sync.csv columns are the date, its zone, every field and the send record", () => {
    expect(parseCsv(buildHealthSyncCsv([], "UTC"))[0]).toEqual([
        "date",
        "timezone",
        ...HEALTH_SYNC_FIELDS,
        "topup_seq",
        "first_sent_at",
        "last_sent_at",
    ]);
    // Alcohol is never sent, so it never gets a column.
    expect(buildHealthSyncCsv([], "UTC")).not.toContain("alcohol");
});

test("a health_sync row is rendered in the day's own zone, with absent values empty", () => {
    // The account is on Berlin; the day was counted in Kyiv and says so.
    const f = fieldsByName(buildHealthSyncCsv([healthDay()], "Europe/Berlin"));
    expect(f).toEqual({
        date: "2026-10-01",
        timezone: "Europe/Kyiv",
        energy_kcal: "2140",
        protein_g: "96.5",
        // Not sent is not zero.
        carbohydrates_g: "",
        fat_g: "",
        fiber_g: "",
        caffeine_mg: "",
        water_ml: "1800",
        topup_seq: "1",
        first_sent_at: "2026-10-02 05:05:00",
        last_sent_at: "2026-10-02 12:00:00",
    });
});

test("a zero that was sent stays a 0, and an offered-but-unacked day is empty", () => {
    const csv = buildHealthSyncCsv(
        [
            healthDay({ sent_values: { energy_kcal: 0 } }),
            healthDay({
                date: "2026-10-02",
                sent_values: null,
                topup_seq: 0,
                first_sent_at: null,
                last_sent_at: null,
            }),
        ],
        "UTC",
    );
    expect(fieldsByName(csv, 1).energy_kcal).toBe("0");
    const unacked = fieldsByName(csv, 2);
    for (const f of HEALTH_SYNC_FIELDS) expect(unacked[f]).toBe("");
    expect(unacked.first_sent_at).toBe("");
    expect(unacked.last_sent_at).toBe("");
});

test("a row holding an unknown zone falls back to the account's instead of failing the export", () => {
    const f = fieldsByName(
        buildHealthSyncCsv([healthDay({ timezone: "Not/AZone" })], "UTC"),
    );
    expect(f.timezone).toBe("UTC");
    expect(f.first_sent_at).toBe("2026-10-02 02:05:00");
});

test("the README describes health_sync.csv, its own-zone rows and its retention", () => {
    const readme = buildExportReadme(README_OPTS);
    expect(readme).toContain("health_sync.csv 6 rows");
    expect(readme).toContain("kept for 8 days");
    expect(readme).toContain('its own "timezone"');
    expect(readme).toContain("except in health_sync.csv");
    expect(readme).toContain("Apple Health shortcut links");
    expect(readme).toContain("water_ml are millilitres");
    expect(readme).toContain("Alcohol is never sent");
    // The token and the bookkeeping are named among what is NOT exported.
    expect(readme).toContain("link tokens");
    expect(readme).toContain("Apple Health sync connect request");
});

// exportAllData reads everything else from the (in-memory) database; the
// health-sync store is injected only to prove it is consulted and that its
// failure is not swallowed into a partial archive.
describe("exportAllData", () => {
    useMemoryDb();
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "exp-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("asks the injected stores and fails loudly with them", async () => {
        const asked: string[] = [];
        const store = {
            getLinkStatus: async (userId: string) => {
                asked.push(`link:${userId}`);
                return null;
            },
            getDaysForExport: async (userId: string) => {
                asked.push(`days:${userId}`);
                throw new Error(
                    "health sync days: result would be truncated (64 of 65)",
                );
            },
        } as unknown as HealthSyncStore;
        await expect(
            exportAllData("user-9", {
                healthSync: store,
                dataDir: dir,
                secret: "s".repeat(32),
                getGoalsHistory: async (userId: string) => {
                    asked.push(`goals-history:${userId}`);
                    return [];
                },
            }),
        ).rejects.toThrow("result would be truncated");
        expect(asked.sort()).toEqual([
            "days:user-9",
            "goals-history:user-9",
            "link:user-9",
        ]);
    });

    test("an owner with nothing stored gets no archive and no link", async () => {
        const r = await exportAllData(OWNER_ID, {
            dataDir: dir,
            secret: "s".repeat(32),
        });
        expect(r.path).toBeUndefined();
        expect(r.url).toBeUndefined();
        expect(existsSync(join(dir, "exports"))).toBe(false);
    });

    test("writes the real ZIP under DATA_DIR/exports and returns a verifiable, expiring link", async () => {
        await insertMeal(OWNER_ID, {
            description: "porridge",
            meal_type: "breakfast",
            calories: 300,
            logged_at: "2026-03-14T08:00:00.000Z",
        });
        await insertWater(OWNER_ID, {
            amount_ml: 250,
            logged_at: "2026-03-14T09:00:00.000Z",
        });
        const secret = "k".repeat(32);
        const now = new Date("2026-03-14T10:00:00.000Z");
        const r = await exportAllData(OWNER_ID, {
            dataDir: dir,
            secret,
            now,
        });
        expect(r.counts).toMatchObject({ meals: 1, water: 1 });
        expect(r.path).toMatch(/^\/exports\/download\?exp=\d+&sig=[\w-]+$/);

        const rel = exportArchivePath(OWNER_ID);
        const file = join(dir, "exports", rel);
        const entries = readZipEntries(new Uint8Array(readFileSync(file)));
        expect(entries.map((e) => e.name)).toEqual([...EXPORT_ARCHIVE_FILES]);
        expect(entries.find((e) => e.name === "meals.csv")!.content).toContain(
            "porridge",
        );
        // The archive holds no account or telemetry material.
        expect(entries.some((e) => /account|telemetry/.test(e.name))).toBe(
            false,
        );

        const q = new URL(r.path!, "http://x").searchParams;
        expect(
            verifyExportLink(secret, rel, q.get("exp")!, q.get("sig")!, now),
        ).toBe(true);
        // wrong secret, tampered expiry, other path, and after the hour: all refused
        expect(
            verifyExportLink(
                "z".repeat(32),
                rel,
                q.get("exp")!,
                q.get("sig")!,
                now,
            ),
        ).toBe(false);
        expect(
            verifyExportLink(
                secret,
                rel,
                String(Number(q.get("exp")) + 1),
                q.get("sig")!,
                now,
            ),
        ).toBe(false);
        expect(
            verifyExportLink(
                secret,
                "other/file.zip",
                q.get("exp")!,
                q.get("sig")!,
                now,
            ),
        ).toBe(false);
        expect(
            verifyExportLink(
                secret,
                rel,
                q.get("exp")!,
                q.get("sig")!,
                new Date(now.getTime() + 61 * 60_000),
            ),
        ).toBe(false);
    });

    test("a second export overwrites the first (one archive per owner)", async () => {
        await insertWater(OWNER_ID, {
            amount_ml: 100,
            logged_at: "2026-03-14T09:00:00.000Z",
        });
        const opts = { dataDir: dir, secret: "k".repeat(32) };
        await exportAllData(OWNER_ID, opts);
        await insertWater(OWNER_ID, {
            amount_ml: 200,
            logged_at: "2026-03-14T10:00:00.000Z",
        });
        await exportAllData(OWNER_ID, opts);
        const files = readdirSync(join(dir, "exports", OWNER_ID));
        expect(files).toEqual(["nutrition-mcp-export.zip"]);
    });

    test("PUBLIC_URL, when set, prefixes the returned url", async () => {
        await insertWater(OWNER_ID, {
            amount_ml: 100,
            logged_at: "2026-03-14T09:00:00.000Z",
        });
        const prev = process.env.PUBLIC_URL;
        process.env.PUBLIC_URL = "https://food.example.org/";
        try {
            const r = await exportAllData(OWNER_ID, {
                dataDir: dir,
                secret: "k".repeat(32),
            });
            expect(r.url).toBe(`https://food.example.org${r.path}`);
        } finally {
            if (prev === undefined) delete process.env.PUBLIC_URL;
            else process.env.PUBLIC_URL = prev;
        }
    });
});

// ---------- provenance columns ----------

const PROVENANCE_DETAIL = {
    "usda:171477": {
        name: '=HYPERLINK("https://example.test")',
        data_type: "SR Legacy",
        amount_g: 150,
        fetched_at: "2026-09-01T00:00:00.000Z",
    },
    "openfoodfacts:4006040070207": {
        name: "@cmd Oat drink",
        amount_g: 250,
        fetched_at: "2026-09-02T00:00:00.000Z",
    },
};

test("meals.csv writes the labels as JSON and defuses each name inside source_detail", () => {
    const f = fieldsByName(
        buildMealsCsv(
            [
                meal({
                    nutrient_sources: {
                        calories: { s: "usda", ref: "171477" },
                        protein_g: { s: "estimate" },
                        fat_g: {
                            s: "mixed",
                            parts: [
                                { s: "usda", share: 70 },
                                { s: "user", share: 30 },
                            ],
                        },
                    },
                    source_detail: PROVENANCE_DETAIL,
                }),
            ],
            "UTC",
        ),
    );
    expect(f.provenance_version).toBe("1");
    expect(JSON.parse(f.nutrient_sources!)).toEqual({
        calories: { s: "usda", ref: "171477" },
        protein_g: { s: "estimate" },
        fat_g: {
            s: "mixed",
            parts: [
                { s: "usda", share: 70 },
                { s: "user", share: 30 },
            ],
        },
    });
    const detail = JSON.parse(f.source_detail!);
    // A name a spreadsheet would read as a formula gets the apostrophe; the
    // others are kept as they are.
    expect(detail["usda:171477"].name).toBe(
        '\'=HYPERLINK("https://example.test")',
    );
    expect(detail["openfoodfacts:4006040070207"].name).toBe("'@cmd Oat drink");
    expect(detail["usda:171477"].amount_g).toBe(150);
    expect(detail["usda:171477"].data_type).toBe("SR Legacy");
});

test("a row with no provenance writes the marker and two empty JSON cells", () => {
    const f = fieldsByName(buildMealsCsv([meal()], "UTC"));
    expect(f.provenance_version).toBe("1");
    expect(f.nutrient_sources).toBe("");
    expect(f.source_detail).toBe("");
});

test("ingredient and saved meal rows carry their own labels, defused the same way", () => {
    const itemCsv = buildMealItemsCsv([
        mealItem({
            nutrient_sources: {
                calories: { s: "openfoodfacts", ref: "4006040070207" },
            },
            source_detail: PROVENANCE_DETAIL,
        }),
    ]);
    const fi = fieldsByName(itemCsv);
    expect(fi.provenance_version).toBe("1");
    expect(JSON.parse(fi.nutrient_sources!)).toEqual({
        calories: { s: "openfoodfacts", ref: "4006040070207" },
    });
    expect(JSON.parse(fi.source_detail!)["usda:171477"].name).toBe(
        '\'=HYPERLINK("https://example.test")',
    );

    const fs = fieldsByName(
        buildSavedMealsCsv(
            [savedMeal({ nutrient_sources: { fat_g: { s: "user" } } })],
            "UTC",
        ),
    );
    expect(JSON.parse(fs.nutrient_sources!)).toEqual({ fat_g: { s: "user" } });
    expect(fs.source_detail).toBe("");

    const fsi = fieldsByName(
        buildSavedMealItemsCsv([
            savedMealItem({ source_detail: PROVENANCE_DETAIL }),
        ]),
    );
    expect(fsi.provenance_version).toBe("1");
    expect(
        JSON.parse(fsi.source_detail!)["openfoodfacts:4006040070207"].name,
    ).toBe("'@cmd Oat drink");
});

test("the README describes the provenance columns", () => {
    const readme = buildExportReadme(README_OPTS);
    expect(readme).toContain("Where the values came from");
    expect(readme).toContain("nutrient_sources");
    expect(readme).toContain("source_detail");
    expect(readme).toContain("provenance_version");
});

// ---------- active calories (issue #220) ----------

function activeCalories(
    overrides: Partial<{
        id: string;
        logged_at: string;
        kcal: number;
        credit_pct: number;
        notes: string | null;
        created_at: string;
        source: string | null;
        source_date: string | null;
    }> = {},
) {
    return {
        id: "33333333-3333-3333-3333-333333333333",
        logged_at: "2026-06-20T14:30:00.000Z",
        kcal: 400,
        credit_pct: 80,
        notes: null,
        created_at: "2026-06-20T14:30:05.000Z",
        ...overrides,
    };
}

const ACTIVE_CALORIES_HEADER =
    "id,logged_at,timezone,kcal,credit_pct,credited_kcal,notes,created_at,source,source_date";

test("active_calories.csv marks an Apple Health day total and leaves manual rows empty", () => {
    const rows = parseCsv(
        buildActiveCaloriesCsv(
            [
                activeCalories(),
                activeCalories({
                    source: "apple_health",
                    source_date: "2026-06-20",
                }),
            ],
            "UTC",
        ),
    );
    const at = (r: string[], name: string) => r[rows[0]!.indexOf(name)];
    expect(at(rows[1]!, "source")).toBe("");
    expect(at(rows[1]!, "source_date")).toBe("");
    expect(at(rows[2]!, "source")).toBe("apple_health");
    expect(at(rows[2]!, "source_date")).toBe("2026-06-20");
});

test("active_calories.csv header names every column, the credited figure included", () => {
    expect(buildActiveCaloriesCsv([], "UTC")).toBe(ACTIVE_CALORIES_HEADER);
});

test("active_calories.csv header and data rows have identical field counts", () => {
    const rows = parseCsv(
        buildActiveCaloriesCsv(
            [activeCalories(), activeCalories({ notes: 'a, "b"\nc' })],
            "UTC",
        ),
    );
    expect(rows[0]!.length).toBe(ACTIVE_CALORIES_HEADER.split(",").length);
    expect(rows).toHaveLength(3);
    for (const row of rows.slice(1)) {
        expect(row.length).toBe(rows[0]!.length);
    }
});

test("active_calories.csv credited_kcal is the rounded share, and the zone rides beside the clock", () => {
    const f = fieldsByName(
        buildActiveCaloriesCsv(
            [
                activeCalories({
                    logged_at: "2026-06-20T23:30:00.000Z",
                    kcal: 333,
                    credit_pct: 50,
                }),
            ],
            "Asia/Tokyo",
        ),
    );
    expect(f.logged_at).toBe("2026-06-21 08:30:00");
    expect(f.timezone).toBe("Asia/Tokyo");
    expect(f.kcal).toBe("333");
    expect(f.credit_pct).toBe("50");
    // 333 * 50 / 100 = 166.5, rounded to a whole kcal.
    expect(f.credited_kcal).toBe("167");
    expect(f.notes).toBe("");
});
