/**
 * Dashboard authentication: one password, argon2id-hashed in memory; a signed,
 * HttpOnly, SameSite=Lax session cookie whose token is also a row in
 * dashboard_sessions (so logout and revocation are real); a CSRF token on every
 * POST. Nothing here logs or returns the password.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
    SESSION_TTL_MS,
    getSession,
    type DashboardSession,
} from "../db/sessions.js";
import { isHttpsRequest } from "../url.js";

export const SESSION_COOKIE = "fm_session";
export const LOGIN_COOKIE = "fm_login";
const MAX_PASSWORD_INPUT = 200;

const b64 = (buf: Buffer): string => buf.toString("base64url");

function sign(secret: string, purpose: string, value: string): string {
    return b64(
        createHmac("sha256", secret).update(`${purpose}:${value}`).digest(),
    );
}

export function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

/** `value.signature`, or null when the signature is wrong or the shape is off. */
function unsign(
    secret: string,
    purpose: string,
    signed: string | undefined,
): string | null {
    if (!signed || signed.length > 300) return null;
    const dot = signed.lastIndexOf(".");
    if (dot <= 0) return null;
    const value = signed.slice(0, dot);
    return safeEqual(signed.slice(dot + 1), sign(secret, purpose, value))
        ? value
        : null;
}

export const signValue = (
    secret: string,
    purpose: string,
    value: string,
): string => `${value}.${sign(secret, purpose, value)}`;

// ---------- password ----------

/** Holds the argon2id hash of the one password. */
export class PasswordChecker {
    private cached: { plain: string; hash: string } | undefined;

    constructor(private readonly getPassword: () => string) {}

    private async hash(): Promise<string> {
        const plain = this.getPassword();
        if (this.cached?.plain !== plain) {
            this.cached = {
                plain,
                hash: await Bun.password.hash(plain, { algorithm: "argon2id" }),
            };
        }
        return this.cached.hash;
    }

    /** Verifies without ever comparing plaintexts; oversized input just fails. */
    async verify(input: unknown): Promise<boolean> {
        const hash = await this.hash();
        if (typeof input !== "string" || input.length > MAX_PASSWORD_INPUT) {
            // Burn comparable time so length is not an oracle.
            await Bun.password.verify("x", hash);
            return false;
        }
        return Bun.password.verify(input, hash);
    }
}

// ---------- cookies ----------

function cookieBase(c: Context) {
    return {
        path: "/",
        httpOnly: true,
        sameSite: "Lax" as const,
        secure: isHttpsRequest(c),
    };
}

export function setSessionCookie(
    c: Context,
    secret: string,
    token: string,
): void {
    setCookie(c, SESSION_COOKIE, signValue(secret, "session", token), {
        ...cookieBase(c),
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
}

export function clearSessionCookie(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isHttpsRequest(c) });
}

/** The raw token from a valid-signature session cookie, or null. */
export function sessionTokenOf(c: Context, secret: string): string | null {
    return unsign(secret, "session", getCookie(c, SESSION_COOKIE));
}

/** The live session for this request, sliding its expiry (and the cookie). */
export function sessionOf(
    c: Context,
    secret: string,
    now: Date = new Date(),
): { token: string; session: DashboardSession } | null {
    const token = sessionTokenOf(c, secret);
    if (!token) return null;
    const session = getSession(token, now);
    if (!session) return null;
    if (session.renewed) setSessionCookie(c, secret, token);
    return { token, session };
}

// ---------- login CSRF (no session yet) ----------

/** Issues the pre-login CSRF token: a signed cookie plus the matching form value. */
export function issueLoginCsrf(
    c: Context,
    secret: string,
    nonce: string,
): string {
    setCookie(c, LOGIN_COOKIE, signValue(secret, "login", nonce), {
        ...cookieBase(c),
        maxAge: 3600,
    });
    return nonce;
}

/** True when the form value equals the nonce in a validly signed login cookie. */
export function loginCsrfValid(
    c: Context,
    secret: string,
    formValue: unknown,
): boolean {
    const nonce = unsign(secret, "login", getCookie(c, LOGIN_COOKIE));
    return (
        nonce !== null &&
        typeof formValue === "string" &&
        safeEqual(formValue, nonce)
    );
}

export function clearLoginCsrf(c: Context): void {
    deleteCookie(c, LOGIN_COOKIE, { path: "/", secure: isHttpsRequest(c) });
}

/**
 * Browsers say where a request came from. A POST that declares itself
 * cross-site is refused on top of the CSRF token (defence in depth; absent on
 * non-browser clients, which carry no ambient cookies to abuse).
 */
export function sameOriginRequest(c: Context): boolean {
    const site = c.req.header("sec-fetch-site");
    return site === undefined || site === "same-origin" || site === "none";
}
