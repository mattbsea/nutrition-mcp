/**
 * SQLite persistence layer: the drop-in replacement for src/supabase.ts and the
 * persistence half of src/health-sync-store.ts. Same function names, argument
 * shapes and return shapes; the only owner is OWNER_ID and every query still
 * filters on the `userId` it is given.
 *
 * Exports of src/supabase.ts that are NOT re-implemented (cloud-only: Supabase
 * Auth, OAuth, Patreon, analytics, landing stats) are listed in
 * step-A1-report.md.
 */
export { OWNER_ID } from "./owner.js";
export { openDb, defaultDbPath, runMigrations, assertSingleOwner } from "./migrate.js";
export { getDb, setDb, closeDb } from "./conn.js";
export { isUuid } from "./shared.js";
export * from "./types.js";
export * from "./meals.js";
export * from "./saved-meals.js";
export * from "./profile.js";
export * from "./logs.js";
export * from "./food-cache.js";
export * from "./account.js";
export * from "./health-store.js";

// Names the routes/export/tools still import until step A2 renames the call
// sites to the Sqlite* names above. Delete these in A2.
export {
    createSqliteHealthSyncStore as createSupabaseHealthSyncStore,
    createSqliteHealthActivityLinkStore as createSupabaseHealthActivityLinkStore,
    sqliteHealthSyncCleanupStore as supabaseHealthSyncCleanupStore,
} from "./health-store.js";

/**
 * Fetch pages via `fetchPage(from, to)` (inclusive, 0-indexed) until a page
 * comes back shorter than `pageSize`. SQLite has no row cap, so the repo's own
 * readers no longer page; this stays for callers that still do.
 */
export async function fetchAllPages<T>(
    fetchPage: (from: number, to: number) => Promise<T[]>,
    pageSize = 1000,
): Promise<T[]> {
    const all: T[] = [];
    for (let from = 0; ; from += pageSize) {
        const page = await fetchPage(from, from + pageSize - 1);
        all.push(...page);
        if (page.length < pageSize) break;
    }
    return all;
}

/** Throws when a paged window read came back with fewer distinct rows than
 *  the expected count. More than expected is fine: a concurrent insert. */
export function assertWindowComplete(
    noun: string,
    fetched: number,
    expected: number | null,
): void {
    if (expected !== null && fetched < expected) {
        throw new Error(
            `Failed to get ${noun}: fetched ${fetched} of ${expected} rows — result would be truncated`,
        );
    }
}
