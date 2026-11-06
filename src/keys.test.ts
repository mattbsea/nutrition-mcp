import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keysFilePath, loadKeys } from "./keys.js";

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keys-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () =>
    JSON.parse(readFileSync(keysFilePath(dir), "utf8")) as Record<
        string,
        string
    >;

describe("loadKeys", () => {
    test("first run generates a 48-byte base64url mcp_key and an export secret, mode 600", () => {
        const k = loadKeys(dir, {});
        expect(k.mcpKeyGenerated).toBe(true);
        expect(k.mcpKeyFromEnv).toBe(false);
        // 48 bytes -> 64 base64url characters, no padding.
        expect(k.mcpKey).toMatch(/^[A-Za-z0-9_-]{64}$/);
        expect(k.exportSecret.length).toBeGreaterThanOrEqual(32);
        expect(k.mcpKey).not.toBe(k.exportSecret);
        expect(statSync(keysFilePath(dir)).mode & 0o777).toBe(0o600);
        expect(read()).toMatchObject({
            mcp_key: k.mcpKey,
            export_secret: k.exportSecret,
        });
    });

    test("later runs reuse the persisted keys", () => {
        const a = loadKeys(dir, {});
        const b = loadKeys(dir, {});
        expect(b.mcpKey).toBe(a.mcpKey);
        expect(b.exportSecret).toBe(a.exportSecret);
        expect(b.mcpKeyGenerated).toBe(false);
    });

    test("two fresh installs never share a key", () => {
        const other = mkdtempSync(join(tmpdir(), "keys-"));
        try {
            expect(loadKeys(other, {}).mcpKey).not.toBe(
                loadKeys(dir, {}).mcpKey,
            );
        } finally {
            rmSync(other, { recursive: true, force: true });
        }
    });

    test("MCP_KEY wins and is never written to disk", () => {
        const env = { MCP_KEY: "from-the-environment-key-123456" };
        const k = loadKeys(dir, env);
        expect(k.mcpKey).toBe(env.MCP_KEY);
        expect(k.mcpKeyFromEnv).toBe(true);
        expect(k.mcpKeyGenerated).toBe(false);
        expect(JSON.stringify(read())).not.toContain(env.MCP_KEY);
        expect(read().mcp_key).toBeUndefined();
    });

    test("a persisted key is kept when MCP_KEY is later unset, and unknown fields survive", () => {
        const a = loadKeys(dir, {});
        const file = read();
        writeFileSync(
            keysFilePath(dir),
            JSON.stringify({
                ...file,
                shortcut_key: "later-step-owns-this-field",
            }),
        );
        const b = loadKeys(dir, {});
        expect(b.mcpKey).toBe(a.mcpKey);
        // Force a rewrite (new export secret) and check the unknown field is preserved.
        writeFileSync(
            keysFilePath(dir),
            JSON.stringify({
                mcp_key: a.mcpKey,
                shortcut_key: "later-step-owns-this-field",
            }),
        );
        loadKeys(dir, {});
        expect(read().shortcut_key).toBe("later-step-owns-this-field");
        expect(read().mcp_key).toBe(a.mcpKey);
    });

    test("a too-short MCP_KEY is refused", () => {
        expect(() => loadKeys(dir, { MCP_KEY: "short" })).toThrow(
            /at least 16/,
        );
    });

    test("a corrupt keys.json is an error, never a silent new key", () => {
        writeFileSync(keysFilePath(dir), "{not json");
        expect(() => loadKeys(dir, {})).toThrow(/not valid JSON/);
        expect(readFileSync(keysFilePath(dir), "utf8")).toBe("{not json");
    });

    test("a weak persisted key (too short) is replaced rather than trusted", () => {
        writeFileSync(keysFilePath(dir), JSON.stringify({ mcp_key: "abc" }));
        const k = loadKeys(dir, {});
        expect(k.mcpKey.length).toBe(64);
        expect(k.mcpKeyGenerated).toBe(true);
    });
});
