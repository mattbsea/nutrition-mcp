import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSingleOwner, openDb, runMigrations } from "./migrate";
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from "./schema";
import { OWNER_ID } from "./owner";

const dirs: string[] = [];
afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tableNames = (db: Database) =>
    db
        .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((r) => r.name);

describe("schema", () => {
    test("creates exactly the 16 retained tables", () => {
        const db = openDb(":memory:");
        expect(tableNames(db)).toEqual([...TABLES].sort());
        expect(TABLES.length).toBe(16);
        db.close();
    });

    test("foreign keys are enforced and user_version is current", () => {
        const db = openDb(":memory:");
        expect(
            db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!
                .foreign_keys,
        ).toBe(1);
        expect(
            db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
                .user_version,
        ).toBe(SCHEMA_VERSION);
        db.close();
    });

    test("the partial unique idempotency indexes exist for the five logs", () => {
        const db = openDb(":memory:");
        const idx = db
            .query<{ name: string; sql: string }, []>(
                "SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'uniq_%idem'",
            )
            .all();
        expect(idx.map((i) => i.name).sort()).toEqual([
            "uniq_active_calories_log_user_idem",
            "uniq_body_measurement_log_user_idem",
            "uniq_meals_user_idem",
            "uniq_water_log_user_idem",
            "uniq_weight_log_user_idem",
        ]);
        for (const i of idx)
            expect(i.sql).toContain("WHERE idempotency_key IS NOT NULL");
        db.close();
    });

    test("integer columns reject fractional values, like Postgres", () => {
        const db = openDb(":memory:");
        expect(() =>
            db
                .query(
                    "INSERT INTO meals (user_id, description, calories) VALUES (?, 'x', 10.5)",
                )
                .run(OWNER_ID),
        ).toThrow();
        db.query(
            "INSERT INTO meals (user_id, description, calories) VALUES (?, 'x', 10)",
        ).run(OWNER_ID);
        db.close();
    });
});

describe("migrations", () => {
    test("running them again on a migrated database changes nothing", () => {
        const db = openDb(":memory:");
        db.query(
            "INSERT INTO water_log (user_id, amount_ml) VALUES (?, 250)",
        ).run(OWNER_ID);
        expect(runMigrations(db)).toBe(SCHEMA_VERSION);
        expect(runMigrations(db)).toBe(SCHEMA_VERSION);
        expect(
            db
                .query<{ n: number }, []>("SELECT count(*) n FROM water_log")
                .get()!.n,
        ).toBe(1);
        db.close();
    });

    test("a file database persists across reopen and is not re-created", () => {
        const dir = mkdtempSync(join(tmpdir(), "nutdb-"));
        dirs.push(dir);
        const path = join(dir, "sub", "nutrition.db");
        const a = openDb(path);
        a.query(
            "INSERT INTO water_log (user_id, amount_ml) VALUES (?, 500)",
        ).run(OWNER_ID);
        expect(
            a.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!
                .journal_mode,
        ).toBe("wal");
        a.close();
        const b = openDb(path);
        expect(
            b
                .query<{ amount_ml: number }, []>(
                    "SELECT amount_ml FROM water_log",
                )
                .get()!.amount_ml,
        ).toBe(500);
        b.close();
    });

    test("DATA_DIR selects the default path", () => {
        const dir = mkdtempSync(join(tmpdir(), "nutdb-"));
        dirs.push(dir);
        const prev = process.env.DATA_DIR;
        process.env.DATA_DIR = dir;
        try {
            const db = openDb();
            db.close();
            expect(Bun.file(join(dir, "nutrition.db")).size).toBeGreaterThan(0);
        } finally {
            if (prev === undefined) delete process.env.DATA_DIR;
            else process.env.DATA_DIR = prev;
        }
    });

    test("a database from a newer build is refused", () => {
        const db = new Database(":memory:");
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        expect(() => runMigrations(db)).toThrow(/newer than this build/);
        db.close();
    });

    test("a failing migration rolls back completely and keeps the version", () => {
        const db = new Database(":memory:");
        const bad = {
            version: 1,
            name: "bad",
            sql: "CREATE TABLE ok (a); CREATE TABLE ok (b);",
        };
        expect(() => runMigrations(db, [bad])).toThrow(/already exists/);
        expect(tableNames(db)).toEqual([]);
        expect(
            db.query<{ user_version: number }, []>("PRAGMA user_version").get()!
                .user_version,
        ).toBe(0);
        db.close();
    });

    test("a migration another process already applied while we waited for the lock is skipped", () => {
        const dir = mkdtempSync(join(tmpdir(), "nutdb-"));
        dirs.push(dir);
        const path = join(dir, "n.db");
        const a = new Database(path, { create: true });
        const b = new Database(path);
        // b read user_version = 0 first (the stale read the old runner acted on)...
        expect(
            b.query<{ user_version: number }, []>("PRAGMA user_version").get()!
                .user_version,
        ).toBe(0);
        // ...then a migrates; b must notice under its own lock, not re-run V1.
        runMigrations(a);
        expect(runMigrations(b)).toBe(SCHEMA_VERSION);
        a.close();
        b.close();
    });

    test("MIGRATIONS versions are strictly increasing from 1", () => {
        MIGRATIONS.forEach((m, i) => expect(m.version).toBe(i + 1));
    });
});

describe("owner audit", () => {
    test("passes with only the local owner and fails on a stray owner id", () => {
        const db = openDb(":memory:");
        db.query(
            "INSERT INTO water_log (user_id, amount_ml) VALUES (?, 250)",
        ).run(OWNER_ID);
        expect(() => assertSingleOwner(db)).not.toThrow();
        db.query(
            "INSERT INTO water_log (user_id, amount_ml) VALUES ('someone-else', 250)",
        ).run();
        expect(() => assertSingleOwner(db)).toThrow(
            /other than the single local owner/,
        );
        db.close();
    });
});
