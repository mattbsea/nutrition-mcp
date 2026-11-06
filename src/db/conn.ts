import type { Database } from "bun:sqlite";
import { openDb } from "./migrate";

let current: Database | null = null;

/** The process-wide connection, opened (and migrated) on first use. */
export function getDb(): Database {
    if (!current) current = openDb();
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
