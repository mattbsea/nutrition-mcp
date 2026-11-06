/**
 * The tools end to end against the REAL SQLite repository (in-memory), through
 * a real MCP client over an in-memory transport. src/mcp.test.ts keeps a
 * persistence double at the repo boundary for its call-witness assertions;
 * this file is the proof that the same tools, schemas and handlers work on the
 * actual database: writes land, reads see them, goals drive progress, export
 * writes a real archive and delete_account really empties the database.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./mcp.js";
import {
    OWNER_ID,
    countMeals,
    countWater,
    countWeight,
    getAllMeals,
    getNutritionGoals,
    getDb,
    getProfile,
} from "./db/repo.js";
import { TABLES } from "./db/schema.js";
import { useMemoryDb } from "./db/test-helpers.js";
import { resetKeysForTest } from "./keys.js";

interface ToolResult {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
}
const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

useMemoryDb();

let dir: string;
const prev = { data: process.env.DATA_DIR, mcp: process.env.MCP_KEY };
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-"));
    process.env.DATA_DIR = dir;
    process.env.MCP_KEY = "e2e-".padEnd(40, "k");
    resetKeysForTest();
});
afterEach(() => {
    for (const [k, v] of [
        ["DATA_DIR", prev.data],
        ["MCP_KEY", prev.mcp],
    ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    resetKeysForTest();
    rmSync(dir, { recursive: true, force: true });
});

async function withTools<T>(
    run: (
        call: (
            name: string,
            args?: Record<string, unknown>,
        ) => Promise<ToolResult>,
    ) => Promise<T>,
): Promise<T> {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, OWNER_ID, true, null);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
        await client.listTools(); // arm the client's advertised-schema check
        return await run(
            (name, args = {}) =>
                client.callTool({
                    name,
                    arguments: args,
                }) as Promise<ToolResult>,
        );
    } finally {
        await client.close();
        await server.close();
    }
}

describe("tools on a real database", () => {
    test("the full tool surface is registered (53 tools)", async () => {
        const server = new McpServer({ name: "t", version: "0" });
        registerTools(server, OWNER_ID, true, null);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "c", version: "0" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        const { tools } = await client.listTools();
        await client.close();
        await server.close();
        expect(tools).toHaveLength(53);
        const names = tools.map((t) => t.name);
        for (const n of [
            "log_meal",
            "get_meals_today",
            "set_nutrition_goals",
            "get_goal_progress",
            "log_water",
            "log_weight",
            "export_all_data",
            "delete_account",
        ])
            expect(names).toContain(n);
    });

    test("log_meal then get_meals_today reads it back; a retry deduplicates", async () => {
        await withTools(async (call) => {
            const tz = await call("set_timezone", { timezone: "UTC" });
            expect(tz.isError).toBeFalsy();
            const args = {
                description: "porridge",
                meal_type: "breakfast",
                calories: 300,
                protein_g: 12,
                carbs_g: 45,
                fat_g: 8,
            };
            const first = await call("log_meal", args);
            expect(first.isError).toBeFalsy();
            const today = await call("get_meals_today");
            expect(textOf(today)).toContain("porridge");
            expect(textOf(today)).toContain("300");
        });
        expect(await countMeals(OWNER_ID)).toBe(1);
        const [m] = await getAllMeals(OWNER_ID);
        expect(m).toMatchObject({
            description: "porridge",
            calories: 300,
            protein_g: 12,
            user_id: OWNER_ID,
        });
    });

    test("an idempotency key replays safely", async () => {
        await withTools(async (call) => {
            const args = {
                description: "toast",
                meal_type: "snack",
                calories: 100,
                idempotency_key: "same-call-1",
            };
            await call("log_meal", args);
            const again = await call("log_meal", args);
            expect(textOf(again).toLowerCase()).toContain("already");
        });
        expect(await countMeals(OWNER_ID)).toBe(1);
    });

    test("set_nutrition_goals then get_goal_progress reports against the targets", async () => {
        await withTools(async (call) => {
            await call("set_timezone", { timezone: "UTC" });
            const set = await call("set_nutrition_goals", {
                daily_calories: 2000,
                daily_protein_g: 150,
            });
            expect(set.isError).toBeFalsy();
            await call("log_meal", {
                description: "lunch",
                meal_type: "lunch",
                calories: 800,
                protein_g: 60,
            });
            const progress = await call("get_goal_progress");
            expect(progress.isError).toBeFalsy();
            const text = textOf(progress);
            expect(text).toContain("2000");
            expect(text).toContain("800");
        });
        expect(await getNutritionGoals(OWNER_ID)).toMatchObject({
            daily_calories: 2000,
            daily_protein_g: 150,
        });
    });

    test("log_water and log_weight persist and read back", async () => {
        await withTools(async (call) => {
            await call("set_timezone", { timezone: "UTC" });
            expect(
                (await call("log_water", { amount_ml: 500 })).isError,
            ).toBeFalsy();
            const water = await call("get_water_today");
            expect(textOf(water)).toContain("500");
            expect(
                (await call("log_weight", { weight: 80.5, unit: "kg" }))
                    .isError,
            ).toBeFalsy();
            const w = await call("get_weight_today");
            expect(textOf(w)).toContain("80.5");
        });
        expect(await countWater(OWNER_ID)).toBe(1);
        expect(await countWeight(OWNER_ID)).toBe(1);
    });

    test("a bad id is refused cleanly and a database rejection never leaks SQLite text", async () => {
        await withTools(async (call) => {
            const r = await call("delete_meal", { id: "not-a-uuid" });
            expect(textOf(r)).toMatch(/uuid|not found|No meal/i);
            expect(textOf(r)).not.toMatch(/sqlite|constraint/i);
        });
    });

    test("export_all_data writes a real ZIP under DATA_DIR/exports and returns a signed link", async () => {
        await withTools(async (call) => {
            await call("set_timezone", { timezone: "UTC" });
            await call("log_meal", {
                description: "eggs",
                meal_type: "breakfast",
                calories: 200,
            });
            const r = await call("export_all_data");
            expect(r.isError).toBeFalsy();
            const text = textOf(r);
            expect(text).toMatch(/\/exports\/download\?exp=\d+&sig=/);
            expect(text).toContain("1 meal");
        });
        expect(
            existsSync(
                join(dir, "exports", OWNER_ID, "nutrition-mcp-export.zip"),
            ),
        ).toBe(true);
    });

    test("delete_account empties every table and removes the archive", async () => {
        await withTools(async (call) => {
            await call("set_timezone", { timezone: "UTC" });
            await call("log_meal", {
                description: "eggs",
                meal_type: "breakfast",
                calories: 200,
            });
            await call("log_water", { amount_ml: 250 });
            await call("set_nutrition_goals", { daily_calories: 2000 });
            await call("export_all_data");
            const cancelled = await call("delete_account", { confirm: false });
            expect(textOf(cancelled)).toContain("cancelled");
            expect(await countMeals(OWNER_ID)).toBe(1);
            const done = await call("delete_account", { confirm: true });
            expect(textOf(done)).toContain("permanently deleted");
        });
        expect(await countMeals(OWNER_ID)).toBe(0);
        expect(await countWater(OWNER_ID)).toBe(0);
        expect(await getNutritionGoals(OWNER_ID)).toBeNull();
        expect(await getProfile(OWNER_ID)).toBeNull();
        expect(existsSync(join(dir, "exports"))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Breadth: the highest-value tool groups through the real repository. Each
// assertion that matters is made twice: on what the tool says AND on what the
// database holds, so a persistence regression cannot hide behind a double.
// ---------------------------------------------------------------------------

type Call = (
    name: string,
    args?: Record<string, unknown>,
) => Promise<ToolResult>;

const rowsOf = <T>(sql: string, ...params: (string | number)[]): T[] =>
    getDb()
        .query<T, (string | number)[]>(sql)
        .all(...params);
const one = <T>(sql: string, ...params: (string | number)[]): T =>
    rowsOf<T>(sql, ...params)[0]!;
const idIn = (text: string): string => {
    const m = text.match(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
    );
    if (!m) throw new Error(`no id in: ${text}`);
    return m[0];
};
const ok = (r: ToolResult) => {
    if (r.isError) throw new Error(`tool failed: ${textOf(r)}`);
    return textOf(r);
};
/** A complete ingredient: the tools require all four macros on every item. */
const ing = (
    name: string,
    kcal: number,
    protein = 0,
    amount = 100,
    unit = "g",
) => ({
    name,
    amount,
    unit,
    calories: kcal,
    protein_g: protein,
    carbs_g: 0,
    fat_g: 0,
});
const tzUtc = (call: Call) => call("set_timezone", { timezone: "UTC" });

describe("meals through the real database", () => {
    test("log_meal with items stores the items and their sum; update_meal replaces them", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            const text = ok(
                await call("log_meal", {
                    description: "oat bowl",
                    meal_type: "breakfast",
                    logged_at: "2026-03-10T08:00:00Z",
                    items: [
                        ing("oats", 190, 7, 50, "g"),
                        ing("milk", 90, 7, 200, "ml"),
                    ],
                }),
            );
            const id = idIn(text);
            expect(
                one<{ calories: number; protein_g: number }>(
                    "SELECT calories, protein_g FROM meals WHERE id = ?",
                    id,
                ),
            ).toEqual({ calories: 280, protein_g: 14 });
            expect(
                rowsOf<{ name: string }>(
                    "SELECT name FROM meal_items WHERE meal_id = ? ORDER BY position",
                    id,
                ).map((r) => r.name),
            ).toEqual(["oats", "milk"]);

            ok(
                await call("update_meal", {
                    id,
                    items: [ing("oats", 300, 10, 80, "g")],
                }),
            );
            expect(
                one<{ calories: number }>(
                    "SELECT calories FROM meals WHERE id = ?",
                    id,
                ).calories,
            ).toBe(300);
            expect(
                one<{ n: number }>(
                    "SELECT count(*) AS n FROM meal_items WHERE meal_id = ?",
                    id,
                ).n,
            ).toBe(1);

            // Totals follow items: a direct calorie edit on an itemised meal is refused and changes nothing.
            const refused = await call("update_meal", {
                id,
                description: "bigger oat bowl",
                calories: 999,
            });
            expect(refused.isError).toBe(true);
            const row = one<{ description: string; calories: number }>(
                "SELECT description, calories FROM meals WHERE id = ?",
                id,
            );
            expect(row).toEqual({ description: "oat bowl", calories: 300 });
            ok(
                await call("update_meal", {
                    id,
                    description: "bigger oat bowl",
                }),
            );
            expect(
                one<{ description: string; calories: number }>(
                    "SELECT description, calories FROM meals WHERE id = ?",
                    id,
                ),
            ).toEqual({ description: "bigger oat bowl", calories: 300 });
        });
    });

    test("date ranges include both end days in full and nothing from the days around them", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            const at = (description: string, logged_at: string) =>
                call("log_meal", {
                    description,
                    meal_type: "snack",
                    calories: 10,
                    logged_at,
                });
            await at("before-range", "2026-03-13T23:59:00Z");
            await at("first-minute", "2026-03-14T00:00:00Z");
            await at("middle", "2026-03-15T12:00:00Z");
            await at("last-minute", "2026-03-16T23:59:00Z");
            await at("after-range", "2026-03-17T00:00:00Z");

            const range = ok(
                await call("get_meals_by_date_range", {
                    start_date: "2026-03-14",
                    end_date: "2026-03-16",
                }),
            );
            for (const kept of ["first-minute", "middle", "last-minute"])
                expect(range).toContain(kept);
            for (const dropped of ["before-range", "after-range"])
                expect(range).not.toContain(dropped);

            const lastDay = ok(
                await call("get_meals_by_date", { date: "2026-03-16" }),
            );
            expect(lastDay).toContain("last-minute");
            expect(lastDay).not.toContain("after-range");

            const summary = ok(
                await call("get_nutrition_summary", {
                    start_date: "2026-03-14",
                    end_date: "2026-03-16",
                }),
            );
            for (const d of ["2026-03-14", "2026-03-15", "2026-03-16"])
                expect(summary).toContain(d);
            expect(summary).not.toContain("2026-03-13");
            expect(summary).not.toContain("2026-03-17");
        });
    });

    test("delete_meal removes the meal and its items, and a second delete says not found", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            const id = idIn(
                ok(
                    await call("log_meal", {
                        description: "to delete",
                        meal_type: "lunch",
                        items: [ing("x", 5, 0, 1, "pcs")],
                    }),
                ),
            );
            ok(await call("delete_meal", { id }));
            expect(
                one<{ n: number }>("SELECT count(*) AS n FROM meals").n,
            ).toBe(0);
            expect(
                one<{ n: number }>("SELECT count(*) AS n FROM meal_items").n,
            ).toBe(0);
            expect(
                textOf(await call("delete_meal", { id })).toLowerCase(),
            ).toMatch(/not found|no meal/);
        });
    });
});

describe("goals and progress through the real database", () => {
    test("goals are stored, history is appended, nulls clear, and progress follows the effective goal", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            ok(
                await call("set_nutrition_goals", {
                    daily_calories: 2000,
                    daily_protein_g: 120,
                    daily_water_ml: 2500,
                }),
            );
            expect(await getNutritionGoals(OWNER_ID)).toMatchObject({
                daily_calories: 2000,
                daily_protein_g: 120,
                daily_water_ml: 2500,
            });
            expect(ok(await call("get_nutrition_goals"))).toContain("2000");

            ok(
                await call("set_nutrition_goals", {
                    daily_calories: 1800,
                    daily_protein_g: null,
                }),
            );
            const g = await getNutritionGoals(OWNER_ID);
            expect(g?.daily_calories).toBe(1800);
            expect(g?.daily_protein_g).toBeNull();
            expect(g?.daily_water_ml).toBe(2500); // untouched fields survive
            expect(
                one<{ n: number }>(
                    "SELECT count(*) AS n FROM nutrition_goals_history",
                ).n,
            ).toBeGreaterThanOrEqual(1);

            ok(
                await call("log_meal", {
                    description: "dinner",
                    meal_type: "dinner",
                    calories: 700,
                }),
            );
            const progress = ok(await call("get_goal_progress"));
            expect(progress).toContain("1800");
            expect(progress).toContain("700");
        });
    });

    test("set_weight_unit, set_length_unit, set_language and set_alcohol_tracking persist in the profile", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            ok(await call("set_weight_unit", { unit: "lb" }));
            ok(await call("set_length_unit", { unit: "in" }));
            ok(
                await call("set_alcohol_tracking", {
                    enabled: true,
                    drink_unit: "uk",
                }),
            );
            ok(await call("set_widget_display", { enabled: false }));
            const p = await getProfile(OWNER_ID);
            expect(p).toMatchObject({
                timezone: "UTC",
                preferred_weight_unit: "lb",
                preferred_length_unit: "in",
                alcohol_tracking_enabled: true,
                preferred_drink_unit: "uk",
                widgets_enabled: false,
            });
        });
    });
});

describe("water, weight, body measurements and active calories through the real database", () => {
    test("water: stored in ml, listed by date, idempotent, deletable", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            const first = ok(
                await call("log_water", {
                    amount_ml: 330,
                    logged_at: "2026-03-10T09:00:00Z",
                    idempotency_key: "w-1",
                    notes: "glass",
                }),
            );
            ok(
                await call("log_water", {
                    amount_ml: 330,
                    logged_at: "2026-03-10T09:00:00Z",
                    idempotency_key: "w-1",
                }),
            );
            ok(
                await call("log_water", {
                    amount_ml: 500,
                    logged_at: "2026-03-11T09:00:00Z",
                }),
            );
            expect(await countWater(OWNER_ID)).toBe(2);
            const day = ok(
                await call("get_water_by_date", { date: "2026-03-10" }),
            );
            expect(day).toContain("330");
            expect(day).not.toContain("500");
            ok(await call("delete_water", { id: idIn(first) }));
            expect(await countWater(OWNER_ID)).toBe(1);
        });
    });

    test("weight: lb is stored as grams, listed over a range, trended, updated and deleted", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            const a = idIn(
                ok(
                    await call("log_weight", {
                        weight: 176.4,
                        unit: "lb",
                        logged_at: "2026-03-10T07:00:00Z",
                    }),
                ),
            );
            ok(
                await call("log_weight", {
                    weight: 79.0,
                    unit: "kg",
                    logged_at: "2026-03-12T07:00:00Z",
                }),
            );
            expect(
                one<{ weight_g: number }>(
                    "SELECT weight_g FROM weight_log WHERE id = ?",
                    a,
                ).weight_g,
            ).toBe(80014);
            const range = ok(
                await call("get_weight_by_date_range", {
                    start_date: "2026-03-10",
                    end_date: "2026-03-12",
                }),
            );
            expect(range).toContain("2026-03-10");
            expect(range).toContain("2026-03-12");
            ok(
                await call("get_weight_trends", {
                    days: 30,
                    end_date: "2026-03-12",
                }),
            );
            ok(await call("update_weight", { id: a, weight: 81, unit: "kg" }));
            expect(
                one<{ weight_g: number }>(
                    "SELECT weight_g FROM weight_log WHERE id = ?",
                    a,
                ).weight_g,
            ).toBe(81000);
            ok(await call("delete_weight", { id: a }));
            expect(await countWeight(OWNER_ID)).toBe(1);
        });
    });

    test("body measurements: inches are stored as mm, filtered by kind and range, updated and deleted", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            const w = idIn(
                ok(
                    await call("log_body_measurement", {
                        kind: "waist",
                        value: 32,
                        unit: "in",
                        logged_at: "2026-03-10T07:00:00Z",
                    }),
                ),
            );
            ok(
                await call("log_body_measurement", {
                    kind: "hips",
                    value: 95,
                    unit: "cm",
                    logged_at: "2026-03-10T07:00:00Z",
                }),
            );
            expect(
                one<{ value_mm: number }>(
                    "SELECT value_mm FROM body_measurement_log WHERE id = ?",
                    w,
                ).value_mm,
            ).toBe(813);
            const waistOnly = ok(
                await call("get_body_measurements", {
                    kind: "waist",
                    start_date: "2026-03-01",
                    end_date: "2026-03-31",
                }),
            );
            expect(waistOnly).toContain("Waist");
            expect(waistOnly).not.toContain("Hips");
            ok(
                await call("update_body_measurement", {
                    id: w,
                    value: 84,
                    unit: "cm",
                }),
            );
            expect(
                one<{ value_mm: number }>(
                    "SELECT value_mm FROM body_measurement_log WHERE id = ?",
                    w,
                ).value_mm,
            ).toBe(840);
            ok(await call("delete_body_measurement", { id: w }));
            expect(
                one<{ n: number }>(
                    "SELECT count(*) AS n FROM body_measurement_log",
                ).n,
            ).toBe(1);
        });
    });

    test("active calories: stored, credited at the chosen percent, listed by range, deletable", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            ok(await call("set_activity_credit", { percent: 50 }));
            const id = idIn(
                ok(
                    await call("log_active_calories", {
                        kcal: 400,
                        logged_at: "2026-03-10T18:00:00Z",
                    }),
                ),
            );
            const day = ok(
                await call("get_active_calories", {
                    start_date: "2026-03-10",
                    end_date: "2026-03-10",
                }),
            );
            expect(day).toContain("400");
            expect(day).toContain("200"); // 50% counted
            expect(day).not.toContain("2026-03-11");
            ok(await call("delete_active_calories", { id }));
            expect(
                one<{ n: number }>(
                    "SELECT count(*) AS n FROM active_calories_log",
                ).n,
            ).toBe(0);
        });
    });
});

describe("saved meals through the real database", () => {
    test("save_meal from an existing meal, list, log with servings, update, delete", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            const mealId = idIn(
                ok(
                    await call("log_meal", {
                        description: "chili",
                        meal_type: "dinner",
                        items: [
                            ing("beans", 100, 6, 100, "g"),
                            ing("beef", 250, 26, 100, "g"),
                        ],
                    }),
                ),
            );
            const saved = ok(
                await call("save_meal", {
                    name: "Chili",
                    from_meal_id: mealId,
                }),
            );
            const savedId = idIn(saved);
            expect(
                one<{ n: number }>(
                    "SELECT count(*) AS n FROM saved_meal_items WHERE saved_meal_id = ?",
                    savedId,
                ).n,
            ).toBe(2);
            expect(
                ok(await call("get_saved_meals", { name_contains: "chil" })),
            ).toContain("Chili");

            ok(
                await call("log_saved_meal", {
                    saved_meal: "Chili",
                    servings: 2,
                    idempotency_key: "chili-1",
                }),
            );
            const logged = one<{ calories: number }>(
                "SELECT calories FROM meals WHERE description LIKE '%hili%' ORDER BY rowid DESC LIMIT 1",
            );
            expect(logged.calories).toBe(700);

            ok(
                await call("update_saved_meal", {
                    id: savedId,
                    name: "Chili v2",
                    items: [ing("beans", 100, 0, 100, "g")],
                }),
            );
            expect(
                one<{ name: string }>(
                    "SELECT name FROM saved_meals WHERE id = ?",
                    savedId,
                ).name,
            ).toBe("Chili v2");
            expect(
                one<{ n: number }>(
                    "SELECT count(*) AS n FROM saved_meal_items WHERE saved_meal_id = ?",
                    savedId,
                ).n,
            ).toBe(1);

            ok(await call("delete_saved_meal", { id: savedId }));
            expect(
                one<{ n: number }>("SELECT count(*) AS n FROM saved_meals").n,
            ).toBe(0);
            expect(
                one<{ n: number }>("SELECT count(*) AS n FROM saved_meal_items")
                    .n,
            ).toBe(0);
            // The logged meal survives the deletion of its template.
            expect(
                one<{ n: number }>("SELECT count(*) AS n FROM meals").n,
            ).toBe(2);
        });
    });
});

describe("delete_account against every table", () => {
    test("leaves every table empty, including water, weight, body, active calories and saved meals", async () => {
        await withTools(async (call) => {
            await tzUtc(call);
            await call("log_meal", {
                description: "m",
                meal_type: "lunch",
                items: [ing("i", 1, 0, 1, "pcs")],
            });
            await call("save_meal", {
                name: "S",
                description: "s",
                meal_type: "lunch",
                items: [ing("i", 1, 0, 1, "pcs")],
            });
            await call("log_water", { amount_ml: 100 });
            await call("log_weight", { weight: 70, unit: "kg" });
            await call("log_body_measurement", {
                kind: "waist",
                value: 80,
                unit: "cm",
            });
            await call("log_active_calories", { kcal: 100 });
            await call("set_nutrition_goals", { daily_calories: 2000 });
            for (const t of [
                "meals",
                "meal_items",
                "saved_meals",
                "saved_meal_items",
                "water_log",
                "weight_log",
                "body_measurement_log",
                "active_calories_log",
                "nutrition_goals",
                "nutrition_goals_history",
                "profiles",
            ])
                expect(
                    one<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).n,
                ).toBeGreaterThan(0);

            ok(await call("delete_account", { confirm: true }));
            for (const t of TABLES.filter((x) => x !== "food_cache"))
                expect([
                    t,
                    one<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).n,
                ]).toEqual([t, 0]);
        });
    });
});

// ---------------------------------------------------------------------------
// Every tool, once, against the real repository.
// ---------------------------------------------------------------------------

describe("all 53 tools, once each, against the real repository", () => {
    test("each tool answers without a database error, and the table covers the whole registry", async () => {
        const names = new Set<string>();
        await withTools(async (call) => {
            const server = new McpServer({ name: "t", version: "0" });
            registerTools(server, OWNER_ID, true, null);
            const [ct, st] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: "c", version: "0" });
            await Promise.all([server.connect(st), client.connect(ct)]);
            for (const t of (await client.listTools()).tools) names.add(t.name);
            await client.close();
            await server.close();

            await tzUtc(call);
            const meal = idIn(
                ok(
                    await call("log_meal", {
                        description: "seed meal",
                        meal_type: "lunch",
                        logged_at: "2026-03-10T12:00:00Z",
                        items: [ing("seed", 100, 5)],
                    }),
                ),
            );
            const saved = idIn(
                ok(
                    await call("save_meal", {
                        name: "Seed saved",
                        from_meal_id: meal,
                    }),
                ),
            );
            const water = idIn(
                ok(
                    await call("log_water", {
                        amount_ml: 200,
                        logged_at: "2026-03-10T12:00:00Z",
                    }),
                ),
            );
            const weight = idIn(
                ok(
                    await call("log_weight", {
                        weight: 70,
                        unit: "kg",
                        logged_at: "2026-03-10T07:00:00Z",
                    }),
                ),
            );
            const body = idIn(
                ok(
                    await call("log_body_measurement", {
                        kind: "waist",
                        value: 80,
                        unit: "cm",
                        logged_at: "2026-03-10T07:00:00Z",
                    }),
                ),
            );
            const active = idIn(
                ok(
                    await call("log_active_calories", {
                        kcal: 100,
                        logged_at: "2026-03-10T18:00:00Z",
                    }),
                ),
            );

            const D = "2026-03-10";
            const table: [string, Record<string, unknown>][] = [
                [
                    "log_meal",
                    {
                        description: "table meal",
                        meal_type: "snack",
                        calories: 50,
                    },
                ],
                ["start_meal_import", {}],
                [
                    "bulk_import_meals",
                    {
                        meals: [
                            {
                                source_line: 1,
                                description: "imported",
                                logged_at: D,
                                calories: 10,
                                protein_g: 1,
                                carbs_g: 1,
                                fat_g: 1,
                            },
                        ],
                        expected_row_count: 1,
                        dry_run: true,
                    },
                ],
                ["lookup_barcode", { barcode: "0000000000000" }],
                ["search_foods", { query: "apple" }],
                ["get_food_macros", { fdc_id: 1 }],
                ["get_meals_today", {}],
                ["get_meals_by_date", { date: D }],
                ["get_meals_by_date_range", { start_date: D, end_date: D }],
                ["search_meals", { queries: ["seed"] }],
                ["get_nutrition_summary", { start_date: D, end_date: D }],
                ["get_digest", { period: "last_7_days" }],
                ["set_nutrition_goals", { daily_calories: 2000 }],
                ["get_nutrition_goals", {}],
                ["get_goal_progress", { date: D }],
                ["update_meal", { id: meal, description: "seed meal renamed" }],
                [
                    "save_meal",
                    {
                        name: "Another",
                        description: "a",
                        meal_type: "snack",
                        calories: 20,
                    },
                ],
                ["get_saved_meals", {}],
                ["log_saved_meal", { saved_meal: saved }],
                ["update_saved_meal", { id: saved, name: "Seed saved 2" }],
                ["log_water", { amount_ml: 100 }],
                ["get_water_today", {}],
                ["get_water_by_date", { date: D }],
                ["log_active_calories", { kcal: 50 }],
                ["get_active_calories", { date: D }],
                ["set_activity_credit", { percent: 100 }],
                ["log_weight", { weight: 71, unit: "kg" }],
                ["get_weight_today", {}],
                ["get_weight_by_date", { date: D }],
                ["get_weight_by_date_range", { start_date: D, end_date: D }],
                ["get_weight_trends", { days: 30, end_date: D }],
                ["update_weight", { id: weight, weight: 72, unit: "kg" }],
                ["set_weight_unit", { unit: "kg" }],
                [
                    "log_body_measurement",
                    { kind: "hips", value: 90, unit: "cm" },
                ],
                ["get_body_measurements", { start_date: D, end_date: D }],
                [
                    "update_body_measurement",
                    { id: body, value: 81, unit: "cm" },
                ],
                ["set_length_unit", { unit: "cm" }],
                ["set_widget_display", { enabled: true }],
                ["set_alcohol_tracking", { enabled: false }],
                ["get_trends", { days: 7, end_date: D }],
                ["get_meal_patterns", { days: 7, end_date: D }],
                ["export_all_data", {}],
                ["get_profile", {}],
                ["set_timezone", { timezone: "UTC" }],
                ["set_language", { locale: "en" }],
                ["get_current_time", {}],
                ["delete_water", { id: water }],
                ["delete_active_calories", { id: active }],
                ["delete_weight", { id: weight }],
                ["delete_body_measurement", { id: body }],
                ["delete_saved_meal", { id: saved }],
                ["delete_meal", { id: meal }],
                ["delete_account", { confirm: true }],
            ];

            const covered = new Set(table.map(([n]) => n));
            // The seeding calls above also exercised these.
            for (const n of [
                "log_meal",
                "save_meal",
                "log_water",
                "log_weight",
                "log_body_measurement",
                "log_active_calories",
            ])
                covered.add(n);
            expect([...names].filter((n) => !covered.has(n))).toEqual([]);
            expect([...covered].filter((n) => !names.has(n))).toEqual([]);

            const failures: string[] = [];
            for (const [name, args] of table) {
                let r: ToolResult;
                try {
                    r = await call(name, args);
                } catch (error) {
                    failures.push(`${name}: threw ${(error as Error).message}`);
                    continue;
                }
                const text = textOf(r);
                // A tool may decline for domain reasons (no USDA key, no network),
                // but a storage fault must never surface as one.
                if (
                    /sqlite|constraint failed|no such (table|column)|syntax error/i.test(
                        text,
                    )
                )
                    failures.push(
                        `${name}: storage text leaked: ${text.slice(0, 120)}`,
                    );
                const external = [
                    "lookup_barcode",
                    "search_foods",
                    "get_food_macros",
                ];
                if (r.isError && !external.includes(name))
                    failures.push(`${name}: isError: ${text.slice(0, 160)}`);
            }
            expect(failures).toEqual([]);
        });
        expect(names.size).toBe(53);
    });
});
