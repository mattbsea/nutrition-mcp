/**
 * Dashboard routes. Everything except /login and the two static assets needs a
 * valid session; an unauthenticated request is redirected to /login (GET) or
 * refused (POST), never served data.
 */
import { randomBytes } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getClientIp, type ServerEnv } from "../perimeter.js";
import {
    createSession,
    revokeAllSessions,
    revokeSession,
    sweepSessions,
} from "../db/sessions.js";
import { maskIp } from "../net.js";
import {
    PasswordChecker,
    clearLoginCsrf,
    clearSessionCookie,
    issueLoginCsrf,
    loginCsrfValid,
    safeEqual,
    sameOriginRequest,
    sessionOf,
    sessionTokenOf,
    setSessionCookie,
} from "./auth.js";
import { ASSETS } from "./assets.js";
import { html } from "./html.js";
import { pageResponse, type NavKey, type Page } from "./layout.js";
import { loginBody } from "./login-view.js";
import { LoginThrottle } from "./throttle.js";

export interface DashboardOptions {
    /** The plaintext password in force (hashed in memory). */
    password: () => string;
    sessionSecret: () => string;
    mcpKey: () => string;
    shortcutKey: () => string;
    dataDir?: string;
    /** Test seams. */
    now?: () => Date;
    throttle?: LoginThrottle;
}

export interface DashEnv {
    Bindings: ServerEnv;
    Variables: { csrf: string };
}

export type SignedInPage = (
    c: Context<DashEnv>,
    csrf: string,
) => Promise<Page> | Page;

/** Every path that needs a session. */
export const PROTECTED_PATHS = [
    "/",
    "/trends",
    "/meals",
    "/meals/*",
    "/apple-health",
    "/settings",
    "/settings/*",
    "/logout",
    "/logout-all",
] as const;

export function createDashboardRouter(opts: DashboardOptions) {
    const router = new Hono<DashEnv>();
    const now = () => (opts.now ? opts.now() : new Date());
    const throttle = opts.throttle ?? new LoginThrottle();
    const checker = new PasswordChecker(opts.password);

    // ---------- static assets (public, no data) ----------
    for (const [path, asset] of Object.entries(ASSETS)) {
        router.get(path, (c) => {
            if (c.req.header("if-none-match") === asset.etag)
                return c.body(null, 304, { ETag: asset.etag });
            return c.body(asset.body, 200, {
                "Content-Type": asset.type,
                "Cache-Control": "public, max-age=3600",
                ETag: asset.etag,
            });
        });
    }

    // ---------- login ----------
    const loginPage = (
        c: Context<DashEnv>,
        extra: {
            error?: string;
            status?: number;
            headers?: Record<string, string>;
        } = {},
    ) => {
        const nonce = issueLoginCsrf(
            c,
            opts.sessionSecret(),
            randomBytes(24).toString("base64url"),
        );
        return pageResponse(c, {
            title: "Sign in",
            body: loginBody({ csrf: nonce, error: extra.error }),
            status: extra.status,
            headers: extra.headers,
        });
    };

    router.get("/login", (c) => {
        if (sessionOf(c, opts.sessionSecret(), now()))
            return c.redirect("/", 303);
        return loginPage(c);
    });

    router.post("/login", async (c) => {
        const ip = getClientIp(c);
        if (!sameOriginRequest(c)) return c.text("Forbidden", 403);
        let form: Record<string, unknown>;
        try {
            form = await c.req.parseBody();
        } catch {
            return c.text("Bad request", 400);
        }
        if (!loginCsrfValid(c, opts.sessionSecret(), form.csrf)) {
            return loginPage(c, {
                error: "The form expired. Please try again.",
                status: 403,
            });
        }
        const verdict = throttle.check(ip);
        if (!verdict.ok) {
            console.log(`[dashboard] login throttled ip=${maskIp(ip)}`);
            return loginPage(c, {
                error: `Too many attempts. Try again in ${verdict.retryAfterSeconds} seconds.`,
                status: 429,
                headers: { "Retry-After": String(verdict.retryAfterSeconds) },
            });
        }
        if (!(await checker.verify(form.password))) {
            const lock = throttle.fail(ip);
            console.log(
                `[dashboard] login failed ip=${maskIp(ip)}${lock ? ` locked=${lock}s` : ""}`,
            );
            return loginPage(c, { error: "Incorrect password.", status: 401 });
        }
        throttle.succeed(ip);
        sweepSessions(now());
        // A new session on every login (never reuse one: no fixation).
        const { token } = createSession(now());
        clearLoginCsrf(c);
        setSessionCookie(c, opts.sessionSecret(), token);
        console.log(`[dashboard] login ok ip=${maskIp(ip)}`);
        return c.redirect("/", 303);
    });

    // ---------- everything below needs a session ----------
    const guard: MiddlewareHandler<DashEnv> = async (c, next) => {
        const found = sessionOf(c, opts.sessionSecret(), now());
        if (!found) {
            // An unreadable/forged/expired cookie is dropped, not left around.
            if (c.req.header("cookie")?.includes("fm_session"))
                clearSessionCookie(c);
            return c.redirect("/login", 303);
        }
        c.set("csrf", found.session.csrf);
        // Every POST under a session: same-origin hint + CSRF token.
        if (c.req.method === "POST") {
            if (!sameOriginRequest(c)) return c.text("Forbidden", 403);
            let form: Record<string, unknown>;
            try {
                form = await c.req.parseBody();
            } catch {
                return c.text("Bad request", 400);
            }
            if (
                typeof form.csrf !== "string" ||
                !safeEqual(form.csrf, found.session.csrf)
            ) {
                return c.text(
                    "Forbidden: invalid or missing form token. Reload the page and try again.",
                    403,
                );
            }
        }
        await next();
    };
    // Scoped to the dashboard's own paths, NOT "*": the app mounts this router
    // among others (MCP, health sync, icons), and an unknown path must stay the
    // generic 404 rather than a redirect to the login page.
    for (const path of PROTECTED_PATHS) router.use(path, guard);

    router.post("/logout", (c) => {
        const token = sessionTokenOf(c, opts.sessionSecret());
        if (token) revokeSession(token);
        clearSessionCookie(c);
        return c.redirect("/login", 303);
    });

    router.post("/logout-all", (c) => {
        revokeAllSessions();
        clearSessionCookie(c);
        return c.redirect("/login", 303);
    });

    /** Registers a signed-in GET page. */
    const getPage = (
        path: string,
        active: NavKey,
        build: (
            c: Context<DashEnv>,
        ) =>
            | Promise<{ title: string; body: ReturnType<typeof html> }>
            | { title: string; body: ReturnType<typeof html> },
    ) => {
        router.get(path, async (c) => {
            const built = await build(c);
            return pageResponse(c, {
                ...built,
                signedIn: { csrf: c.get("csrf"), active },
            });
        });
    };

    getPage("/", "today", () => ({
        title: "Today",
        body: html`<h1>Today</h1>
            <p class="sub">Signed in.</p>`,
    }));

    return { router, throttle, getPage };
}
