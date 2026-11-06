import type { Database } from "bun:sqlite";
import { getDb } from "./conn";

/** A date-time with no zone designator ("2026-11-06T08:00:00", with a "T" or a
 *  space). JavaScript would read it in the PROCESS time zone; the database
 *  reads it as UTC (what Postgres did under Supabase's UTC session). */
const NO_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/** An ISO-8601 UTC instant with milliseconds and a "Z": the one stored form.
 *  A string without an offset is UTC, independent of the TZ environment. */
export function ts(value?: string | Date | number | null): string {
    const d =
        value === undefined || value === null
            ? new Date()
            : typeof value === "string" && NO_OFFSET.test(value.trim())
              ? new Date(`${value.trim().replace(" ", "T")}Z`)
              : new Date(value);
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

/**
 * Postgres numeric(p,2) rounding for goal columns: half away from zero on the
 * DECIMAL value, not the binary double (Math.round(1.005 * 100) is 100, but
 * numeric stores 1.01). The shortest decimal string of the double is what the
 * caller typed, so it is rounded as a string.
 */
export function round2(v: number): number {
    if (!Number.isFinite(v)) return v;
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v));
    if (!m) return Math.round(v * 100) / 100; // exponent form: |v| < 1e-6 or >= 1e21
    const [, sign, whole, frac = ""] = m;
    const digits = BigInt(whole + frac.padEnd(2, "0").slice(0, 2));
    const roundUp = frac.length > 2 && frac.charCodeAt(2) >= 53; // '5'
    const total = digits + (roundUp ? 1n : 0n);
    const out = Number(
        `${total / 100n}.${String(total % 100n).padStart(2, "0")}`,
    );
    return sign ? -out : out;
}

/** UUIDs are stored lowercase and Postgres compared uuid values
 *  case-insensitively; SQLite compares TEXT exactly. Lowercase a UUID-shaped
 *  id on the way in; anything else is left alone (it matches nothing). */
export function normId(id: string): string {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
    )
        ? id.toLowerCase()
        : id;
}

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
