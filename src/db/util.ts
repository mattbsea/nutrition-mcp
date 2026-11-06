import type { Database } from "bun:sqlite";
import { getDb } from "./conn";

/** An ISO-8601 UTC instant with milliseconds and a "Z": the one stored form. */
export function ts(value?: string | Date | number | null): string {
    const d =
        value === undefined || value === null ? new Date() : new Date(value);
    if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid timestamp: ${String(value)}`);
    }
    return d.toISOString();
}

/** JSON text for a TEXT column, or null. */
export function toJson(v: unknown): string | null {
    return v === undefined || v === null ? null : JSON.stringify(v);
}

/** Parses a JSON TEXT column; null/empty/garbage read as null. */
export function fromJson<T = unknown>(v: unknown): T | null {
    if (typeof v !== "string" || v === "") return null;
    try {
        return JSON.parse(v) as T;
    } catch {
        return null;
    }
}

export function numOrNull(v: unknown): number | null {
    return v == null ? null : Number(v);
}

export type Row = Record<string, unknown>;

/** Runs `fn` in one IMMEDIATE transaction (write lock up front, so a
 *  read-then-write sequence cannot interleave with another writer). Rolls back
 *  if `fn` throws. `fn` must be synchronous. */
export function tx<T>(fn: (db: Database) => T): T {
    const db = getDb();
    return db.transaction(() => fn(db)).immediate();
}

export function errorCode(e: unknown): string {
    return typeof e === "object" && e !== null && "code" in e
        ? String((e as { code: unknown }).code)
        : "";
}
export const isUniqueViolation = (e: unknown): boolean =>
    errorCode(e) === "SQLITE_CONSTRAINT_UNIQUE" ||
    errorCode(e) === "SQLITE_CONSTRAINT_PRIMARYKEY";
export const isForeignKeyViolation = (e: unknown): boolean =>
    errorCode(e) === "SQLITE_CONSTRAINT_FOREIGNKEY";

/** "?, ?, ?" for n placeholders. */
export const marks = (n: number): string => new Array(n).fill("?").join(", ");

/** Splits into chunks of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size));
    return out;
}

/** Postgres numeric(p,2) rounding for goal columns. */
export const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Canonical JSON (object keys sorted) so two label objects compare equal
 * regardless of key order, like the jsonb equality the snapshot guard used.
 */
export function canonicalJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
    if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
            .join(",")}}`;
    }
    return JSON.stringify(v);
}

/** SQL fragment: `col` is a LIKE-match of every lowercased token (AND). The
 *  tokens come from tokenizeQuery (already lowercase) and are escaped with
 *  escapeLikePattern; `ulower` is the per-connection Unicode lower(). */
export function likeAll(
    column: string,
    tokens: readonly string[],
    escape: (s: string) => string,
): { sql: string; params: string[] } {
    return {
        sql: tokens
            .map(() => `ulower(${column}) LIKE ? ESCAPE '\\'`)
            .join(" AND "),
        params: tokens.map((t) => `%${escape(t)}%`),
    };
}
