import { describe, expect, test } from "bun:test";
import {
    FREE_FAILURES,
    GLOBAL_PER_MIN,
    LoginThrottle,
    MAX_TRACKED,
} from "./throttle.js";

function setup() {
    let t = 1_000_000;
    const throttle = new LoginThrottle(() => t);
    return { throttle, advance: (ms: number) => (t += ms) };
}

describe("LoginThrottle", () => {
    test("the first failures are free, then the lock starts at 30 s and doubles to 15 min", () => {
        const { throttle, advance } = setup();
        for (let i = 0; i < FREE_FAILURES; i++) {
            expect(throttle.check("a").ok).toBe(true);
            expect(throttle.fail("a")).toBe(0);
        }
        const locks: number[] = [];
        for (let i = 0; i < 8; i++) {
            const v = throttle.check("a");
            if (v.ok) locks.push(throttle.fail("a"));
            else {
                advance(v.retryAfterSeconds * 1000 + 1);
                locks.push(throttle.fail("a"));
            }
        }
        expect(locks.slice(0, 5)).toEqual([30, 60, 120, 240, 480]);
        expect(Math.max(...locks)).toBe(900);
    });

    test("a locked address is refused with the remaining seconds, even before it tries again", () => {
        const { throttle, advance } = setup();
        for (let i = 0; i <= FREE_FAILURES; i++) throttle.fail("a");
        const v = throttle.check("a");
        expect(v).toEqual({ ok: false, retryAfterSeconds: 30 });
        advance(10_000);
        expect(throttle.check("a")).toEqual({
            ok: false,
            retryAfterSeconds: 20,
        });
        advance(20_001);
        expect(throttle.check("a").ok).toBe(true);
    });

    test("another address is unaffected, and a right password resets the address", () => {
        const { throttle } = setup();
        for (let i = 0; i <= FREE_FAILURES; i++) throttle.fail("a");
        expect(throttle.check("b").ok).toBe(true);
        throttle.succeed("a");
        expect(throttle.check("a").ok).toBe(true);
        expect(throttle.fail("a")).toBe(0); // counting starts over
    });

    test("failures are forgotten after an hour of quiet", () => {
        const { throttle, advance } = setup();
        for (let i = 0; i < FREE_FAILURES; i++) throttle.fail("a");
        advance(61 * 60_000);
        expect(throttle.fail("a")).toBe(0);
    });

    test("global budget: too many wrong passwords across many addresses lock everyone until the minute slides", () => {
        const { throttle, advance } = setup();
        for (let i = 0; i < GLOBAL_PER_MIN; i++) throttle.fail(`addr-${i}`);
        const v = throttle.check("a-fresh-address");
        expect(v.ok).toBe(false);
        advance(61_000);
        expect(throttle.check("a-fresh-address").ok).toBe(true);
    });

    test("memory is bounded however many addresses fail", () => {
        const { throttle, advance } = setup();
        for (let i = 0; i < MAX_TRACKED + 500; i++) {
            throttle.fail(`addr-${i}`);
            if (i % 20 === 0) advance(61_000); // keep the global window out of the way
        }
        expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED);
    });
});
