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
        const env = { MCP_KEY: "from-the-environment-key-1234567" };
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
                shortcut_key: "later-step-owns-this-field-0123456789",
            }),
        );
        const b = loadKeys(dir, {});
        expect(b.mcpKey).toBe(a.mcpKey);
        // Force a rewrite (new export secret) and check the unknown field is preserved.
        writeFileSync(
            keysFilePath(dir),
            JSON.stringify({
                mcp_key: a.mcpKey,
                shortcut_key: "later-step-owns-this-field-0123456789",
            }),
        );
        loadKeys(dir, {});
        expect(read().shortcut_key).toBe(
            "later-step-owns-this-field-0123456789",
        );
        expect(read().mcp_key).toBe(a.mcpKey);
    });

    test("a too-short MCP_KEY is refused, and the message never echoes the value", () => {
        expect(() => loadKeys(dir, { MCP_KEY: "short" })).toThrow(
            /MCP_KEY must be at least 32/,
        );
        // 31 characters: one short.
        const thirtyOne = "a".repeat(31);
        expect(() => loadKeys(dir, { MCP_KEY: thirtyOne })).toThrow(
            /at least 32/,
        );
        try {
            loadKeys(dir, { MCP_KEY: thirtyOne });
        } catch (e) {
            expect((e as Error).message).not.toContain(thirtyOne);
        }
        expect(() => loadKeys(dir, { MCP_KEY: "a".repeat(32) })).not.toThrow();
    });

    test.each([
        ["a slash", "a".repeat(20) + "/" + "b".repeat(20)],
        ["a question mark", "a".repeat(20) + "?" + "b".repeat(20)],
        ["a space", "a".repeat(20) + " " + "b".repeat(20)],
        ["a dot", "a".repeat(20) + "." + "b".repeat(20)],
        ["a plus", "a".repeat(20) + "+" + "b".repeat(20)],
        ["non-ASCII", "a".repeat(20) + "é" + "b".repeat(20)],
    ])("a key containing %s is refused (MCP and shortcut)", (_n, bad) => {
        expect(() => loadKeys(dir, { MCP_KEY: bad })).toThrow(
            /MCP_KEY may only contain/,
        );
        expect(() => loadKeys(dir, { SHORTCUT_KEY: bad })).toThrow(
            /SHORTCUT_KEY may only contain/,
        );
    });

    test("a weak or unsafe key already stored in keys.json is refused, not silently replaced", () => {
        writeFileSync(
            join(dir, "keys.json"),
            JSON.stringify({ mcp_key: "x".repeat(20) }),
        );
        expect(() => loadKeys(dir, {})).toThrow(
            /keys.json mcp_key must be at least 32/,
        );
    });

    test("generated keys satisfy the rule they enforce", () => {
        const k = loadKeys(dir, {});
        expect(k.mcpKey).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        expect(k.shortcutKey).toMatch(/^[A-Za-z0-9_-]{32,}$/);
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

    test("the shortcut key is generated alongside, 48 bytes, persisted, and distinct from the MCP key", () => {
        const k = loadKeys(dir, {});
        expect(k.shortcutKeyGenerated).toBe(true);
        expect(k.shortcutKeyFromEnv).toBe(false);
        expect(k.shortcutKey).toMatch(/^[A-Za-z0-9_-]{64}$/);
        expect(k.shortcutKey).not.toBe(k.mcpKey);
        expect(read().shortcut_key).toBe(k.shortcutKey);
        const again = loadKeys(dir, {});
        expect(again.shortcutKey).toBe(k.shortcutKey);
        expect(again.shortcutKeyGenerated).toBe(false);
    });

    test("SHORTCUT_KEY wins and is never written to disk", () => {
        const env = { SHORTCUT_KEY: "shortcut-from-the-environment-12345" };
        const k = loadKeys(dir, env);
        expect(k.shortcutKey).toBe(env.SHORTCUT_KEY);
        expect(k.shortcutKeyFromEnv).toBe(true);
        expect(JSON.stringify(read())).not.toContain(env.SHORTCUT_KEY);
        expect(read().shortcut_key).toBeUndefined();
    });

    test("a too-short SHORTCUT_KEY is refused", () => {
        expect(() => loadKeys(dir, { SHORTCUT_KEY: "short" })).toThrow(
            /SHORTCUT_KEY must be at least 32/,
        );
    });

    test("the two keys must differ, from any source", () => {
        const same = "one-secret-for-both-0123456789-abcdefgh";
        expect(() =>
            loadKeys(dir, { MCP_KEY: same, SHORTCUT_KEY: same }),
        ).toThrow(/must be different secrets/);
        // also when only one is from the environment
        const k = loadKeys(dir, {});
        expect(() => loadKeys(dir, { SHORTCUT_KEY: k.mcpKey })).toThrow(
            /must be different secrets/,
        );
    });
});
