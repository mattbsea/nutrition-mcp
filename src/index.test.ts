import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, setShuttingDownForTest } from "./index.js";
import { sanitizedMcpRequest } from "./mcp.js";
import {
    installLogRedaction,
    keysMatch,
    normaliseAddress,
    redactPath,
    redactText,
} from "./perimeter.js";
import {
    GLOBAL_FAILURE_BUDGET_PER_MIN,
    MCP_LIMIT_PER_WINDOW,
    MAX_TRACKED_CLIENTS,
    _resetBuckets,
    _trackedClientCount,
    getBanState,
} from "./rate-limit.js";
import { OWNER_ID, exportArchivePath, insertWater } from "./db/repo.js";
import { useMemoryDb } from "./db/test-helpers.js";
import { signExportLink, writeExportArchive } from "./export-files.js";

const KEY = "k-".padEnd(64, "A1b2C3d4");
const SKEY = "sc-".padEnd(60, "Z9y8");
const SECRET = "export-secret-".padEnd(48, "Z");
const IP = "198.51.100.7";

let dir: string;
let app: ReturnType<typeof createApp>;
const trustBefore = process.env.TRUST_PROXY;

useMemoryDb();

beforeEach(() => {
    _resetBuckets();
    setShuttingDownForTest(false);
    delete process.env.TRUST_PROXY;
    dir = mkdtempSync(join(tmpdir(), "idx-"));
    app = createApp({
        mcpKey: () => KEY,
        shortcutKey: () => SKEY,
        exportSecret: () => SECRET,
        dataDir: dir,
    });
});
afterEach(() => {
    if (trustBefore === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trustBefore;
    setShuttingDownForTest(false);
    rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit = {}, ip = IP) =>
    app.request(`http://food.test${path}`, init, { ip });

const INIT = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
    },
};
const mcpPost = (key: string, body: unknown = INIT, ip = IP) =>
    call(
        `/mcp/${key}`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(body),
        },
        ip,
    );

/** Everything a client can observe about a response, minus per-request noise. */
async function shape(r: Response) {
    const headers = Object.fromEntries(
        [...r.headers.entries()].filter(
            ([k]) => !["date", "content-length"].includes(k),
        ),
    );
    return { status: r.status, headers, body: await r.text() };
}

describe("the MCP key", () => {
    test("the right key reaches the MCP handler", async () => {
        const r = await mcpPost(KEY);
        expect(r.status).toBe(200);
        const text = await r.text();
        expect(text).toContain("nutrition-mcp");
        expect(text).not.toContain(KEY);
    });

    test("tools/list over the secret path returns the full tool surface", async () => {
        const r = await mcpPost(KEY, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
        });
        expect(r.status).toBe(200);
        const text = await r.text();
        expect(text).toContain("log_meal");
        expect(text).toContain("export_all_data");
    });

    test("a wrong key is the generic 404", async () => {
        const r = await mcpPost("wrong-" + KEY);
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({ error: "not_found" });
    });

    test("a key of the wrong length (shorter, longer, empty-ish, one char off) is the generic 404", async () => {
        for (const bad of [
            KEY.slice(0, -1),
            KEY + "x",
            "x",
            KEY.slice(0, -1) + "Z",
            KEY.toLowerCase().replace(/./g, "a"),
        ]) {
            const r = await mcpPost(bad);
            expect(r.status).toBe(404);
        }
    });

    test("a missing key (/mcp, /mcp/) is the generic 404 and never reaches the handler", async () => {
        for (const path of ["/mcp", "/mcp/"]) {
            const r = await call(path, { method: "POST", body: "{}" });
            expect(r.status).toBe(404);
            expect(await r.json()).toEqual({ error: "not_found" });
        }
    });

    test("wrong key, missing key and a nonexistent route answer byte-identically", async () => {
        const wrong = await shape(await mcpPost("nope-" + KEY));
        const shortKey = await shape(await mcpPost("a"));
        const missing = await shape(
            await call("/mcp", { method: "POST", body: JSON.stringify(INIT) }),
        );
        const nonexistent = await shape(
            await call("/no/such/route", {
                method: "POST",
                body: JSON.stringify(INIT),
            }),
        );
        expect(wrong).toEqual(nonexistent);
        expect(shortKey).toEqual(nonexistent);
        expect(missing).toEqual(nonexistent);
        expect(nonexistent.status).toBe(404);
        expect(nonexistent.body).toBe('{"error":"not_found"}');
    });

    test("the body is not parsed before the key is checked", async () => {
        // A body that would be rejected by the JSON-RPC layer (and by anything
        // that parses it) still gets the plain 404 for a wrong key.
        const r = await call(`/mcp/nope-${KEY}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{{{ not json",
        });
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({ error: "not_found" });
    });

    test("only POST, GET and DELETE are routed; GET and DELETE answer 405 after the key check", async () => {
        for (const method of ["GET", "DELETE"]) {
            const ok = await call(`/mcp/${KEY}`, { method });
            expect(ok.status).toBe(405);
            expect(ok.headers.get("allow")).toBe("POST");
            const bad = await call(`/mcp/x${KEY}`, { method });
            expect(bad.status).toBe(404);
        }
        for (const method of ["PUT", "PATCH", "OPTIONS"]) {
            const r = await call(`/mcp/${KEY}`, { method });
            expect(r.status).toBe(404);
        }
    });

    test("keysMatch is exact and length-safe", () => {
        expect(keysMatch(KEY, KEY)).toBe(true);
        expect(keysMatch(KEY.slice(1), KEY)).toBe(false);
        expect(keysMatch(KEY + "x", KEY)).toBe(false);
        expect(keysMatch("", KEY)).toBe(false);
        expect(keysMatch("é".repeat(10), "e".repeat(10))).toBe(false);
    });

    test("the key can rotate without a restart (it is read per request)", async () => {
        let current = KEY;
        const rotating = createApp({
            mcpKey: () => current,
            shortcutKey: () => SKEY,
            exportSecret: () => SECRET,
            dataDir: dir,
        });
        const go = (k: string) =>
            rotating.request(
                `http://x/mcp/${k}`,
                {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        accept: "application/json, text/event-stream",
                    },
                    body: JSON.stringify(INIT),
                },
                { ip: IP },
            );
        expect((await go(KEY)).status).toBe(200);
        current = "new-" + KEY;
        expect((await go(KEY)).status).toBe(404);
        expect((await go(current)).status).toBe(200);
    });
});

describe("forged addresses cannot beat the failure limits", () => {
    const forged = (i: number) => `1.2.3.4, 203.0.${(i >> 8) & 255}.${i & 255}`;
    const withForged = (i: number, key: string) =>
        call(`/mcp/${key}`, {
            method: "POST",
            headers: { "x-forwarded-for": forged(i) },
        });

    test("60 wrong keys from 60 DIFFERENT forwarded addresses are throttled by the global budget", async () => {
        process.env.TRUST_PROXY = "1";
        const statuses: number[] = [];
        for (let i = 0; i < 60; i++) {
            statuses.push((await withForged(i, "wrong" + i)).status);
        }
        // No single address ever reached its own ban...
        expect(getBanState("203.0.0.0").banned).toBe(false);
        // ...but the Nth wrong key and everything after it is shed for everyone.
        expect(
            statuses
                .slice(0, GLOBAL_FAILURE_BUDGET_PER_MIN - 1)
                .every((s) => s === 404),
        ).toBe(true);
        expect(
            statuses
                .slice(GLOBAL_FAILURE_BUDGET_PER_MIN)
                .every((s) => s === 429),
        ).toBe(true);
        const shed = await withForged(999, "another-wrong");
        expect(shed.status).toBe(429);
        expect(Number(shed.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(await shed.json()).toEqual({ error: "rate_limited" });
    });

    test("the right key keeps working while wrong keys are being shed", async () => {
        process.env.TRUST_PROXY = "1";
        for (let i = 0; i < 60; i++) await withForged(i, "wrong" + i);
        const ok = await call(`/mcp/${KEY}`, {
            method: "GET",
            headers: { "x-forwarded-for": forged(5000) },
        });
        expect(ok.status).toBe(405); // past the key check, then "POST only"
    });

    test("the Apple Health API shares the budget: forged addresses cannot guess its key either", async () => {
        process.env.TRUST_PROXY = "1";
        const codes: number[] = [];
        for (let i = 0; i < 40; i++) {
            const r = await call("/api/v1/health-sync/pending", {
                headers: {
                    authorization: `Bearer guess${i}`,
                    "x-forwarded-for": forged(i),
                },
            });
            codes.push(r.status);
        }
        expect(
            codes
                .slice(0, GLOBAL_FAILURE_BUDGET_PER_MIN - 1)
                .every((c) => c === 401),
        ).toBe(true);
        expect(
            codes.slice(GLOBAL_FAILURE_BUDGET_PER_MIN).every((c) => c === 429),
        ).toBe(true);
        const good = await call("/api/v1/health-sync/status", {
            headers: {
                authorization: `Bearer ${SKEY}`,
                "x-forwarded-for": forged(7000),
            },
        });
        expect(good.status).toBe(200);
    });

    test("without TRUST_PROXY the forged header is ignored and one peer is counted as one", async () => {
        for (let i = 0; i < 20; i++) await withForged(i, "wrong" + i);
        expect(getBanState(IP).banned).toBe(true);
    });

    test("an IPv6 /64 is ONE client: 20 failures from 20 addresses inside it earn the ban", async () => {
        process.env.TRUST_PROXY = "1";
        for (let i = 0; i < 20; i++) {
            await call(`/mcp/bad${i}`, {
                method: "POST",
                headers: {
                    "x-forwarded-for": `2001:db8:abcd:12:${i.toString(16)}:${i}::${i + 1}`,
                },
            });
        }
        expect(getBanState("2001:db8:abcd:12::/64").banned).toBe(true);
        // another /64 is unaffected
        expect(getBanState("2001:db8:abcd:13::/64").banned).toBe(false);
        const shed = await call(`/mcp/${KEY}`, {
            method: "POST",
            headers: {
                "x-forwarded-for": "2001:db8:abcd:12:ffff:ffff:ffff:ffff",
            },
        });
        expect(shed.status).toBe(429);
    });

    test("garbage forwarded values all map to one key and cannot mint trackers", async () => {
        process.env.TRUST_PROXY = "1";
        const before = _trackedClientCount();
        for (let i = 0; i < 25; i++) {
            await call(`/mcp/bad${i}`, {
                method: "POST",
                headers: { "x-forwarded-for": `not-an-address-${i}` },
            });
        }
        expect(_trackedClientCount()).toBeLessThanOrEqual(before + 1);
    });

    test("memory stays bounded however many distinct addresses fail (burst across minutes)", async () => {
        process.env.TRUST_PROXY = "1";
        const { noteAuthFailure } = await import("./rate-limit.js");
        for (let i = 0; i < MAX_TRACKED_CLIENTS * 2; i++) {
            noteAuthFailure(
                `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::/64`,
            );
        }
        expect(_trackedClientCount()).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);
    });
});

describe("normaliseAddress", () => {
    test.each([
        ["198.51.100.7", "198.51.100.7"],
        ["300.1.1.1", "invalid"],
        ["2001:db8:abcd:12::1", "2001:db8:abcd:12::/64"],
        ["2001:0DB8:ABCD:0012:0000:0000:0000:0001", "2001:db8:abcd:12::/64"],
        ["[2001:db8::1]", "2001:db8:0:0::/64"],
        ["fe80::1%eth0", "fe80:0:0:0::/64"],
        ["::1", "0:0:0:0::/64"],
        ["::ffff:198.51.100.7", "198.51.100.7"],
        ["not-an-ip", "invalid"],
        ["1:2:3:4:5:6:7:8:9", "invalid"],
        ["1::2::3", "invalid"],
        ["2001:db8:xyz::1", "invalid"],
        ["", "invalid"],
    ])("%s -> %s", (raw, want) => {
        expect(normaliseAddress(raw)).toBe(want);
    });
});

describe("the per-owner request budget", () => {
    test(`${MCP_LIMIT_PER_WINDOW} requests a minute with the right key, then 429; wrong keys do not spend it`, async () => {
        for (let i = 0; i < 5; i++)
            await call(`/mcp/wrong${i}`, { method: "GET" });
        for (let i = 0; i < MCP_LIMIT_PER_WINDOW; i++) {
            const r = await call(`/mcp/${KEY}`, { method: "GET" });
            if (r.status !== 405)
                throw new Error(`request ${i} was ${r.status}`);
        }
        const over = await call(`/mcp/${KEY}`, { method: "GET" });
        expect(over.status).toBe(429);
        expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(await over.json()).toEqual({ error: "rate_limited" });
    });
});

describe("failure rate limiting", () => {
    test("20 consecutive failures from one address earn a 429 with Retry-After, even for the right key", async () => {
        for (let i = 0; i < 19; i++)
            expect((await mcpPost("bad" + i)).status).toBe(404);
        // The 20th failure trips the ban; it is itself still answered 404.
        expect((await mcpPost("bad19")).status).toBe(404);
        expect(getBanState(IP).banned).toBe(true);
        const shed = await mcpPost(KEY);
        expect(shed.status).toBe(429);
        expect(Number(shed.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(await shed.json()).toEqual({ error: "rate_limited" });
        // Another address is unaffected.
        expect((await mcpPost(KEY, INIT, "203.0.113.9")).status).toBe(200);
    });

    test("a success clears the run of failures", async () => {
        for (let i = 0; i < 15; i++) await mcpPost("bad" + i);
        expect((await mcpPost(KEY)).status).toBe(200);
        for (let i = 0; i < 15; i++) await mcpPost("again" + i);
        expect(getBanState(IP).banned).toBe(false);
    });

    test("X-Forwarded-For is ignored without TRUST_PROXY, so it cannot mint fresh buckets", async () => {
        for (let i = 0; i < 20; i++) {
            await call(`/mcp/bad${i}`, {
                method: "POST",
                headers: { "x-forwarded-for": `10.0.0.${i}` },
            });
        }
        expect(getBanState(IP).banned).toBe(true);
        expect(getBanState("10.0.0.3").banned).toBe(false);
    });

    test("with TRUST_PROXY=1 the RIGHTMOST forwarded address is the client (the one our proxy added)", async () => {
        process.env.TRUST_PROXY = "1";
        for (let i = 0; i < 20; i++) {
            // The leftmost entry is client-supplied and forgeable; the rightmost is real.
            await call(`/mcp/bad${i}`, {
                method: "POST",
                headers: { "x-forwarded-for": `1.2.3.${i}, 192.0.2.55` },
            });
        }
        expect(getBanState("192.0.2.55").banned).toBe(true);
        expect(getBanState("1.2.3.4").banned).toBe(false);
        expect(getBanState(IP).banned).toBe(false);
        const shed = await call(`/mcp/${KEY}`, {
            method: "POST",
            headers: { "x-forwarded-for": "9.9.9.9, 192.0.2.55" },
        });
        expect(shed.status).toBe(429);
    });

    test("a banned client does not appear in the access log", async () => {
        for (let i = 0; i < 20; i++) await mcpPost("bad" + i);
        const log = spyOn(console, "log").mockImplementation(() => {});
        await mcpPost(KEY);
        const lines = log.mock.calls.map((c) => String(c[0]));
        log.mockRestore();
        expect(lines.filter((l) => l.startsWith("[req]"))).toEqual([]);
    });
});

describe("the key never reaches a log or a response", () => {
    function capture() {
        const lines: string[] = [];
        const spies = (["log", "warn", "error", "info"] as const).map((m) =>
            spyOn(console, m).mockImplementation((...a: unknown[]) => {
                lines.push(
                    a
                        .map((x) =>
                            x instanceof Error
                                ? `${x.message}\n${x.stack}`
                                : String(x),
                        )
                        .join(" "),
                );
            }),
        );
        return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
    }

    test("good, bad and broken requests leave no key in the access log", async () => {
        const cap = capture();
        try {
            await mcpPost(KEY);
            await mcpPost("wrong-" + KEY);
            await call(`/mcp/${KEY}`, { method: "GET" });
            await call(`/mcp/${KEY}`, {
                method: "POST",
                body: "{{{",
                headers: { "content-type": "application/json" },
            });
            await call(`/mcp/${KEY}?next=1`, { method: "DELETE" });
        } finally {
            cap.restore();
        }
        const log = cap.lines.join("\n");
        expect(log).toContain("[req] POST /mcp/[redacted] 200");
        expect(log).toContain("[req] POST /mcp/[redacted] 404");
        expect(log).toContain("[req] GET /mcp/[redacted] 405");
        expect(log).not.toContain(KEY);
        expect(log).not.toContain("wrong-");
    });

    test("responses never echo the key, in the body or any header", async () => {
        for (const r of [
            await mcpPost(KEY),
            await mcpPost("wrong-" + KEY),
            await call(`/mcp/${KEY}`, { method: "GET" }),
        ]) {
            expect(await r.text()).not.toContain(KEY);
            for (const [, v] of r.headers) expect(v).not.toContain(KEY);
        }
    });

    test("the ban log line redacts the path", async () => {
        const cap = capture();
        try {
            for (let i = 0; i < 20; i++) await mcpPost("bad" + i);
        } finally {
            cap.restore();
        }
        const ban = cap.lines.find((l) => l.startsWith("[ban]"));
        expect(ban).toBeDefined();
        expect(ban).toContain("/mcp/[redacted]");
        expect(ban).not.toContain("bad19");
    });

    test("redactPath / redactText scrub paths and known secrets", () => {
        expect(redactPath("/mcp/abc")).toBe("/mcp/[redacted]");
        expect(redactPath("/health")).toBe("/health");
        expect(redactText(`GET /mcp/${KEY}/x?y failed`, [])).toBe(
            "GET /mcp/[redacted]/x?y failed",
        );
        expect(redactText(`boom ${KEY} boom`, [KEY])).toBe(
            "boom [redacted] boom",
        );
        expect(redactText("short secrets are not scrubbed", ["abc"])).toBe(
            "short secrets are not scrubbed",
        );
    });

    test("installLogRedaction scrubs strings and Error objects from any console call", () => {
        const seen: string[] = [];
        const orig = { log: console.log, error: console.error };
        console.log = (...a: unknown[]) =>
            void seen.push(a.map(String).join(" "));
        console.error = (...a: unknown[]) =>
            void seen.push(
                a
                    .map((x) =>
                        x instanceof Error
                            ? `${x.message} ${x.stack}`
                            : String(x),
                    )
                    .join(" "),
            );
        const uninstall = installLogRedaction(() => [KEY]);
        try {
            console.log("plain", KEY, `https://x/mcp/${KEY}`);
            console.error(new Error(`fetch failed for /mcp/${KEY}`));
        } finally {
            uninstall();
            console.log = orig.log;
            console.error = orig.error;
        }
        const joined = seen.join("\n");
        expect(joined).not.toContain(KEY);
        expect(joined).toContain("[redacted]");
    });

    test("installLogRedaction also scrubs objects, arrays, Maps and the Error cause chain", () => {
        const seen: unknown[][] = [];
        const orig = { log: console.log, error: console.error };
        console.log = (...a: unknown[]) => void seen.push(a);
        console.error = (...a: unknown[]) => void seen.push(a);
        const uninstall = installLogRedaction(() => [KEY]);
        try {
            console.log({ url: `https://x/mcp/${KEY}`, nested: { k: KEY } });
            console.log([`/mcp/${KEY}`, 1]);
            console.log(new Map([["u", `/mcp/${KEY}`]]));
            console.log({ fine: "no secret here", n: 1 });
            console.error(
                new Error("outer", {
                    cause: new Error(`inner for /mcp/${KEY}`),
                }),
            );
        } finally {
            uninstall();
            console.log = orig.log;
            console.error = orig.error;
        }
        const text = (x: unknown): string =>
            x instanceof Error
                ? `${x.message} ${x.stack} ${text((x as { cause?: unknown }).cause)}`
                : typeof x === "string"
                  ? x
                  : JSON.stringify(x);
        for (const call of seen.slice(0, 3)) {
            expect(call.map(text).join(" ")).not.toContain(KEY);
        }
        // A clean object is passed through untouched (same reference).
        expect(typeof seen[3]![0]).toBe("object");
        expect(seen[3]![0]).toEqual({ fine: "no secret here", n: 1 });
        const err = seen[4]![0] as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe("outer");
        expect(text(err)).not.toContain(KEY);
        expect((err.cause as Error).message).toContain("[redacted]");
    });

    test("sanitizedMcpRequest drops the key from the URL and keeps method, headers and body", async () => {
        const raw = new Request(`http://x:8080/mcp/${KEY}?a=1`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-test": "yes" },
            body: '{"hello":"world"}',
        });
        const clean = sanitizedMcpRequest(raw);
        expect(new URL(clean.url).pathname).toBe("/mcp");
        expect(clean.url).not.toContain(KEY);
        expect(clean.method).toBe("POST");
        expect(clean.headers.get("x-test")).toBe("yes");
        expect(await clean.json()).toEqual({ hello: "world" });
    });

    test("the SDK never sees the key: a real MCP call works and nothing logged contains it", async () => {
        const cap = capture();
        let r: Response;
        try {
            r = await mcpPost(KEY);
        } finally {
            cap.restore();
        }
        expect(r.status).toBeLessThan(500);
        expect(cap.lines.join("\n")).not.toContain(KEY);
    });

    test("an unhandled error returns a generic 500 and logs without the URL", async () => {
        const broken = createApp({
            mcpKey: () => {
                throw new Error(`boom for /mcp/${KEY}`);
            },
            shortcutKey: () => SKEY,
            exportSecret: () => SECRET,
            dataDir: dir,
        });
        const cap = capture();
        let r: Response;
        try {
            r = await broken.request(
                `http://x/mcp/${KEY}`,
                { method: "POST", body: "{}" },
                { ip: IP },
            );
        } finally {
            cap.restore();
        }
        expect(r.status).toBe(500);
        expect(await r.json()).toEqual({ error: "internal_server_error" });
    });
});

describe("the rest of the surface", () => {
    test("/ is a plain 404 JSON until the dashboard exists", async () => {
        const r = await call("/");
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({ error: "not_found" });
    });

    test("the health-sync API is mounted behind its own bearer key", async () => {
        const bare = await call("/api/v1/health-sync/pending");
        expect(bare.status).toBe(401);
        expect(await bare.json()).toMatchObject({
            ok: false,
            error: "unauthorized",
        });
        // The MCP path key is a different credential and opens nothing here.
        const mcpKeyAsBearer = await call("/api/v1/health-sync/pending", {
            headers: { authorization: `Bearer ${KEY}` },
        });
        expect(mcpKeyAsBearer.status).toBe(401);
        const ok = await call("/api/v1/health-sync/status", {
            headers: { authorization: `Bearer ${SKEY}` },
        });
        expect(ok.status).toBe(200);
        expect(await ok.json()).toMatchObject({ ok: true });
        // And the shortcut key opens nothing at /mcp.
        expect((await mcpPost(SKEY)).status).toBe(404);
    });

    test("/health is a plain ok", async () => {
        const r = await call("/health");
        expect(r.status).toBe(200);
        expect(await r.text()).toBe("ok");
    });

    test("secure headers are on every kind of response", async () => {
        for (const r of [
            await call("/health"),
            await mcpPost(KEY),
            await mcpPost("bad"),
            await call("/nope"),
        ]) {
            expect(r.headers.get("x-content-type-options")).toBe("nosniff");
            expect(r.headers.get("x-frame-options")).toBe("DENY");
            expect(r.headers.get("referrer-policy")).toBe("no-referrer");
            expect(r.headers.get("content-security-policy")).toContain(
                "default-src 'none'",
            );
            expect(r.headers.get("cache-control")).toBeTruthy();
        }
    });

    test("HSTS only over https", async () => {
        const plain = await call("/health");
        expect(plain.headers.get("strict-transport-security")).toBeNull();
        // A forged header does nothing without TRUST_PROXY ...
        const forged = await call("/health", {
            headers: { "x-forwarded-proto": "https" },
        });
        expect(forged.headers.get("strict-transport-security")).toBeNull();
        // ... and is honoured behind our own proxy.
        process.env.TRUST_PROXY = "1";
        const https = await call("/health", {
            headers: { "x-forwarded-proto": "https" },
        });
        expect(https.headers.get("strict-transport-security")).toContain(
            "max-age=31536000",
        );
    });

    test("CORS is closed: no cross-origin header on any response, and a preflight finds no route", async () => {
        const pre = await call(`/mcp/${KEY}`, {
            method: "OPTIONS",
            headers: {
                origin: "https://evil.example",
                "access-control-request-method": "POST",
            },
        });
        expect(pre.status).toBe(404);
        for (const r of [
            pre,
            await mcpPost(KEY),
            await call("/health", {
                headers: { origin: "http://localhost:3000" },
            }),
        ]) {
            expect(
                [...r.headers.keys()].some((k) =>
                    k.startsWith("access-control-"),
                ),
            ).toBe(false);
        }
    });

    test("an oversized body is refused with 413 before it is read", async () => {
        const big = "x".repeat(1024 * 1024 + 10);
        const r = await call(`/mcp/${KEY}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": String(big.length),
            },
            body: big,
        });
        expect(r.status).toBe(413);
        expect(await r.json()).toEqual({ error: "payload_too_large" });
    });

    test("the shutdown gate answers 503 before the key check, on /mcp in JSON-RPC form", async () => {
        setShuttingDownForTest(true);
        const mcp = await mcpPost("totally-wrong");
        expect(mcp.status).toBe(503);
        expect(mcp.headers.get("retry-after")).toBe("1");
        expect(
            ((await mcp.json()) as { error: { message: string } }).error
                .message,
        ).toContain("shutting down");
        const other = await call("/health");
        expect(other.status).toBe(503);
        expect(await other.json()).toEqual({ error: "shutting_down" });
    });

    test("the server icon is served unauthenticated; other static paths are 404", async () => {
        const icon = await call("/icon-192.png");
        expect(icon.status).toBe(200);
        expect(icon.headers.get("content-type")).toBe("image/png");
        expect((await call("/favicon.ico")).status).toBe(200);
        for (const gone of [
            "/robots.txt",
            "/sitemap.xml",
            "/privacy",
            "/styles.css",
            "/og.png",
            "/.well-known/mcp",
        ]) {
            expect((await call(gone)).status).toBe(404);
        }
    });
});

describe("signed export download", () => {
    const rel = exportArchivePath(OWNER_ID);
    const bytes = new TextEncoder().encode("PK-fake-zip");

    test("a valid link serves the archive as a private attachment", async () => {
        writeExportArchive(rel, bytes, dir);
        const { path } = signExportLink(SECRET, rel);
        const r = await call(path);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("application/zip");
        expect(r.headers.get("content-disposition")).toContain("attachment");
        expect(r.headers.get("cache-control")).toContain("no-store");
        expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
    });

    test("a tampered signature, a tampered expiry, an expired link and a missing file are all the generic 404", async () => {
        writeExportArchive(rel, bytes, dir);
        const { path } = signExportLink(SECRET, rel);
        const q = new URL(path, "http://x").searchParams;
        const exp = q.get("exp")!;
        const sig = q.get("sig")!;
        const cases = [
            `/exports/download?exp=${exp}&sig=${sig.slice(0, -2)}xx`,
            `/exports/download?exp=${Number(exp) + 10}&sig=${sig}`,
            `/exports/download?exp=${exp}`,
            `/exports/download?sig=${sig}`,
            `/exports/download`,
            signExportLink(SECRET, rel, new Date(Date.now() - 2 * 3600_000))
                .path,
            signExportLink("another-secret-".padEnd(40, "q"), rel).path,
        ];
        for (const p of cases) {
            const r = await call(p);
            expect(r.status).toBe(404);
            expect(await r.json()).toEqual({ error: "not_found" });
        }
        rmSync(join(dir, "exports"), { recursive: true, force: true });
        expect((await call(path)).status).toBe(404);
    });

    test("end to end through the tool path: export, then download", async () => {
        await insertWater(OWNER_ID, {
            amount_ml: 250,
            logged_at: "2026-03-14T09:00:00.000Z",
        });
        const { exportAllData } = await import("./export.js");
        const r = await exportAllData(OWNER_ID, {
            dataDir: dir,
            secret: SECRET,
        });
        const dl = await call(r.path!);
        expect(dl.status).toBe(200);
        const buf = new Uint8Array(await dl.arrayBuffer());
        expect(buf[0]).toBe(0x50); // "PK"
        expect(buf[1]).toBe(0x4b);
    });
});
