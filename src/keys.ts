/**
 * Server secrets persisted under DATA_DIR/keys.json (mode 600).
 *
 *  - mcp_key      the secret in the MCP URL path (/mcp/<key>). MCP_KEY in the
 *                 environment wins (and is then never written to disk);
 *                 otherwise 48 random bytes, base64url, generated once.
 *  - shortcut_key  the bearer key of the Apple Health shortcut API. SHORTCUT_KEY
 *                 in the environment wins; otherwise generated like mcp_key.
 *                 It must differ from the MCP key: a leaked shortcut must not
 *                 open the MCP endpoint or the other way round.
 *  - export_secret HMAC key that signs export download links.
 *
 * The file is read-modify-written so later steps can add their own keys
 * (shortcut key, dashboard session secret) without this module knowing them.
 * Nothing here ever logs a key value: callers log only WHERE to read it.
 */
import { randomBytes } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface KeyStore {
    /** The MCP path key actually in force (env override or persisted). */
    mcpKey: string;
    /** True when mcpKey came from the MCP_KEY environment variable. */
    mcpKeyFromEnv: boolean;
    /** True when this call generated and persisted a new mcp_key. */
    mcpKeyGenerated: boolean;
    /** The shortcut API's bearer key (env override or persisted). */
    shortcutKey: string;
    shortcutKeyFromEnv: boolean;
    shortcutKeyGenerated: boolean;
    exportSecret: string;
    /** Absolute path of keys.json. */
    file: string;
}

/** DATA_DIR, defaulting to ./data like the database. */
export function dataDir(): string {
    return process.env.DATA_DIR || "./data";
}

export function keysFilePath(dir: string = dataDir()): string {
    return join(dir, "keys.json");
}

const newSecret = (bytes = 48): string =>
    randomBytes(bytes).toString("base64url");

function readKeys(file: string): Record<string, unknown> {
    if (!existsSync(file)) return {};
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        // A corrupt file must not silently mint a new key set over it.
        throw new Error(
            `${file} exists but is not valid JSON; fix or remove it (a new mcp_key would invalidate the connector).`,
        );
    }
}

/** Atomic write, owner-only. */
function writeKeys(file: string, keys: Record<string, unknown>): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
}

/** Minimum length and alphabet of a configured secret. The alphabet is the
 *  URL-path-safe one (also what newSecret emits), so a key can never need
 *  encoding, smuggle a "/" or "?", or be mangled by a proxy. */
export const MIN_KEY_LENGTH = 32;
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

const isSecret = (v: unknown): v is string =>
    typeof v === "string" && v.length >= 16;

/** Throws unless a user-supplied secret is long enough and path-safe. The
 *  message never contains the value. */
function assertStrongKey(name: string, value: string): void {
    if (value.length < MIN_KEY_LENGTH) {
        throw new Error(
            `${name} must be at least ${MIN_KEY_LENGTH} characters (got ${value.length}); generate one with: openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\\n'`,
        );
    }
    if (!KEY_PATTERN.test(value)) {
        throw new Error(
            `${name} may only contain letters, digits, "-" and "_" (it is used in a URL path or header).`,
        );
    }
}

/**
 * Loads (creating on first run) the key file. `env` is injectable for tests.
 * An MCP_KEY shorter than 32 characters or outside [A-Za-z0-9_-] is refused: a weak secret in a public
 * URL path is worse than a clear startup failure.
 */
export function loadKeys(
    dir: string = dataDir(),
    env: Record<string, string | undefined> = process.env,
): KeyStore {
    const file = keysFilePath(dir);
    const keys = readKeys(file);
    let dirty = false;

    if (!isSecret(keys.export_secret)) {
        keys.export_secret = newSecret(32);
        dirty = true;
    }

    const fromEnv = env.MCP_KEY?.trim();
    if (fromEnv) assertStrongKey("MCP_KEY", fromEnv);
    let mcpKey: string;
    let generated = false;
    if (fromEnv) {
        mcpKey = fromEnv;
    } else if (isSecret(keys.mcp_key)) {
        assertStrongKey("keys.json mcp_key", keys.mcp_key);
        mcpKey = keys.mcp_key;
    } else {
        mcpKey = newSecret(48);
        keys.mcp_key = mcpKey;
        generated = true;
        dirty = true;
    }

    const shortcutEnv = env.SHORTCUT_KEY?.trim();
    if (shortcutEnv) assertStrongKey("SHORTCUT_KEY", shortcutEnv);
    let shortcutKey: string;
    let shortcutGenerated = false;
    if (shortcutEnv) {
        shortcutKey = shortcutEnv;
    } else if (isSecret(keys.shortcut_key)) {
        assertStrongKey("keys.json shortcut_key", keys.shortcut_key);
        shortcutKey = keys.shortcut_key;
    } else {
        shortcutKey = newSecret(48);
        keys.shortcut_key = shortcutKey;
        shortcutGenerated = true;
        dirty = true;
    }
    if (shortcutKey === mcpKey) {
        throw new Error(
            "SHORTCUT_KEY and the MCP key must be different secrets.",
        );
    }

    if (dirty) writeKeys(file, keys);
    return {
        mcpKey,
        mcpKeyFromEnv: Boolean(fromEnv),
        mcpKeyGenerated: generated,
        shortcutKey,
        shortcutKeyFromEnv: Boolean(shortcutEnv),
        shortcutKeyGenerated: shortcutGenerated,
        exportSecret: keys.export_secret as string,
        file,
    };
}

let cached: KeyStore | undefined;

/** The process-wide key store (loaded on first use). */
export function getKeys(): KeyStore {
    cached ??= loadKeys();
    return cached;
}

/** Test seam: drop the cache so the next getKeys() re-reads DATA_DIR. */
export function resetKeysForTest(): void {
    cached = undefined;
}
