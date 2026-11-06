/**
 * Table-driven proof that every CHECK / NOT NULL / UNIQUE / FK / type rule of
 * the schema is live. Each case inserts a row that is valid except for ONE
 * column and expects the specific kind of rejection, so a constraint that is
 * dropped (or replaced by an unrelated error) fails a named test. The positive
 * control per table proves the base row itself is valid. Migration 1 is
 * append-only once a database exists, so a silently dropped rule here would be
 * permanent.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "./migrate";
import { OWNER_ID } from "./owner";

type Row = Record<string, unknown>;
const U = OWNER_ID;
const CHECK = /CHECK constraint failed/;
const NOTNULL = /NOT NULL constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;
const FK = /FOREIGN KEY constraint failed/;
const TYPE = /cannot store .* value in .* column|datatype mismatch/;

function insert(db: Database, table: string, row: Row): void {
    const cols = Object.keys(row);
    db.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ).run(...(Object.values(row) as never[]));
}

const mealParent = (db: Database): string => {
    const id = "11111111-1111-4111-8111-111111111111";
    insert(db, "meals", { id, user_id: U, description: "m" });
    return id;
};
const savedParent = (db: Database): string => {
    const id = "22222222-2222-4222-8222-222222222222";
    insert(db, "saved_meals", {
        id,
        user_id: U,
        name: "s",
        name_key: "s",
        description: "d",
    });
    return id;
};

const ITEM = {
    user_id: U,
    position: 1,
    name: "i",
    calories: 1,
    protein_g: 1,
    carbs_g: 1,
    fat_g: 1,
};
const NOW = "2026-03-14T10:00:00.000Z";

const BASES: Record<string, (db: Database) => Row> = {
    saved_meals: () => ({
        user_id: U,
        name: "n",
        name_key: "n",
        description: "d",
    }),
    meals: () => ({ user_id: U, description: "d" }),
    meal_items: (db) => ({ ...ITEM, meal_id: mealParent(db) }),
    saved_meal_items: (db) => ({ ...ITEM, saved_meal_id: savedParent(db) }),
    nutrition_goals: () => ({ user_id: U }),
    nutrition_goals_history: () => ({ user_id: U }),
    water_log: () => ({ user_id: U, amount_ml: 250 }),
    weight_log: () => ({ user_id: U, weight_g: 80000 }),
    body_measurement_log: () => ({
        user_id: U,
        kind: "waist",
        value_mm: 800,
        value_entered: 80,
        entered_unit: "cm",
    }),
    active_calories_log: () => ({ user_id: U, kcal: 100, credit_pct: 100 }),
    profiles: () => ({ user_id: U }),
    food_cache: () => ({ source: "usda", source_id: "1", payload: "{}" }),
    health_sync_state: () => ({ user_id: U }),
    health_sync_days: () => ({
        user_id: U,
        date: "2026-03-10",
        timezone: "UTC",
    }),
    health_sync_sent: (db) => {
        insert(db, "health_sync_days", {
            user_id: U,
            date: "2026-03-10",
            timezone: "UTC",
        });
        return {
            user_id: U,
            date: "2026-03-10",
            field: "energy_kcal",
            sent: 100,
        };
    },
};

type Case = [table: string, label: string, override: Row, expected: RegExp];
const cases: Case[] = [];
const add = (table: string, label: string, override: Row, expected: RegExp) =>
    cases.push([table, label, override, expected]);

// ---- columns shared by the four meal tables
const CEILING_NUTRIENTS = [
    "saturated_fat_g",
    "trans_fat_g",
    "fiber_g",
    "sugar_g",
    "added_sugar_g",
    "alcohol_g",
    "caffeine_mg",
    "sodium_mg",
];
for (const t of ["meals", "saved_meals", "meal_items", "saved_meal_items"]) {
    for (const c of CEILING_NUTRIENTS) add(t, `${c} < 0`, { [c]: -1 }, CHECK);
    for (const c of ["protein_g", "carbs_g", "fat_g"])
        add(t, `${c} is a number`, { [c]: "abc" }, TYPE);
    add(
        t,
        "nutrient_sources must be a JSON object",
        { nutrient_sources: "[]" },
        CHECK,
    );
    add(
        t,
        "nutrient_sources must be JSON",
        { nutrient_sources: "{oops" },
        /malformed JSON|CHECK constraint failed/,
    );
    add(
        t,
        "source_detail must be a JSON object",
        { source_detail: '"x"' },
        CHECK,
    );
}
for (const t of ["saved_meals", "meal_items", "saved_meal_items"]) {
    for (const c of ["protein_g", "carbs_g", "fat_g"])
        add(t, `${c} < 0`, { [c]: -1 }, CHECK);
    add(t, "calories < 0", { calories: -1 }, CHECK);
}
add("meals", "calories is integral", { calories: 1.5 }, TYPE);
add("meals", "calories is a number", { calories: "abc" }, TYPE);
add("saved_meals", "calories is integral", { calories: 1.5 }, TYPE);

add("meals", "user_id required", { user_id: null }, NOTNULL);
add("meals", "description required", { description: null }, NOTNULL);
add("meals", "meal_type enum", { meal_type: "brunch" }, CHECK);
add(
    "meals",
    "logged_at must be an ISO instant",
    { logged_at: "garbage" },
    CHECK,
);
add(
    "meals",
    "logged_at must be UTC ISO (no offset form)",
    { logged_at: "2026-03-14 10:00:00" },
    CHECK,
);
add(
    "meals",
    "saved_meal_id must exist",
    { saved_meal_id: "33333333-3333-4333-8333-333333333333" },
    FK,
);

add("saved_meals", "name required", { name: null }, NOTNULL);
add("saved_meals", "name non-empty", { name: "" }, CHECK);
add("saved_meals", "name <= 100 chars", { name: "x".repeat(101) }, CHECK);
add("saved_meals", "name_key required", { name_key: null }, NOTNULL);
add("saved_meals", "description non-empty", { description: "" }, CHECK);
add(
    "saved_meals",
    "description <= 2000 chars",
    { description: "x".repeat(2001) },
    CHECK,
);
add("saved_meals", "meal_type enum", { meal_type: "brunch" }, CHECK);

for (const t of ["meal_items", "saved_meal_items"]) {
    add(t, "position >= 1", { position: 0 }, CHECK);
    add(t, "name non-empty", { name: "" }, CHECK);
    add(t, "name <= 200 chars", { name: "x".repeat(201) }, CHECK);
    add(t, "amount > 0", { amount: 0 }, CHECK);
    add(t, "unit non-empty", { unit: "" }, CHECK);
    add(t, "unit <= 20 chars", { unit: "x".repeat(21) }, CHECK);
    add(t, "calories required", { calories: null }, NOTNULL);
    add(t, "protein_g required", { protein_g: null }, NOTNULL);
    add(t, "carbs_g required", { carbs_g: null }, NOTNULL);
    add(t, "fat_g required", { fat_g: null }, NOTNULL);
}
add(
    "meal_items",
    "meal must exist",
    { meal_id: "33333333-3333-4333-8333-333333333333" },
    FK,
);
add(
    "saved_meal_items",
    "saved meal must exist",
    { saved_meal_id: "33333333-3333-4333-8333-333333333333" },
    FK,
);

// ---- goals
for (const t of ["nutrition_goals", "nutrition_goals_history"]) {
    for (const c of [
        "daily_saturated_fat_g",
        "daily_fiber_g",
        "daily_sugar_g",
        "daily_added_sugar_g",
        "daily_alcohol_g",
        "daily_caffeine_mg",
        "daily_sodium_mg",
    ])
        add(t, `${c} < 0`, { [c]: -1 }, CHECK);
    add(t, "target_weight_g > 0", { target_weight_g: 0 }, CHECK);
    add(t, "target_weight_g is integral", { target_weight_g: 70000.5 }, TYPE);
    add(t, "daily_calories is integral", { daily_calories: 1.5 }, TYPE);
    add(t, "daily_water_ml is integral", { daily_water_ml: 1.5 }, TYPE);
    add(t, "daily_protein_g is a number", { daily_protein_g: "abc" }, TYPE);
}
add("nutrition_goals", "updated_at ISO", { updated_at: "yesterday" }, CHECK);
add(
    "nutrition_goals_history",
    "effective_at ISO",
    { effective_at: "yesterday" },
    CHECK,
);
add("nutrition_goals_history", "user_id required", { user_id: null }, NOTNULL);

// ---- logs
add("water_log", "amount_ml > 0", { amount_ml: 0 }, CHECK);
add("water_log", "amount_ml integral", { amount_ml: 12.5 }, TYPE);
add("water_log", "amount_ml required", { amount_ml: null }, NOTNULL);
add("weight_log", "weight_g > 0", { weight_g: 0 }, CHECK);
add("weight_log", "weight_g integral", { weight_g: 80000.5 }, TYPE);
for (const t of [
    "water_log",
    "weight_log",
    "body_measurement_log",
    "active_calories_log",
]) {
    add(t, "logged_at ISO", { logged_at: "garbage" }, CHECK);
    add(t, "created_at ISO", { created_at: "garbage" }, CHECK);
    add(t, "user_id required", { user_id: null }, NOTNULL);
}
add("body_measurement_log", "kind enum", { kind: "elbow" }, CHECK);
add("body_measurement_log", "kind required", { kind: null }, NOTNULL);
add("body_measurement_log", "value_mm > 0", { value_mm: 0 }, CHECK);
add("body_measurement_log", "value_mm integral", { value_mm: 1.5 }, TYPE);
add("body_measurement_log", "value_entered > 0", { value_entered: 0 }, CHECK);
add("body_measurement_log", "entered_unit enum", { entered_unit: "ft" }, CHECK);
add("active_calories_log", "kcal >= 1", { kcal: 0 }, CHECK);
add("active_calories_log", "kcal <= 10000", { kcal: 10001 }, CHECK);
add("active_calories_log", "kcal integral", { kcal: 1.5 }, TYPE);
add("active_calories_log", "credit_pct >= 0", { credit_pct: -1 }, CHECK);
add("active_calories_log", "credit_pct <= 100", { credit_pct: 101 }, CHECK);
add(
    "active_calories_log",
    "source enum",
    { source: "fitbit", source_date: "2026-03-14" },
    CHECK,
);
add(
    "active_calories_log",
    "source needs source_date",
    { source: "apple_health" },
    CHECK,
);
add(
    "active_calories_log",
    "source_date needs source",
    { source_date: "2026-03-14" },
    CHECK,
);
add(
    "active_calories_log",
    "source_date is a date",
    { source: "apple_health", source_date: "garbage" },
    CHECK,
);

// ---- profile / cache
add(
    "profiles",
    "preferred_weight_unit enum",
    { preferred_weight_unit: "stone" },
    CHECK,
);
add(
    "profiles",
    "preferred_length_unit enum",
    { preferred_length_unit: "ft" },
    CHECK,
);
add(
    "profiles",
    "preferred_drink_unit enum",
    { preferred_drink_unit: "au" },
    CHECK,
);
add("profiles", "widgets_enabled is 0/1", { widgets_enabled: 2 }, CHECK);
add(
    "profiles",
    "alcohol_tracking_enabled is 0/1",
    { alcohol_tracking_enabled: 2 },
    CHECK,
);
add(
    "profiles",
    "activity_credit_pct <= 100",
    { activity_credit_pct: 101 },
    CHECK,
);
add("profiles", "activity_credit_pct >= 0", { activity_credit_pct: -1 }, CHECK);
add(
    "profiles",
    "activity_credit_pct integral",
    { activity_credit_pct: 50.5 },
    TYPE,
);
add("food_cache", "payload is JSON", { payload: "nope" }, CHECK);
add("food_cache", "fetched_at ISO", { fetched_at: "garbage" }, CHECK);

// ---- Health

// ---- Apple Health ledger
add("health_sync_state", "lease_until ISO", { lease_until: "later" }, CHECK);
add("health_sync_state", "last_sync_at ISO", { last_sync_at: "x" }, CHECK);
add("health_sync_state", "last_ack_at ISO", { last_ack_at: "x" }, CHECK);
add(
    "health_sync_state",
    "last_activity_at ISO",
    { last_activity_at: "x" },
    CHECK,
);
add("health_sync_days", "date is a date", { date: "garbage" }, CHECK);
add("health_sync_days", "rounds >= 0", { rounds: -1 }, CHECK);
add("health_sync_days", "rounds is integral", { rounds: 1.5 }, TYPE);
add("health_sync_days", "timezone required", { timezone: null }, NOTNULL);
add("health_sync_days", "first_sent_at ISO", { first_sent_at: "x" }, CHECK);
add("health_sync_days", "last_sent_at ISO", { last_sent_at: "x" }, CHECK);
add("health_sync_sent", "field enum", { field: "alcohol_g" }, CHECK);
add("health_sync_sent", "sent >= 0", { sent: -1 }, CHECK);
add("health_sync_sent", "sent is a number", { sent: "abc" }, TYPE);
add("health_sync_sent", "needs its day row", { date: "2026-03-11" }, FK);

describe("every table accepts its valid base row (positive control)", () => {
    for (const [table, base] of Object.entries(BASES)) {
        test(table, () => {
            const db = openDb(":memory:");
            expect(() => insert(db, table, base(db))).not.toThrow();
            db.close();
        });
    }
});

describe("constraints reject exactly what the migrations rejected", () => {
    for (const [table, label, override, expected] of cases) {
        test(`${table}: ${label}`, () => {
            const db = openDb(":memory:");
            const row = { ...BASES[table]!(db), ...override };
            expect(() => insert(db, table, row)).toThrow(expected);
            db.close();
        });
    }

    test("the table-driven list covers every table", () => {
        const covered = new Set(cases.map((c) => c[0]));
        for (const table of Object.keys(BASES))
            expect(covered.has(table)).toBe(true);
    });
});

describe("rules the schema deliberately does NOT have (upstream parity)", () => {
    test("meals macros and calories carry no sign check upstream", () => {
        const db = openDb(":memory:");
        expect(() =>
            insert(db, "meals", {
                user_id: U,
                description: "d",
                protein_g: -1,
                carbs_g: -1,
                fat_g: -1,
                calories: -5,
            }),
        ).not.toThrow();
        db.close();
    });
    test("goal macros and calories carry no sign check upstream", () => {
        const db = openDb(":memory:");
        expect(() =>
            insert(db, "nutrition_goals", {
                user_id: U,
                daily_calories: -1,
                daily_protein_g: -1,
            }),
        ).not.toThrow();
        db.close();
    });
});

describe("uniqueness", () => {
    const dupe = (table: string, mutate: Row = {}, second: Row = {}) => {
        const db = openDb(":memory:");
        const base = BASES[table]!(db);
        insert(db, table, base);
        expect(() =>
            insert(db, table, { ...base, ...mutate, ...second }),
        ).toThrow(UNIQUE);
        db.close();
    };

    test("saved_meals: (user, name_key)", () =>
        dupe("saved_meals", { name: "Other" }));
    test("meal_items: (meal_id, position)", () =>
        dupe("meal_items", { name: "again" }));
    test("saved_meal_items: (saved_meal_id, position)", () =>
        dupe("saved_meal_items", { name: "again" }));
    test("nutrition_goals: one row per owner", () => dupe("nutrition_goals"));
    test("profiles: one row per owner", () => dupe("profiles"));
    test("food_cache: (source, source_id)", () =>
        dupe("food_cache", { payload: "[]" }));
    test("health_sync_state: one row per owner", () =>
        dupe("health_sync_state"));
    test("health_sync_days: (user, date)", () =>
        dupe("health_sync_days", { timezone: "X" }));
    test("health_sync_sent: (user, date, field)", () =>
        dupe("health_sync_sent", { sent: 5 }));

    for (const table of [
        "meals",
        "water_log",
        "weight_log",
        "body_measurement_log",
        "active_calories_log",
    ]) {
        test(`${table}: idempotency key is unique per owner, NULL keys never collide`, () => {
            const db = openDb(":memory:");
            const base = BASES[table]!(db);
            insert(db, table, { ...base, idempotency_key: "k" });
            expect(() =>
                insert(db, table, { ...base, idempotency_key: "k" }),
            ).toThrow(UNIQUE);
            expect(() =>
                insert(db, table, {
                    ...base,
                    user_id: "other",
                    idempotency_key: "k",
                }),
            ).not.toThrow();
            expect(() => insert(db, table, { ...base })).not.toThrow();
            expect(() => insert(db, table, { ...base })).not.toThrow();
            db.close();
        });
    }

    test("active_calories_log: one apple_health total per local date", () => {
        const db = openDb(":memory:");
        const base = {
            ...BASES.active_calories_log!(db),
            source: "apple_health",
            source_date: "2026-03-14",
        };
        insert(db, "active_calories_log", base);
        expect(() => insert(db, "active_calories_log", base)).toThrow(UNIQUE);
        expect(() =>
            insert(db, "active_calories_log", {
                ...base,
                source_date: "2026-03-15",
            }),
        ).not.toThrow();
        db.close();
    });
});

describe("STRICT tables", () => {
    test("every table is STRICT", () => {
        const db = openDb(":memory:");
        const rows = db
            .query<{ name: string; strict: number }, []>(
                "SELECT name, strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%'",
            )
            .all();
        expect(rows.length).toBe(16); // 15 data tables + dashboard_sessions
        for (const r of rows) expect([r.name, r.strict]).toEqual([r.name, 1]);
        db.close();
    });
});
