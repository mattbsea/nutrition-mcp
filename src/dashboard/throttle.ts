/**
 * Backoff for password attempts (login and the re-entry that reveals a key).
 *
 *  - per address (IPv6 already reduced to its /64 by getClientIp): the first
 *    FREE_FAILURES wrong passwords cost nothing; every one after that locks the
 *    address for 30 s, doubling to a 15 min ceiling. A right password resets it.
 *  - global: more than GLOBAL_PER_MIN wrong passwords across ALL addresses in
 *    a minute locks everyone out until the window slides, because per-address
 *    counting cannot stop an attacker who rotates addresses. The price is that
 *    a flood can keep the owner out of the dashboard; the MCP endpoint and the
 *    Health API are separate and unaffected.
 *
 * State is bounded (MAX_TRACKED addresses, oldest evicted) and in memory only.
 */
export const FREE_FAILURES = 4;
export const GLOBAL_PER_MIN = 30;
export const MAX_TRACKED = 5_000;
const BASE_LOCK_S = 30;
const MAX_LOCK_S = 15 * 60;
const FORGET_AFTER_MS = 60 * 60_000;

interface Entry {
    fails: number;
    lockedUntil: number;
    last: number;
}

export type Verdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export class LoginThrottle {
    private entries = new Map<string, Entry>();
    private recent: number[] = [];

    constructor(private clock: () => number = Date.now) {}

    /** May this address try a password right now? */
    check(address: string): Verdict {
        const now = this.clock();
        this.recent = this.recent.filter((t) => now - t < 60_000);
        if (this.recent.length >= GLOBAL_PER_MIN) {
            const oldest = this.recent[0]!;
            return {
                ok: false,
                retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((oldest + 60_000 - now) / 1000),
                ),
            };
        }
        const e = this.entries.get(address);
        if (e && e.lockedUntil > now) {
            return {
                ok: false,
                retryAfterSeconds: Math.ceil((e.lockedUntil - now) / 1000),
            };
        }
        return { ok: true };
    }

    /** A wrong password from this address. Returns the new lock, if any. */
    fail(address: string): number {
        const now = this.clock();
        this.recent.push(now);
        let e = this.entries.get(address);
        if (!e || now - e.last > FORGET_AFTER_MS) {
            e = { fails: 0, lockedUntil: 0, last: now };
        }
        e.fails += 1;
        e.last = now;
        let lock = 0;
        if (e.fails > FREE_FAILURES) {
            lock = Math.min(
                MAX_LOCK_S,
                BASE_LOCK_S * 2 ** (e.fails - FREE_FAILURES - 1),
            );
            e.lockedUntil = now + lock * 1000;
        }
        // Re-insert so Map order is recency order, then bound the map.
        this.entries.delete(address);
        this.entries.set(address, e);
        while (this.entries.size > MAX_TRACKED) {
            const oldest = this.entries.keys().next().value as string;
            this.entries.delete(oldest);
        }
        return lock;
    }

    /** A right password: forget this address's failures. */
    succeed(address: string): void {
        this.entries.delete(address);
    }

    /** Test seam. */
    size(): number {
        return this.entries.size;
    }
    reset(): void {
        this.entries.clear();
        this.recent = [];
    }
}
