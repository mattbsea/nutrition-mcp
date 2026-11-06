import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, setDb } from "./conn.js";
import { openDb } from "./migrate.js";
import { OWNER_ID, insertWater } from "./repo.js";
import { loadKeys } from "../keys.js";

const dirs: string[] = [];
afterEach(() => {
    closeDb();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe("owner-only storage", () => {
    test("a fresh DATA_DIR is 0700 and the database, -wal and -shm are 0600, even under a lax umask", async () => {
        const old = process.umask(0o022);
        try {
            const root = mkdtempSync(join(tmpdir(), "modes-"));
            dirs.push(root);
            const data = join(root, "data");
            const path = join(data, "nutrition.db");
            setDb(openDb(path));
            await insertWater(OWNER_ID, {
                amount_ml: 100,
                logged_at: "2026-03-14T10:00:00.000Z",
            });
            expect(mode(data)).toBe(0o700);
            expect(mode(path)).toBe(0o600);
            expect(existsSync(`${path}-wal`)).toBe(true);
            expect(mode(`${path}-wal`)).toBe(0o600);
            expect(mode(`${path}-shm`)).toBe(0o600);
        } finally {
            process.umask(old);
        }
    });

    test("an existing world-readable directory and database are tightened on open", () => {
        const root = mkdtempSync(join(tmpdir(), "modes-"));
        dirs.push(root);
        const path = join(root, "nutrition.db");
        openDb(path).close();
        chmodSync(path, 0o644);
        chmodSync(root, 0o755);
        setDb(openDb(path));
        expect(mode(root)).toBe(0o700);
        expect(mode(path)).toBe(0o600);
    });

    test("keys.json is 0600 and its directory 0700", () => {
        const old = process.umask(0o022);
        try {
            const root = mkdtempSync(join(tmpdir(), "modes-"));
            dirs.push(root);
            const dir = join(root, "d");
            loadKeys(dir, {});
            expect(mode(dir)).toBe(0o700);
            expect(mode(join(dir, "keys.json"))).toBe(0o600);
        } finally {
            process.umask(old);
        }
    });
});
