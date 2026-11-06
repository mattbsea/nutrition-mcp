// In-memory limiters for the single-owner server: failure counting per client
// address (with a ban), a global wrong-key budget, and per-owner request windows.
// All state is bounded; none of it survives a restart, by design.

const WINDOW_MS = 60_000;
// Per-owner limit for authenticated MCP traffic. Generous (10 a second): it
// exists to stop a looping client from hammering the database and the food
// APIs, not to ration normal use. Tool calls in one chat turn arrive in bursts.
export const MCP_LIMIT_PER_WINDOW = 600;
const LIMIT_PER_WINDOW = MCP_LIMIT_PER_WINDOW;
// Per-owner limit for the Apple Health sync API (every route under
// /api/v1/health-sync). One hourly run is a /pending, an /ack per entry (at most
// one per day of the 7-day window) and an activity post, so this leaves room
// for a retried run without letting a looping shortcut hammer the meal reads.
export const HEALTH_SYNC_LIMIT_PER_WINDOW = 40;
const SWEEP_INTERVAL_MS = 5 * 60_000;

// Strike-based banning for addresses that keep presenting a wrong key. A
// sliding window alone can't tell a client with a stale key retrying from an
// attacker guessing, so we count *consecutive* failures: any request with the
// right key from that address wipes the slate, which keeps a household whose
// phone shares an address with a broken client off the ban list.
const BAN_STRIKE_THRESHOLD = 20;
// The failure map is bounded. Client addresses are attacker-influenced strings
// (a forged X-Forwarded-For, or an IPv6 /64 full of addresses), so without a cap
// an unauthenticated caller could grow it without limit. At the cap the oldest
// entry that is not serving a ban is evicted first (LRU by last touch).
export const MAX_TRACKED_CLIENTS = 10_000;
// An entry that never reached a ban is forgotten this long after its last
// failure: it holds nothing worth acting on. (An address that has EARNED a ban
// keeps its escalation level for ESCALATION_DECAY_MS.)
const FAILURE_ENTRY_TTL_MS = 15 * 60_000;
// Global failure budget: total wrong-key requests per minute across ALL client
// addresses. Per-address counting cannot stop an attacker who presents a fresh
// address with every request, so once this many wrong keys arrive within a
// minute, every further wrong-key request is answered 429 until the window
// slides. A correct key is never affected. 30 a minute is far above human
// typos and far below anything useful for guessing a key.
export const GLOBAL_FAILURE_BUDGET_PER_MIN = 30;
// Escalating ban lengths for repeat offenders, capped at the last entry so a
// persistent attacker plateaus rather than being locked out permanently.
const BAN_DURATIONS_MS = [5, 10, 20, 40, 60].map((m) => m * 60_000);
// Strikes are only "consecutive" if they're close together — an IP that
// trickles a stray 401 every so often should never accumulate its way to a ban.
const STRIKE_DECAY_MS = 10 * 60_000;
// Forgive the escalation level too, eventually, so a one-off bad afternoon
// doesn't make an IP a permanent repeat offender.
const ESCALATION_DECAY_MS = 6 * 60 * 60_000;

interface AuthFailureEntry {
    // Consecutive failures since the last success, ban, or decay.
    strikes: number;
    lastFailureAt: number;
    // Epoch ms the current ban ends; 0 when not banned.
    bannedUntil: number;
    // Index into BAN_DURATIONS_MS for the *next* ban this IP earns.
    escalation: number;
}

const buckets = new Map<string, number[]>();
const authFailures = new Map<string, AuthFailureEntry>();
const healthSyncBuckets = new Map<string, number[]>();

// Periodically drop buckets whose newest entry is older than the window, so
// a caller who stops making requests doesn't keep a slot in the Map forever.
function sweep(): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    for (const map of [buckets, healthSyncBuckets]) {
        for (const [key, timestamps] of map) {
            const last = timestamps[timestamps.length - 1];
            if (last == null || last < cutoff) {
                map.delete(key);
            }
        }
    }
    // A failure entry is only droppable once it holds nothing we'd act on:
    // no live ban, and idle long enough that both the strikes and the
    // escalation level would have decayed to zero anyway.
    for (const [ip, entry] of authFailures) {
        if (entry.bannedUntil > now) continue;
        const idle = now - entry.lastFailureAt;
        if (
            idle >= ESCALATION_DECAY_MS ||
            (entry.escalation === 0 && idle >= FAILURE_ENTRY_TTL_MS)
        ) {
            authFailures.delete(ip);
        }
    }
}

const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
// A sweep timer must never keep a script or a test process alive.
sweepTimer.unref?.();

export interface RateLimitResult {
    allowed: boolean;
    retryAfterSeconds?: number;
    remaining: number;
    limit: number;
}

// Shared sliding-window check against a given bucket store and limit.
function slidingWindow(
    store: Map<string, number[]>,
    key: string,
    limit: number,
): RateLimitResult {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const existing = store.get(key) ?? [];

    // Trim in place: keep only entries within the window.
    let keepFrom = 0;
    while (keepFrom < existing.length && existing[keepFrom]! <= cutoff) {
        keepFrom++;
    }
    const trimmed = keepFrom === 0 ? existing : existing.slice(keepFrom);

    if (trimmed.length >= limit) {
        const oldest = trimmed[0]!;
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil((oldest + WINDOW_MS - now) / 1000),
        );
        store.set(key, trimmed);
        return {
            allowed: false,
            retryAfterSeconds,
            remaining: 0,
            limit,
        };
    }

    trimmed.push(now);
    store.set(key, trimmed);
    return {
        allowed: true,
        remaining: limit - trimmed.length,
        limit,
    };
}

export function checkRateLimit(userId: string): RateLimitResult {
    return slidingWindow(buckets, userId, LIMIT_PER_WINDOW);
}

// Per-owner limiter for the Apple Health sync API.
export function checkHealthSyncRateLimit(userId: string): RateLimitResult {
    return slidingWindow(
        healthSyncBuckets,
        userId,
        HEALTH_SYNC_LIMIT_PER_WINDOW,
    );
}

export interface BanState {
    banned: boolean;
    retryAfterSeconds?: number;
}

const NOT_BANNED: BanState = { banned: false };

function bannedState(bannedUntil: number, now: number): BanState {
    // Round up and floor at 1: a Retry-After of 0 invites an instant retry.
    return {
        banned: true,
        retryAfterSeconds: Math.max(1, Math.ceil((bannedUntil - now) / 1000)),
    };
}

/** Store `entry` as the most recently used, evicting to stay under the cap. */
function track(ip: string, entry: AuthFailureEntry): void {
    authFailures.delete(ip);
    authFailures.set(ip, entry);
    if (authFailures.size <= MAX_TRACKED_CLIENTS) return;
    const now = Date.now();
    for (const [key, e] of authFailures) {
        if (e.bannedUntil <= now) {
            authFailures.delete(key);
            return;
        }
    }
    // Every tracked address is serving a ban: drop the oldest regardless.
    const oldest = authFailures.keys().next().value;
    if (oldest !== undefined) authFailures.delete(oldest);
}

// Record one failed (401) unauthenticated attempt from this IP and report the
// resulting ban state.
export function noteAuthFailure(ip: string): BanState {
    const now = Date.now();
    const entry = authFailures.get(ip) ?? {
        strikes: 0,
        lastFailureAt: now,
        bannedUntil: 0,
        escalation: 0,
    };

    const idle = now - entry.lastFailureAt;
    if (idle >= ESCALATION_DECAY_MS) {
        entry.escalation = 0;
        entry.strikes = 0;
    } else if (idle >= STRIKE_DECAY_MS) {
        entry.strikes = 0;
    }
    entry.lastFailureAt = now;

    if (entry.bannedUntil > now) {
        // Deliberately no strike, no extension: a client hammering through its
        // ban would otherwise renew it forever and never get a chance to come
        // back with a fixed token. Escalation is earned by tripping a *new*
        // ban after this one expires, not by keeping this one alive.
        track(ip, entry);
        return bannedState(entry.bannedUntil, now);
    }

    entry.strikes++;
    if (entry.strikes >= BAN_STRIKE_THRESHOLD) {
        const duration =
            BAN_DURATIONS_MS[
                Math.min(entry.escalation, BAN_DURATIONS_MS.length - 1)
            ]!;
        entry.bannedUntil = now + duration;
        entry.escalation++;
        // Start the next run from scratch; the ban itself is the punishment
        // for the strikes just spent.
        entry.strikes = 0;
        track(ip, entry);
        return bannedState(entry.bannedUntil, now);
    }

    track(ip, entry);
    return NOT_BANNED;
}

// Clear strikes and any active ban for this IP, called whenever auth succeeds.
// The escalation level survives, so an attacker can't launder a repeat-offender
// record with a single valid request between rounds.
export function clearAuthFailures(ip: string): void {
    const entry = authFailures.get(ip);
    if (!entry) return;
    entry.strikes = 0;
    entry.bannedUntil = 0;
    if (entry.escalation === 0) {
        // Nothing left worth remembering — don't hold the slot.
        authFailures.delete(ip);
    }
}

// Read-only view of the ban state; does not count as an attempt.
export function getBanState(ip: string): BanState {
    const entry = authFailures.get(ip);
    if (!entry) return NOT_BANNED;
    const now = Date.now();
    if (entry.bannedUntil <= now) return NOT_BANNED;
    return bannedState(entry.bannedUntil, now);
}

let globalFailures: number[] = [];

export interface GlobalThrottle {
    throttled: boolean;
    retryAfterSeconds: number;
}

/** Whether wrong-key requests are currently being shed globally. */
export function globalFailureThrottle(): GlobalThrottle {
    const now = Date.now();
    globalFailures = globalFailures.filter((t) => t > now - WINDOW_MS);
    if (globalFailures.length < GLOBAL_FAILURE_BUDGET_PER_MIN) {
        return { throttled: false, retryAfterSeconds: 0 };
    }
    const oldest = globalFailures[0]!;
    return {
        throttled: true,
        retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldest + WINDOW_MS - now) / 1000),
        ),
    };
}

/**
 * Count one wrong-key request against the global budget and report whether it
 * (and so every further wrong-key request this minute) is shed. Over budget,
 * nothing more is stored, so the array stays at most the budget long.
 */
export function noteGlobalFailure(): GlobalThrottle {
    const state = globalFailureThrottle();
    if (state.throttled) return state;
    globalFailures.push(Date.now());
    return globalFailureThrottle();
}

/** Runs the periodic sweep now (tests). */
export const _sweepNow = sweep;

/** How many addresses are tracked (tests: the bound holds). */
export function _trackedClientCount(): number {
    return authFailures.size;
}

// Exposed for tests.
export function _resetBuckets(): void {
    globalFailures = [];
    buckets.clear();
    authFailures.clear();
    healthSyncBuckets.clear();
}
