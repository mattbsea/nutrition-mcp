import { describe, expect, test } from "bun:test";
import { getDb } from "./conn.js";
import {
    SESSION_TTL_MS,
    TOUCH_INTERVAL_MS,
    countSessions,
    createSession,
    getSession,
    hashSessionToken,
    revokeAllSessions,
    revokeSession,
    sweepSessions,
} from "./sessions.js";
import { useMemoryDb } from "./test-helpers.js";

useMemoryDb();
const T0 = new Date("2026-03-10T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("dashboard sessions", () => {
    test("a created session is found by its token, which is stored only as a hash", () => {
        const { token, csrf } = createSession(T0);
        expect(getSession(token, T0)?.csrf).toBe(csrf);
        const rows = getDb()
            .query<{ id: string }, []>("SELECT id FROM dashboard_sessions")
            .all();
        expect(rows).toEqual([{ id: hashSessionToken(token) }]);
        expect(JSON.stringify(rows)).not.toContain(token);
    });

    test("an unknown, empty or oversized token finds nothing", () => {
        createSession(T0);
        expect(getSession("nope", T0)).toBeNull();
        expect(getSession("", T0)).toBeNull();
        expect(getSession("x".repeat(500), T0)).toBeNull();
    });

    test("expiry is 30 days and an expired session is deleted on lookup", () => {
        const a = createSession(T0);
        expect(getSession(a.token, later(SESSION_TTL_MS - 1))).not.toBeNull();
        // (that lookup slid the expiry; use a second session for the boundary)
        const b = createSession(T0);
        expect(getSession(b.token, later(SESSION_TTL_MS + 1))).toBeNull();
        expect(countSessions()).toBe(1);
    });

    test("use slides the expiry, but no more than once per touch interval", () => {
        const { token } = createSession(T0);
        const quick = getSession(token, later(TOUCH_INTERVAL_MS - 1000))!;
        expect(quick.renewed).toBe(false);
        const touched = getSession(token, later(TOUCH_INTERVAL_MS + 1000))!;
        expect(touched.renewed).toBe(true);
        // Alive well past the ORIGINAL 30 days because it was used at +1 h.
        expect(
            getSession(token, later(SESSION_TTL_MS + TOUCH_INTERVAL_MS / 2)),
        ).not.toBeNull();
    });

    test("revoking one session leaves the others; revoking all empties the table", () => {
        const a = createSession(T0);
        const b = createSession(T0);
        revokeSession(a.token);
        expect(getSession(a.token, T0)).toBeNull();
        expect(getSession(b.token, T0)).not.toBeNull();
        expect(revokeAllSessions()).toBe(1);
        expect(countSessions()).toBe(0);
    });

    test("sweep drops only expired rows", () => {
        createSession(T0);
        const fresh = createSession(later(SESSION_TTL_MS));
        expect(sweepSessions(later(SESSION_TTL_MS + 1))).toBe(1);
        expect(
            getSession(fresh.token, later(SESSION_TTL_MS + 2)),
        ).not.toBeNull();
    });

    test("tokens and CSRF values are long and distinct per session", () => {
        const a = createSession(T0);
        const b = createSession(T0);
        expect(a.token).not.toBe(b.token);
        expect(a.csrf).not.toBe(b.csrf);
        expect(a.token.length).toBeGreaterThanOrEqual(43);
        expect(a.csrf.length).toBeGreaterThanOrEqual(32);
    });
});
