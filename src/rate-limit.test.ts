import { test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import {
    checkRateLimit,
    noteAuthFailure,
    noteGlobalFailure,
    globalFailureThrottle,
    GLOBAL_FAILURE_BUDGET_PER_MIN,
    MAX_TRACKED_CLIENTS,
    _sweepNow,
    _trackedClientCount,
    clearAuthFailures,
    getBanState,
    _resetBuckets,
} from "./rate-limit.js";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const MINUTE = 60_000;

// Every test drives the clock explicitly so nothing depends on wall time.
let now = T0;
function at(ms: number): void {
    now = ms;
    setSystemTime(new Date(now));
}
function advance(ms: number): void {
    at(now + ms);
}

function fail(ip: string, times: number) {
    let last = { banned: false } as ReturnType<typeof noteAuthFailure>;
    for (let i = 0; i < times; i++) {
        last = noteAuthFailure(ip);
    }
    return last;
}

beforeEach(() => {
    _resetBuckets();
    at(T0);
});

afterEach(() => {
    _resetBuckets();
    setSystemTime();
});

test("19 consecutive failures do not ban, the 20th does", () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < 19; i++) {
        expect(noteAuthFailure(ip).banned).toBe(false);
    }
    expect(getBanState(ip).banned).toBe(false);

    const twentieth = noteAuthFailure(ip);
    expect(twentieth.banned).toBe(true);
    expect(twentieth.retryAfterSeconds).toBe(5 * 60);
    expect(getBanState(ip).banned).toBe(true);
});

test("a success resets the run, so a shared NAT IP never accumulates a ban", () => {
    // One broken client on the IP fails forever while real users behind the
    // same NAT keep authenticating successfully. 190 total failures, never 20
    // in a row, so the IP must never be banned.
    const ip = "198.51.100.42";
    for (let round = 0; round < 10; round++) {
        expect(fail(ip, 19).banned).toBe(false);
        clearAuthFailures(ip);
        expect(getBanState(ip).banned).toBe(false);
    }
    expect(getBanState(ip).banned).toBe(false);

    // And the counter really is back at zero: 19 more still isn't enough.
    expect(fail(ip, 19).banned).toBe(false);
});

test("clearAuthFailures lifts an active ban", () => {
    const ip = "198.51.100.9";
    expect(fail(ip, 20).banned).toBe(true);

    clearAuthFailures(ip);
    expect(getBanState(ip).banned).toBe(false);
    expect(fail(ip, 19).banned).toBe(false);
});

test("ban durations escalate 5, 10, 20, 40, 60, then cap at 60 minutes", () => {
    const ip = "203.0.113.99";
    const expectedMinutes = [5, 10, 20, 40, 60, 60];

    for (const minutes of expectedMinutes) {
        const result = fail(ip, 20);
        expect(result.banned).toBe(true);
        expect(result.retryAfterSeconds).toBe(minutes * 60);

        // Sit out the ban before earning the next one.
        advance(minutes * MINUTE + 1000);
        expect(getBanState(ip).banned).toBe(false);
    }
});

test("the ban lifts once its duration elapses", () => {
    const ip = "203.0.113.11";
    expect(fail(ip, 20).banned).toBe(true);

    advance(5 * MINUTE - 1000);
    expect(getBanState(ip).banned).toBe(true);

    advance(1000);
    expect(getBanState(ip).banned).toBe(false);
    // Post-ban the strike counter starts fresh rather than re-tripping.
    expect(noteAuthFailure(ip).banned).toBe(false);
});

test("hammering while banned does not extend the ban", () => {
    const ip = "203.0.113.12";
    expect(fail(ip, 20).banned).toBe(true);

    // 500 more attempts spread across the ban window must not push it out.
    for (let i = 0; i < 5; i++) {
        advance(30_000);
        const result = fail(ip, 100);
        expect(result.banned).toBe(true);
        expect(result.retryAfterSeconds).toBe(5 * 60 - (i + 1) * 30);
    }

    advance(2.5 * MINUTE + 1000);
    expect(getBanState(ip).banned).toBe(false);
});

test("strikes decay after 10 idle minutes", () => {
    const ip = "203.0.113.13";
    expect(fail(ip, 19).banned).toBe(false);

    advance(10 * MINUTE);
    // The run restarted, so another 19 still isn't a ban — 38 total failures.
    expect(fail(ip, 19).banned).toBe(false);
    // ...but 20 in a row within the window is.
    expect(noteAuthFailure(ip).banned).toBe(true);
});

test("a slow trickle of failures never trips a ban", () => {
    const ip = "203.0.113.14";
    for (let i = 0; i < 100; i++) {
        expect(noteAuthFailure(ip).banned).toBe(false);
        advance(11 * MINUTE);
    }
});

test("retryAfterSeconds counts down accurately and never drops below 1", () => {
    const ip = "203.0.113.15";
    expect(fail(ip, 20).retryAfterSeconds).toBe(5 * 60);

    advance(60_000);
    expect(getBanState(ip).retryAfterSeconds).toBe(4 * 60);

    advance(3 * MINUTE + 59_500);
    // 500ms left rounds up rather than reporting 0.
    expect(getBanState(ip).retryAfterSeconds).toBe(1);

    advance(499);
    expect(getBanState(ip).retryAfterSeconds).toBe(1);

    advance(1);
    expect(getBanState(ip).banned).toBe(false);
    expect(getBanState(ip).retryAfterSeconds).toBeUndefined();
});

test("getBanState is read-only and does not count as an attempt", () => {
    const ip = "203.0.113.16";
    fail(ip, 19);
    for (let i = 0; i < 50; i++) {
        expect(getBanState(ip).banned).toBe(false);
    }
    // The 20th *failure* is what bans, not the reads in between.
    expect(noteAuthFailure(ip).banned).toBe(true);
});

test("bans are per-IP and independent", () => {
    const banned = "203.0.113.20";
    const innocent = "203.0.113.21";

    fail(innocent, 15);
    expect(fail(banned, 20).banned).toBe(true);

    expect(getBanState(innocent).banned).toBe(false);
    expect(fail(innocent, 4).banned).toBe(false);
    expect(getBanState(banned).banned).toBe(true);

    // The innocent IP's own 20th still bans it, at its own base duration.
    expect(noteAuthFailure(innocent).retryAfterSeconds).toBe(5 * 60);
});

test("escalation decays after 6 quiet hours", () => {
    const ip = "203.0.113.22";
    expect(fail(ip, 20).retryAfterSeconds).toBe(5 * 60);
    advance(5 * MINUTE + 1000);
    expect(fail(ip, 20).retryAfterSeconds).toBe(10 * 60);

    advance(6 * 60 * MINUTE);
    // Back to a clean record: the next ban starts at the 5-minute tier again.
    expect(fail(ip, 20).retryAfterSeconds).toBe(5 * 60);
});

test("unknown IPs report no ban", () => {
    expect(getBanState("203.0.113.30")).toEqual({ banned: false });
    // Clearing an IP we've never seen is a no-op, not a crash.
    clearAuthFailures("203.0.113.30");
    expect(getBanState("203.0.113.30").banned).toBe(false);
});

// --- Regression coverage for the pre-existing sliding windows ---

test("checkRateLimit allows 600 requests per owner per minute, then blocks", () => {
    const user = "user-abc";
    for (let i = 0; i < 600; i++) {
        const result = checkRateLimit(user);
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(600);
        expect(result.remaining).toBe(599 - i);
    }

    const blocked = checkRateLimit(user);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(60);

    // The window slides: once the oldest entry ages out, traffic resumes.
    advance(60_000);
    expect(checkRateLimit(user).allowed).toBe(true);
});

test("_resetBuckets clears rate-limit windows and ban state together", () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 600; i++) checkRateLimit(ip);
    expect(checkRateLimit(ip).allowed).toBe(false);
    expect(fail(ip, 20).banned).toBe(true);

    _resetBuckets();

    expect(checkRateLimit(ip).allowed).toBe(true);
    expect(getBanState(ip).banned).toBe(false);
});

// ---------- bounded memory and the global failure budget ----------

test("the failure map is bounded: a flood of distinct addresses never grows it past the cap", () => {
    for (let i = 0; i < MAX_TRACKED_CLIENTS * 3; i++) {
        noteAuthFailure(
            `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::/64`,
        );
    }
    expect(_trackedClientCount()).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);
    expect(_trackedClientCount()).toBe(MAX_TRACKED_CLIENTS);
});

test("eviction spares an address that is serving a ban", () => {
    const attacker = "203.0.113.200";
    expect(fail(attacker, 20).banned).toBe(true);
    for (let i = 0; i < MAX_TRACKED_CLIENTS * 2; i++)
        noteAuthFailure(`198.51.${i >> 8}.${i & 255}x${i}`);
    expect(_trackedClientCount()).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);
    expect(getBanState(attacker).banned).toBe(true);
});

test("an entry that never reached a ban is forgotten after 15 minutes; one that earned a ban is kept longer", () => {
    noteAuthFailure("203.0.113.1"); // one stray failure
    fail("203.0.113.2", 20); // earned a ban (escalation 1)
    advance(14 * 60_000);
    _sweepNow();
    expect(_trackedClientCount()).toBe(2);
    advance(2 * 60_000); // 16 min since the stray failure
    _sweepNow();
    expect(_trackedClientCount()).toBe(1);
    advance(6 * 60 * 60_000);
    _sweepNow();
    expect(_trackedClientCount()).toBe(0);
});

test("the global budget sheds wrong-key requests after N per minute and recovers as the window slides", () => {
    for (let i = 0; i < GLOBAL_FAILURE_BUDGET_PER_MIN - 1; i++) {
        expect(noteGlobalFailure().throttled).toBe(false);
    }
    // the Nth failure fills the budget: it and everything after is shed
    const last = noteGlobalFailure();
    expect(last.throttled).toBe(true);
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
    expect(globalFailureThrottle().throttled).toBe(true);
    // over budget nothing more is stored: the bound is the budget
    for (let i = 0; i < 1000; i++) noteGlobalFailure();
    advance(60_001);
    expect(globalFailureThrottle().throttled).toBe(false);
    expect(noteGlobalFailure().throttled).toBe(false);
});
