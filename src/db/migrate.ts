import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from "./schema";
import { OWNER_ID } from "./owner";

/** DATA_DIR/nutrition.db. DATA_DIR defaults to ./data (the add-on sets /data). */
export function defaultDbPath(): string {
    return join(process.env.DATA_DIR || "./data", "nutrition.db");
}

function userVersion(db: Database): number {
    const row = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get();
    return Number(row?.user_version ?? 0);
}

/**
 * Applies every migration newer than PRAGMA user_version, each in its own
 * IMMEDIATE transaction (DDL is transactional in SQLite), then returns the
 * resulting version. Re-running is a no-op. A database from a NEWER build
 * (user_version above what this code knows) is refused rather than guessed at.
 */
export function runMigrations(db: Database): number {
    const current = userVersion(db);
    if (current > SCHEMA_VERSION) {
        throw new Error(
            `Database schema version ${current} is newer than this build supports (${SCHEMA_VERSION}); refusing to open it.`,
        );
    }
    for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        db.exec("BEGIN IMMEDIATE");
        try {
            db.exec(m.sql);
            // PRAGMA does not take bound parameters; version is a code constant.
            db.exec(`PRAGMA user_version = ${Number(m.version)}`);
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }
    return userVersion(db);
}

/**
 * Case-folding the way Postgres ILIKE/lower() did: SQLite's built-in lower()
 * and LIKE only fold ASCII, so "Борщ" would not match "борщ". The function is
 * registered per connection and only ever used in queries, never in an index,
 * so the file stays readable by the stock sqlite3 CLI.
 */
function registerFunctions(db: Database): void {
    db.function(
        "ulower",
        { deterministic: true },
        (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v) as string,
    );
}

/**
 * Opens (creating if needed) the database and brings it to the current schema.
 * `path` may be ":memory:" for tests. foreign_keys is a per-connection pragma
 * and must be set on every open.
 */
export function openDb(path: string = defaultDbPath()): Database {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true, strict: true });
    try {
        db.exec("PRAGMA foreign_keys = ON");
        db.exec("PRAGMA busy_timeout = 5000");
        if (path !== ":memory:") {
            db.exec("PRAGMA journal_mode = WAL");
            db.exec("PRAGMA synchronous = NORMAL");
        }
        registerFunctions(db);
        runMigrations(db);
        assertSingleOwner(db);
    } catch (error) {
        db.close();
        throw error;
    }
    return db;
}

/** Tables carrying a user_id owner column. */
const OWNED_TABLES = TABLES.filter((t) => t !== "food_cache");

/**
 * Startup audit: no row may belong to anyone but OWNER_ID. There is no RLS
 * here, so a stray owner id (a bug, or a hand-edited file) must fail loudly
 * instead of being silently invisible. Table names come from the TABLES
 * constant, never from input.
 */
export function assertSingleOwner(db: Database): void {
    for (const table of OWNED_TABLES) {
        const row = db
            .query<{ n: number }, [string]>(
                `SELECT count(*) AS n FROM ${table} WHERE user_id IS NOT NULL AND user_id <> ?`,
            )
            .get(OWNER_ID);
        if (row && row.n > 0) {
            throw new Error(
                `Database audit failed: ${row.n} row(s) in ${table} belong to an owner other than the single local owner.`,
            );
        }
    }
}
