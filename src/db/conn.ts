import type { Database } from "bun:sqlite";
import { openDb } from "./migrate";

let current: Database | null = null;

/** The process-wide connection, opened (and migrated) on first use. */
export function getDb(): Database {
    if (!current) {
        // Under `bun test` (NODE_ENV=test) the on-disk database must never be
        // opened by accident: a test that reaches a real repo function without
        // installing an in-memory database (setDb) is wrong, and would create
        // ./data/nutrition.db inside the checkout.
        if (process.env.NODE_ENV === "test" && !process.env.DATA_DIR) {
            throw new Error(
                "getDb() called in a test without setDb(openDb(':memory:')); refusing to open ./data/nutrition.db",
            );
        }
        current = openDb();
    }
    return current;
}

/** Installs a connection (tests pass an in-memory one); null resets it. */
export function setDb(db: Database | null): void {
    current = db;
}

/** Closes and forgets the process-wide connection (graceful shutdown). */
export function closeDb(): void {
    current?.close();
    current = null;
}
