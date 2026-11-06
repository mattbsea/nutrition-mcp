/**
 * Dashboard login sessions. The cookie carries a random token; the table holds
 * only its SHA-256, so the database file alone cannot mint a cookie. Expiry
 * slides: using a session pushes expires_at out again (at most once per
 * TOUCH_INTERVAL_MS, to keep reads from turning into writes).
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./conn.js";
import { ts } from "./util.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface DashboardSession {
    csrf: string;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
    /** True when this lookup pushed the expiry out (the cookie should be re-issued). */
    renewed: boolean;
}

export const hashSessionToken = (token: string): string =>
    createHash("sha256").update(token).digest("hex");

/** Starts a session; returns the raw token (for the cookie) and its CSRF token. */
export function createSession(now: Date = new Date()): {
    token: string;
    csrf: string;
    expires_at: string;
} {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expires = ts(new Date(now.getTime() + SESSION_TTL_MS));
    getDb()
        .query(
            `INSERT INTO dashboard_sessions (id, csrf, created_at, last_seen_at, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .run(hashSessionToken(token), csrf, ts(now), ts(now), expires);
    return { token, csrf, expires_at: expires };
}

/** The live session for a token, sliding its expiry; null if unknown or expired. */
export function getSession(
    token: string,
    now: Date = new Date(),
): DashboardSession | null {
    if (!token || token.length > 200) return null;
    const id = hashSessionToken(token);
    const row = getDb()
        .query<Omit<DashboardSession, "renewed">, [string]>(
            "SELECT csrf, created_at, last_seen_at, expires_at FROM dashboard_sessions WHERE id = ?",
        )
        .get(id);
    if (!row) return null;
    if (row.expires_at <= ts(now)) {
        getDb().query("DELETE FROM dashboard_sessions WHERE id = ?").run(id);
        return null;
    }
    if (now.getTime() - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
        const expires = ts(new Date(now.getTime() + SESSION_TTL_MS));
        getDb()
            .query(
                "UPDATE dashboard_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
            )
            .run(ts(now), expires, id);
        return {
            ...row,
            last_seen_at: ts(now),
            expires_at: expires,
            renewed: true,
        };
    }
    return { ...row, renewed: false };
}

/** Ends one session (logout). */
export function revokeSession(token: string): void {
    getDb()
        .query("DELETE FROM dashboard_sessions WHERE id = ?")
        .run(hashSessionToken(token));
}

/** Ends every session (password change, "sign out everywhere"). */
export function revokeAllSessions(): number {
    return getDb().query("DELETE FROM dashboard_sessions").run().changes;
}

/** Drops expired rows; returns how many. */
export function sweepSessions(now: Date = new Date()): number {
    return getDb()
        .query("DELETE FROM dashboard_sessions WHERE expires_at <= ?")
        .run(ts(now)).changes;
}

export function countSessions(): number {
    return getDb()
        .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM dashboard_sessions",
        )
        .get()!.n;
}
