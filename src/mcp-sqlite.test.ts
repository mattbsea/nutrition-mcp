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
    getProfile,
} from "./db/repo.js";
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
