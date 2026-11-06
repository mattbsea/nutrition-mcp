import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS, TABLES, type Migration } from "./schema";
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
 *
 * user_version is (re-)read AFTER the write lock is taken: two processes that
 * open an empty file together both see 0 first, but the one that waits for the
 * lock finds the other's work done and skips it instead of failing on
 * "table already exists".
 */
export function runMigrations(
    db: Database,
    migrations: readonly Migration[] = MIGRATIONS,
): number {
    const latest = migrations[migrations.length - 1]?.version ?? 0;
    if (userVersion(db) > latest) {
        throw new Error(
            `Database schema version ${userVersion(db)} is newer than this build supports (${latest}); refusing to open it.`,
        );
    }
    for (const m of migrations) {
        if (m.version <= userVersion(db)) continue;
        db.exec("BEGIN IMMEDIATE");
        try {
            if (m.version <= userVersion(db)) {
                db.exec("COMMIT"); // another process migrated while we waited
                continue;
            }
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
 * Fails fast, with a clear message, when the runtime lacks what this layer
 * needs (bun:sqlite's Database#function and Transaction#immediate, STRICT
 * tables via SQLite >= 3.37). The Dockerfile pins the Bun version this was
 * built and tested with; this catches a stray older runtime.
 */
export function assertRuntimeSupport(db: Database): void {
    const proto = Object.getPrototypeOf(db) as Record<string, unknown>;
    if (
        typeof proto.function !== "function" ||
        typeof proto.transaction !== "function"
    ) {
        throw new Error(
            "This build needs a Bun with bun:sqlite Database#function and #transaction (Bun >= 1.4); upgrade the runtime.",
        );
    }
    const v =
        db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v ??
        "0";
    const [maj = 0, min = 0] = v.split(".").map(Number);
    if (maj < 3 || (maj === 3 && min < 37)) {
        throw new Error(`SQLite ${v} is too old: STRICT tables need >= 3.37.`);
    }
    const probe = db.transaction(() => 1);
    if (
        typeof (probe as unknown as { immediate?: unknown }).immediate !==
        "function"
    ) {
        throw new Error(
            "This Bun lacks Transaction#immediate; upgrade the runtime.",
        );
    }
}

/**
 * Owner-only storage: the directory is 0700 and the database file is created
 * 0600 BEFORE SQLite opens it (SQLite gives -wal and -shm the main file's
 * mode, so they inherit it). Nothing in /data is readable by another account
 * on the host or by a co-resident add-on's volume mount mistake.
 */
function prepareFiles(path: string): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
}

/** Belt and braces for sidecars created by an older run or another umask. */
function restrictSidecars(path: string): void {
    for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    }
}

/**
 * Opens (creating if needed) the database and brings it to the current schema.
 * `path` may be ":memory:" for tests. foreign_keys is a per-connection pragma
 * and must be set on every open.
 */
export function openDb(path: string = defaultDbPath()): Database {
    if (path !== ":memory:") prepareFiles(path);
    const db = new Database(path, { create: true, strict: true });
    try {
        assertRuntimeSupport(db);
        db.exec("PRAGMA foreign_keys = ON");
        // The database is SINGLE-PROCESS: one server process opens it once and
        // keeps the connection (getDb). bun:sqlite is synchronous, so this
        // timeout blocks the event loop while another process holds the write
        // lock; it exists to ride out a short external reader/backup, not to
        // support concurrent writers. External tools should open the file
        // read-only.
        db.exec("PRAGMA busy_timeout = 5000");
        // Deleted rows are overwritten with zeros instead of lingering in free
        // pages. Cost: every DELETE/UPDATE touches the freed bytes, a few
        // percent more write work, irrelevant at this data size. Together with
        // the WAL checkpoint after delete_account (db/account.ts) it is what makes
        // "permanently deleted" true of the files on disk.
        db.exec("PRAGMA secure_delete = ON");
        if (path !== ":memory:") {
            db.exec("PRAGMA journal_mode = WAL");
            db.exec("PRAGMA synchronous = NORMAL");
        }
        registerFunctions(db);
        runMigrations(db);
        assertSingleOwner(db);
        if (path !== ":memory:") restrictSidecars(path);
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
