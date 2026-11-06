import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../index.js";
import {
    OWNER_ID,
    exportArchivePath,
    insertMeal,
    insertWater,
    insertWeight,
    upsertNutritionGoals,
    upsertProfile,
} from "../db/repo.js";
import { useMemoryDb, item } from "../db/test-helpers.js";
import { signExportLink, writeExportArchive } from "../export-files.js";
import { _resetBuckets } from "../rate-limit.js";
import { seedDemoData } from "./demo-data.js";
import { LoginThrottle } from "./throttle.js";
import { todayInTz } from "../tz.js";

const PASSWORD = "correct horse battery staple";
const MCP = "m-".padEnd(48, "Q7w");
const SC = "s-".padEnd(48, "Z3x");
const SECRET = "session-secret-".padEnd(48, "S");
const EXPORT_SECRET = "export-secret-".padEnd(48, "E");
const IP = "198.51.100.20";

useMemoryDb();

let dir: string;
let app: ReturnType<typeof createApp>;
let throttle: LoginThrottle;
const trust = process.env.TRUST_PROXY;

beforeEach(() => {
    _resetBuckets();
    delete process.env.TRUST_PROXY;
    dir = mkdtempSync(join(tmpdir(), "dash-"));
    throttle = new LoginThrottle();
    app = createApp({
        mcpKey: () => MCP,
        shortcutKey: () => SC,
        exportSecret: () => EXPORT_SECRET,
        dataDir: dir,
        dashboard: {
            password: () => PASSWORD,
            sessionSecret: () => SECRET,
            throttle,
        },
    });
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (trust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trust;
});

const req = (path: string, init: RequestInit = {}) =>
    app.request(`http://x${path}`, init, { ip: IP });

async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const form = await req("/login");
    const csrf = /name="csrf" value="([^"]+)"/.exec(await form.text())![1]!;
    const loginCookie = form.headers
        .getSetCookie()
        .find((c) => c.startsWith("fm_login="))!
        .split(";")[0]!;
    const r = await req("/login", {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: loginCookie,
        },
        body: new URLSearchParams({ password: PASSWORD, csrf }).toString(),
    });
    const cookie = r.headers
        .getSetCookie()
        .find((c) => c.startsWith("fm_session="))!
        .split(";")[0]!;
    const page = await req("/", { headers: { cookie } });
    return {
        cookie,
        csrf: /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!,
    };
}

async function get(path: string): Promise<{ r: Response; body: string }> {
    const { cookie } = await signIn();
    const r = await req(path, { headers: { cookie } });
    return { r, body: norm(await r.text()) };
}

/** Collapses the whitespace the formatter put inside tags, so assertions can
 *  match markup without caring where a line broke. */
const norm = (h: string) =>
    h.replace(/\s+/g, " ").replace(/ \/>/g, "/>").replace(/ >/g, ">");

const stripTags = (h: string) =>
    h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("every page, empty database", () => {
    test.each([
        "/",
        "/trends",
        "/trends?days=7",
        "/trends?days=90",
        "/meals",
        "/apple-health",
        "/settings",
    ])("%s renders with an empty state and no error", async (path) => {
        const { r, body } = await get(path);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toContain("text/html");
        expect(body).toContain("<h1>");
        expect(body).not.toMatch(/undefined|NaN|\[object/);
        expect(body).not.toContain("Infinity");
    });

    test("the Today and Trends empty states say what to do", async () => {
        expect(stripTags((await get("/")).body)).toContain(
            "No meals logged yet",
        );
        expect(stripTags((await get("/trends")).body)).toContain(
            "No meals in this range yet",
        );
        expect(stripTags((await get("/meals")).body)).toContain(
            "No meals logged on this day",
        );
        expect(stripTags((await get("/settings")).body)).toContain(
            "No goals set",
        );
    });

    test("an unknown meal id is a 404 inside the dashboard, a malformed one too", async () => {
        const { cookie } = await signIn();
        for (const id of [
            "00000000-0000-4000-8000-000000000000",
            "nonsense",
            "%27%20OR%201%3D1",
        ]) {
            const r = await req(`/meals/${id}`, { headers: { cookie } });
            expect([id, r.status]).toEqual([id, 404]);
            expect(await r.text()).toContain("Meal not found");
        }
    });
});

describe("pages with seeded data", () => {
    beforeEach(async () => {
        await seedDemoData(45, "UTC");
    });

    test("Today: calories vs goal, macros, water, weight, active calories and meals", async () => {
        const { body } = await get("/");
        const text = stripTags(body);
        expect(text).toContain("Calories");
        expect(text).toMatch(/of 2,200 kcal/);
        for (const label of [
            "Protein",
            "Carbs",
            "Fat",
            "Water",
            "Weight",
            "Active calories",
        ])
            expect(text).toContain(label);
        expect(text).toMatch(/\/ 140 g/); // protein goal
        expect(text).toMatch(/\/ 2,500 ml/); // water goal
        expect(body).toContain('<svg viewBox="0 0 140 140" role="img"'); // the ring
        expect(body).toMatch(/href="\/meals\/[0-9a-f-]{36}"/);
        // Per-meal macros.
        expect(text).toMatch(/\d+ kcal · P \d+ g · C \d+ g · F \d+ g/);
    });

    test("Trends: every chart is present for each range and carries a data table", async () => {
        for (const days of [7, 30, 90]) {
            const { body } = await get(`/trends?days=${days}`);
            expect(body.match(/<svg class="chart"/g)?.length).toBe(5);
            expect(body.match(/Show the numbers/g)?.length).toBe(5);
            expect(body).toContain(`aria-current="true">${days} days`);
        }
        const { body } = await get("/trends?days=7");
        expect(
            body.match(/<rect class="s-cal"/g)?.length,
        ).toBeGreaterThanOrEqual(6);
        expect(body).toContain('class="goal"'); // calorie goal line
    });

    test("Trends: a junk range falls back to 30 days", async () => {
        expect((await get("/trends?days=9999")).body).toContain(
            'aria-current="true">30 days',
        );
        expect((await get("/trends?days=abc")).body).toContain(
            'aria-current="true">30 days',
        );
    });

    test("Meals: a day lists its meals with links; the search finds by description and notes", async () => {
        const today = todayInTz("UTC");
        const day = (await get(`/meals?date=${today}`)).body;
        expect(day).toMatch(/href="\/meals\/[0-9a-f-]{36}"/);
        const found = (await get("/meals?q=salmon")).body;
        expect(stripTags(found)).toMatch(/\d+ results? for “salmon”/);
        expect(found).toContain("Baked salmon with potatoes");
        expect(stripTags((await get("/meals?q=zzzznothing")).body)).toContain(
            "0 results",
        );
    });

    test("Meals: a malformed date falls back to today instead of failing", async () => {
        for (const d of [
            "garbage",
            "2026-13-45",
            "2026-02-30",
            "'; DROP TABLE meals;--",
        ]) {
            const { r } = await get(`/meals?date=${encodeURIComponent(d)}`);
            expect([d, r.status]).toEqual([d, 200]);
        }
    });

    test("Meal detail: nutrition and ingredients", async () => {
        await insertMeal(OWNER_ID, {
            description: "Test stew",
            meal_type: "dinner",
            logged_at: `${todayInTz("UTC")}T18:00:00Z`,
            items: [
                item(1, {
                    name: "carrot",
                    amount: 120,
                    unit: "g",
                    calories: 50,
                }),
                item(2, {
                    name: "lentils",
                    amount: 80,
                    unit: "g",
                    calories: 280,
                }),
            ],
            calories: 330,
            protein_g: 10,
            carbs_g: 20,
            fat_g: 4,
        });
        const found = (await get("/meals?q=stew")).body;
        const id = /href="\/meals\/([0-9a-f-]{36})"/.exec(found)![1]!;
        const { r, body } = await get(`/meals/${id}`);
        expect(r.status).toBe(200);
        const text = stripTags(body);
        expect(text).toContain("Test stew");
        expect(text).toContain("carrot");
        expect(text).toContain("lentils");
        expect(text).toContain("Ingredients");
    });

    test("Apple Health: sync clocks, the sent-vs-logged table", async () => {
        const { body } = await get("/apple-health");
        const text = stripTags(body);
        expect(text).toContain("Last sync");
        expect(text).toMatch(/just now|min ago/);
        expect(text).toContain("Last data written");
        expect(text).toContain("never");
        expect(text).toContain("Energy: logged vs sent");
        expect(text).toContain("Energy (kcal)");
    });

    test("Settings: goals, preferences, redacted connector and no key anywhere", async () => {
        const { body } = await get("/settings");
        const text = stripTags(body);
        expect(text).toContain("2,200 kcal".replace(",", ","));
        expect(text).toContain("Timezone");
        expect(text).toContain("UTC");
        expect(body).toContain("/mcp/••••••••");
        expect(body).not.toContain(MCP);
        expect(body).not.toContain(SC);
        expect(body).not.toContain(PASSWORD);
    });
});

describe("escaping", () => {
    const EVIL = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;

    test("meal names, notes, ingredients and search text reach every page as text", async () => {
        await upsertProfile(OWNER_ID, { timezone: "UTC" });
        await insertMeal(OWNER_ID, {
            description: EVIL,
            meal_type: "lunch",
            notes: `note ${EVIL}`,
            logged_at: `${todayInTz("UTC")}T10:00:00Z`,
            items: [
                item(1, { name: EVIL, amount: 1, unit: "pcs", calories: 100 }),
            ],
            calories: 100,
            protein_g: 5,
            carbs_g: 10,
            fat_g: 2,
        });
        const { cookie } = await signIn();
        const pages = [
            "/",
            "/meals",
            "/meals?q=" + encodeURIComponent("<script>"),
        ];
        const detailLink = /href="\/meals\/([0-9a-f-]{36})"/.exec(
            await (await req("/", { headers: { cookie } })).text(),
        )![1]!;
        pages.push(`/meals/${detailLink}`);
        for (const p of pages) {
            const body = await (await req(p, { headers: { cookie } })).text();
            if (body.includes("<script>alert"))
                console.log(
                    "LEAK@",
                    p,
                    body.slice(
                        body.indexOf("<script>alert") - 200,
                        body.indexOf("<script>alert") + 100,
                    ),
                );
            expect([p, body.includes("<script>alert")]).toEqual([p, false]);
            expect([p, body.includes("<img src=x")]).toEqual([p, false]);
            // Escaped text may still SAY "onerror="; what must not exist is a real tag carrying it.
            expect([p, /<[a-z][^>]*\sonerror\s*=/i.test(body)]).toEqual([
                p,
                false,
            ]);
        }
        const detail = await (
            await req(`/meals/${detailLink}`, { headers: { cookie } })
        ).text();
        expect(detail).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(detail).toContain("&quot;");
    });

    test("a search term with markup is echoed escaped in the input and the heading", async () => {
        const { body } = await get(
            "/meals?q=" + encodeURIComponent(`"><script>x</script>`),
        );
        expect(body).not.toContain("<script>x");
        expect(body).toContain("&lt;script&gt;x");
    });

    test("every page has the strict CSP and no inline script or style", async () => {
        await seedDemoData(10, "UTC");
        for (const p of [
            "/",
            "/trends",
            "/meals",
            "/apple-health",
            "/settings",
        ]) {
            const { r, body } = await get(p);
            const csp = r.headers.get("content-security-policy")!;
            expect(csp).toContain("default-src 'none'");
            expect(csp).toContain("script-src 'self'");
            expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
            expect(body).not.toMatch(/<script(?![^>]*\bsrc=)/i);
            expect(body).not.toMatch(/\sstyle="/i);
            expect(body).not.toMatch(/\son[a-z]+=/i);
            expect(body).not.toMatch(/https?:\/\/(?!x\b)/i); // no external URL at all
        }
    });
});

describe("assets", () => {
    test("css and js are served without a session, cacheable, with an ETag, and carry no secrets", async () => {
        for (const p of ["/assets/dashboard.css", "/assets/dashboard.js"]) {
            const r = await req(p);
            expect(r.status).toBe(200);
            const etag = r.headers.get("etag")!;
            expect(etag).toBeTruthy();
            expect(
                (await req(p, { headers: { "if-none-match": etag } })).status,
            ).toBe(304);
        }
        const css = await (await req("/assets/dashboard.css")).text();
        expect(css).toContain("prefers-color-scheme:dark");
        expect(css).not.toMatch(/url\(|@import|https?:/);
    });
});

describe("revealing the connector details", () => {
    test("needs the password; a wrong one shows nothing and counts against the throttle", async () => {
        const { cookie, csrf } = await signIn();
        const post = (password: string, extra: Record<string, string> = {}) =>
            req("/settings/reveal", {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    cookie,
                    ...extra,
                },
                body: new URLSearchParams({ csrf, password }).toString(),
            });
        const bad = await post("not the password");
        expect(bad.status).toBe(401);
        const badBody = await bad.text();
        expect(badBody).not.toContain(MCP);
        expect(badBody).not.toContain(SC);
        // No CSRF token: refused before the password is even looked at.
        const noCsrf = await req("/settings/reveal", {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie,
            },
            body: `password=${encodeURIComponent(PASSWORD)}`,
        });
        expect(noCsrf.status).toBe(403);
        const ok = await post(PASSWORD);
        expect(ok.status).toBe(200);
        expect(ok.headers.get("cache-control")).toBe("no-store");
        const body = await ok.text();
        expect(body).toContain(`http://x/mcp/${MCP}`);
        expect(body).toContain(SC);
        expect(body).toContain('data-copy="http://x/mcp/');
    });

    test("repeated wrong passwords lock the reveal form", async () => {
        const { cookie, csrf } = await signIn();
        let last = 0;
        for (let i = 0; i < 6; i++) {
            last = (
                await req("/settings/reveal", {
                    method: "POST",
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        cookie,
                    },
                    body: new URLSearchParams({
                        csrf,
                        password: "nope-nope-nope",
                    }).toString(),
                })
            ).status;
        }
        expect(last).toBe(429);
    });

    test("the access log never carries the revealed key", async () => {
        const lines: string[] = [];
        const orig = console.log;
        console.log = (...a: unknown[]) =>
            void lines.push(a.map(String).join(" "));
        try {
            const { cookie, csrf } = await signIn();
            await req("/settings/reveal", {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    cookie,
                },
                body: new URLSearchParams({
                    csrf,
                    password: PASSWORD,
                }).toString(),
            });
        } finally {
            console.log = orig;
        }
        const all = lines.join("\n");
        expect(all).not.toContain(MCP);
        expect(all).not.toContain(SC);
        expect(all).not.toContain(PASSWORD);
    });
});

describe("export download", () => {
    const NAME = "nutrition-mcp-export.zip";
    beforeEach(() => {
        writeExportArchive(
            exportArchivePath(OWNER_ID),
            new TextEncoder().encode("PK-fake-zip-bytes"),
            dir,
        );
    });

    test("no credentials at all: redirected to the login page (dashboard) and nothing is served", async () => {
        const r = await req(`/exports/${NAME}`);
        expect([r.status, r.headers.get("location")]).toEqual([303, "/login"]);
        expect(await r.text()).not.toContain("PK-fake");
    });

    test("the session cookie alone downloads it, as an attachment", async () => {
        const { cookie } = await signIn();
        for (const p of [`/exports/${NAME}`, "/exports/download"]) {
            const r = await req(p, { headers: { cookie } });
            expect([p, r.status]).toEqual([p, 200]);
            expect(r.headers.get("content-type")).toBe("application/zip");
            expect(r.headers.get("content-disposition")).toContain(
                "attachment",
            );
            expect(await r.text()).toContain("PK-fake-zip-bytes");
        }
    });

    test("a valid short-lived signature works without a cookie; a bad or expired one is a 404", async () => {
        const rel = exportArchivePath(OWNER_ID);
        const link = signExportLink(EXPORT_SECRET, rel).path;
        expect((await req(link)).status).toBe(200);
        expect((await req(link.replace(/sig=.{4}/, "sig=AAAA"))).status).toBe(
            404,
        );
        const expired = signExportLink(
            EXPORT_SECRET,
            rel,
            new Date(Date.now() - 2 * 3600_000),
        ).path;
        expect((await req(expired)).status).toBe(404);
        // The signature also opens the named route, for the same file only.
        const q = link.slice(link.indexOf("?"));
        expect((await req(`/exports/${NAME}${q}`)).status).toBe(200);
    });

    test("traversal attempts and any other name are the generic 404, even with a session", async () => {
        const { cookie } = await signIn();
        for (const evil of [
            "..%2Fkeys.json",
            "%2e%2e%2fkeys.json",
            "..%5Ckeys.json",
            "....//keys.json",
            "%2Fetc%2Fpasswd",
            "nutrition.db",
            "keys.json",
            `${NAME}%00.txt`,
            `${NAME}/..`,
            "local-owner%2Fnutrition-mcp-export.zip",
        ]) {
            const r = await req(`/exports/${evil}`, { headers: { cookie } });
            expect([evil, r.status]).toEqual([evil, 404]);
            expect(await r.text()).not.toMatch(
                /PK-fake|"mcp_key"|SQLite format/,
            );
        }
        const viaQuery = await req(`/exports/download?name=../keys.json`, {
            headers: { cookie },
        });
        expect(await viaQuery.text()).toContain("PK-fake"); // the query is ignored: still the one archive
    });

    test("Settings offers the download only when an archive exists", async () => {
        const { body } = await get("/settings");
        expect(body).toContain(`href="/exports/${NAME}"`);
        rmSync(join(dir, "exports"), { recursive: true, force: true });
        expect((await get("/settings")).body).not.toContain(
            `href="/exports/${NAME}"`,
        );
    });
});

describe("data correctness", () => {
    test("Today's numbers equal what was logged (net of credited active calories)", async () => {
        await upsertProfile(OWNER_ID, { timezone: "UTC" });
        await upsertNutritionGoals(OWNER_ID, {
            daily_calories: 2000,
            daily_protein_g: 100,
            daily_water_ml: 2000,
        });
        const day = todayInTz("UTC");
        await insertMeal(OWNER_ID, {
            description: "m1",
            meal_type: "breakfast",
            calories: 500,
            protein_g: 30,
            carbs_g: 50,
            fat_g: 10,
            logged_at: `${day}T00:01:00Z`,
        });
        await insertMeal(OWNER_ID, {
            description: "m2",
            meal_type: "lunch",
            calories: 700,
            protein_g: 40,
            carbs_g: 80,
            fat_g: 20,
            logged_at: `${day}T00:02:00Z`,
        });
        await insertWater(OWNER_ID, {
            amount_ml: 750,
            logged_at: `${day}T00:03:00Z`,
        });
        await insertWeight(OWNER_ID, {
            weight_g: 80_400,
            logged_at: `${day}T00:04:00Z`,
        });
        const { insertActiveCalories } = await import("../db/repo.js");
        await insertActiveCalories(OWNER_ID, {
            kcal: 300,
            credit_pct: 50,
            logged_at: `${day}T00:05:00Z`,
        });
        const text = stripTags((await get("/")).body);
        expect(text).toContain("1,200 kcal eaten");
        expect(text).toContain("− 150 kcal active (counted) = 1,050 net");
        expect(text).toContain("950 kcal left"); // 2000 - 1050
        expect(text).toContain("70 / 100 g");
        expect(text).toContain("750 / 2,000 ml");
        expect(text).toContain("80.4 kg");
        expect(text).toContain("300 kcal burned");
    });

    test("over the goal reads as over, not as a negative remainder", async () => {
        await upsertProfile(OWNER_ID, { timezone: "UTC" });
        await upsertNutritionGoals(OWNER_ID, { daily_calories: 1000 });
        await insertMeal(OWNER_ID, {
            description: "feast",
            meal_type: "dinner",
            calories: 1400,
            protein_g: 1,
            carbs_g: 1,
            fat_g: 1,
            logged_at: `${todayInTz("UTC")}T00:01:00Z`,
        });
        const text = stripTags((await get("/")).body);
        expect(text).toContain("400 kcal over");
        expect(text).not.toContain("-400");
    });
});
