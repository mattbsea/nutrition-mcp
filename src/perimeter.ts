/**
 * The HTTP perimeter: client identification, the secret-path MCP key guard,
 * the failure rate limit, secure headers and log redaction.
 *
 * The MCP endpoint is `/mcp/<key>`. There is no token flow and no other credential
 * on it: the 48-byte random key in the URL path is the whole authentication,
 * the pattern used for the Home Assistant and Portainer MCP servers. So the
 * rules here are strict:
 *
 *  - a missing or wrong key gets the SAME generic 404 an unknown route gets
 *    (byte-identical body and headers), decided before any request body is read;
 *  - the comparison is constant time (length first, then timingSafeEqual);
 *  - failures count against the client IP; after BAN_STRIKE_THRESHOLD
 *    consecutive failures the IP gets 429 with an escalating Retry-After
 *    (src/rate-limit.ts), and a success clears the run;
 *  - the key never reaches a log line or a response: access logs print
 *    `/mcp/[redacted]`, and installLogRedaction scrubs every console line as a
 *    backstop;
 *  - X-Forwarded-For is trusted only when TRUST_PROXY=1.
 */
import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import {
    clearAuthFailures,
    getBanState,
    noteAuthFailure,
} from "./rate-limit.js";
import { isHttpsRequest } from "./url.js";
import { maskIp } from "./net.js";

/** What src/index.ts passes as the Hono `env`: the socket peer address. */
export interface ServerEnv {
    ip?: string;
}

export const REDACTED = "[redacted]";
export const MCP_PATH_PREFIX = "/mcp/";

declare module "hono" {
    interface ContextVariableMap {
        suppressAccessLog: boolean;
    }
}

// ---------- client identity ----------

/** Whether X-Forwarded-For may be believed (a reverse proxy we run sits in
 *  front). Read per call so tests can flip it. */
export function trustProxy(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return env.TRUST_PROXY === "1";
}

/**
 * The client address used to key failure counting. With TRUST_PROXY=1 it is
 * the RIGHTMOST X-Forwarded-For entry: the one our own proxy appended (the
 * address it saw), since everything to its left is supplied by the client and
 * freely forgeable. Otherwise it is the socket peer, and the header is
 * ignored entirely. "unknown" only when neither is available.
 */
export function getClientIp(c: Context): string {
    if (trustProxy()) {
        const forwarded = c.req.header("x-forwarded-for");
        if (forwarded) {
            const parts = forwarded
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);
            const last = parts[parts.length - 1];
            if (last) return last;
        }
    }
    return (c.env as ServerEnv | undefined)?.ip || "unknown";
}

/** Count one failed authentication against the client IP and log a ban once. */
export function recordAuthFailure(c: Context): void {
    const ban = noteAuthFailure(getClientIp(c));
    // Reaching here means the ban guard let the request through, so a banned
    // result is necessarily a newly tripped ban: log the transition once.
    if (ban.banned) {
        console.log(
            `[ban] ${maskIp(getClientIp(c))} repeated auth failures on ${redactPath(c.req.path)}: shedding for ${ban.retryAfterSeconds}s`,
        );
    }
}

// ---------- redaction ----------

/** `/mcp/<anything>` becomes `/mcp/[redacted]`; other paths are unchanged. */
export function redactPath(path: string): string {
    return path.startsWith(MCP_PATH_PREFIX)
        ? `${MCP_PATH_PREFIX}${REDACTED}`
        : path;
}

/** Scrubs a string: every known secret and any `/mcp/<segment>` path. */
export function redactText(text: string, secrets: readonly string[]): string {
    let out = text.replace(
        /\/mcp\/[^\s"'?#\\/]+/g,
        `${MCP_PATH_PREFIX}${REDACTED}`,
    );
    for (const secret of secrets) {
        if (secret.length >= 8) out = out.split(secret).join(REDACTED);
    }
    return out;
}

/**
 * Wraps console.log/info/warn/error/debug so that no line can carry a secret,
 * whatever code path produced it (an SDK error that embeds a URL, a thrown
 * message that quotes a request). `secrets` is read at call time. Returns an
 * uninstall function.
 */
export function installLogRedaction(
    secrets: () => readonly string[],
): () => void {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    const scrub = (arg: unknown): unknown => {
        if (typeof arg === "string") return redactText(arg, secrets());
        if (arg instanceof Error) {
            const copy = new Error(redactText(arg.message, secrets()));
            copy.name = arg.name;
            if (arg.stack) copy.stack = redactText(arg.stack, secrets());
            return copy;
        }
        return arg;
    };
    methods.forEach((m, i) => {
        const original = originals[i]!;
        console[m] = (...args: unknown[]) =>
            original.apply(console, args.map(scrub));
    });
    return () => {
        methods.forEach((m, i) => {
            console[m] = originals[i]!;
        });
    };
}

// ---------- the key guard ----------

/** The one generic not-found body: also what an unknown route answers. */
export const NOT_FOUND_BODY = { error: "not_found" } as const;

export function notFound(c: Context): Response {
    return c.json(NOT_FOUND_BODY, 404);
}

/** Constant-time equality of the presented key and the configured one. */
export function keysMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * Guards `/mcp/:key`. Order matters: the ban check and the key check both run
 * before anything reads the request body.
 */
export function mcpKeyGuard(getKey: () => string): MiddlewareHandler {
    return async (c, next) => {
        const ip = getClientIp(c);
        const ban = getBanState(ip);
        if (ban.banned) {
            // A shed client would otherwise dominate the access log.
            c.set("suppressAccessLog", true);
            c.header("Retry-After", String(ban.retryAfterSeconds ?? 60));
            return c.json({ error: "rate_limited" }, 429);
        }
        const presented = c.req.param("key") ?? "";
        if (!presented || !keysMatch(presented, getKey())) {
            recordAuthFailure(c);
            return notFound(c);
        }
        clearAuthFailures(ip);
        await next();
    };
}

// ---------- headers, logging ----------

/** Security headers on every response. The CSP is the strictest that works for
 *  JSON and downloads; the dashboard step relaxes it for its own pages by
 *  setting its own header, which this does not overwrite. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.get("Content-Security-Policy")) {
        c.header(
            "Content-Security-Policy",
            "default-src 'none'; frame-ancestors 'none'",
        );
    }
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    if (!c.res.headers.get("Cache-Control"))
        c.header("Cache-Control", "no-store");
    // HSTS only over https: a browser ignores it elsewhere, and pinning a
    // plain-http localhost would be a nuisance.
    if (isHttpsRequest(c)) {
        c.header(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains",
        );
    }
};

/** One line per request, key redacted, client address coarsened. */
export const accessLog: MiddlewareHandler = async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/health") return next();
    const start = performance.now();
    await next();
    if (c.get("suppressAccessLog")) return;
    const ms = Math.round(performance.now() - start);
    console.log(
        `[req] ${c.req.method} ${redactPath(path)} ${c.res.status} ${ms}ms ip=${maskIp(getClientIp(c))}`,
    );
};
