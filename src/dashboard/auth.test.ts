import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createApp } from "../index.js";
import { useMemoryDb } from "../db/test-helpers.js";
import { countSessions } from "../db/sessions.js";
import { LoginThrottle } from "./throttle.js";
import { PROTECTED_PATHS } from "./routes.js";
import { _resetBuckets } from "../rate-limit.js";

const PASSWORD = "correct horse battery staple";
const MCP = "m-".padEnd(48, "Q7w");
const SC = "s-".padEnd(48, "Z3x");
const SECRET = "session-secret-".padEnd(48, "S");
const IP = "198.51.100.20";

useMemoryDb();

let clock = new Date("2026-03-10T10:00:00Z");
let throttle: LoginThrottle;
let app: ReturnType<typeof createApp>;
const trust = process.env.TRUST_PROXY;

beforeEach(() => {
    _resetBuckets();
    delete process.env.TRUST_PROXY;
    clock = new Date("2026-03-10T10:00:00Z");
    throttle = new LoginThrottle(() => clock.getTime());
    app = makeApp();
});
afterEach(() => {
    if (trust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trust;
});

function makeApp(secret = SECRET) {
    return createApp({
        mcpKey: () => MCP,
        shortcutKey: () => SC,
        exportSecret: () => "export-secret-".padEnd(48, "E"),
        dashboard: {
            password: () => PASSWORD,
            sessionSecret: () => secret,
            now: () => clock,
            throttle,
        },
    });
}

const call = (path: string, init: RequestInit = {}, ip = IP) =>
    app.request(`http://x${path}`, init, { ip });

/** name=value pairs of every Set-Cookie on a response. */
function cookiesOf(r: Response): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of r.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const i = pair!.indexOf("=");
        out[pair!.slice(0, i)] = pair!.slice(i + 1);
    }
    return out;
}
const jar = (c: Record<string, string>) =>
    Object.entries(c)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
const csrfIn = (body: string): string =>
    /name="csrf" value="([^"]+)"/.exec(body)![1]!;

async function loginForm(ip = IP) {
    const r = await call("/login", {}, ip);
    const body = await r.text();
    return { cookies: cookiesOf(r), csrf: csrfIn(body), response: r, body };
}

async function login(
    password = PASSWORD,
    ip = IP,
    headers: Record<string, string> = {},
) {
    const form = await loginForm(ip);
    const r = await call(
        "/login",
        {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: jar(form.cookies),
                ...headers,
            },
            body: new URLSearchParams({ password, csrf: form.csrf }).toString(),
        },
        ip,
    );
    return { r, cookies: cookiesOf(r), form };
}

async function session() {
    const { r, cookies } = await login();
    expect(r.status).toBe(303);
    const cookie = jar({ fm_session: cookies.fm_session! });
    const page = await call("/", { headers: { cookie } });
    return { cookie, csrf: csrfIn(await page.text()) };
}

describe("unauthenticated access", () => {
    test("every dashboard path redirects a GET to /login and serves no data", async () => {
        const paths = PROTECTED_PATHS.map((p) =>
            p.replace("/*", "/00000000-0000-4000-8000-000000000000"),
        );
        for (const p of paths) {
            const r = await call(p);
            expect([p, r.status, r.headers.get("location")]).toEqual([
                p,
                303,
                "/login",
            ]);
            expect(await r.text()).toBe("");
        }
    });

    test("POST to every protected path is refused without a session", async () => {
        for (const p of ["/logout", "/logout-all", "/settings/reveal"]) {
            const r = await call(p, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: "csrf=x",
            });
            expect([p, r.status]).toEqual([p, 303]);
        }
        expect(countSessions()).toBe(0);
    });

    test("a made-up path is still the generic 404, and the other surfaces are untouched", async () => {
        expect((await call("/nope")).status).toBe(404);
        expect((await call("/health")).status).toBe(200);
        expect((await call("/mcp/wrong-key")).status).toBe(404);
    });

    test("without dashboard options nothing of it is mounted", async () => {
        const bare = createApp({
            mcpKey: () => MCP,
            shortcutKey: () => SC,
            exportSecret: () => "x".repeat(40),
        });
        for (const p of ["/", "/login", "/assets/dashboard.css"])
            expect(
                (await bare.request(`http://x${p}`, {}, { ip: IP })).status,
            ).toBe(404);
    });
});

describe("login page", () => {
    test("is served with a strict CSP, no caching, a CSRF field and a signed HttpOnly cookie", async () => {
        const { response, body, cookies } = await loginForm();
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toContain(
            "script-src 'self'",
        );
        expect(response.headers.get("content-security-policy")).not.toContain(
            "unsafe-inline",
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(body).toContain('type="password"');
        expect(cookies.fm_login).toBeTruthy();
        const raw = response.headers
            .getSetCookie()
            .find((c) => c.startsWith("fm_login"))!;
        expect(raw).toMatch(/HttpOnly/i);
        expect(raw).toMatch(/SameSite=Lax/i);
        expect(raw).not.toMatch(/Secure/i); // plain http here
    });

    test("cookies are Secure when the proxy says https (and is trusted)", async () => {
        process.env.TRUST_PROXY = "1";
        const r = await call("/login", {
            headers: { "x-forwarded-proto": "https" },
        });
        for (const c of r.headers.getSetCookie()) expect(c).toMatch(/Secure/i);
        const plain = await call("/login");
        for (const c of plain.headers.getSetCookie())
            expect(c).not.toMatch(/Secure/i);
    });

    test("a forged X-Forwarded-Proto without TRUST_PROXY does not make cookies Secure", async () => {
        const r = await call("/login", {
            headers: { "x-forwarded-proto": "https" },
        });
        for (const c of r.headers.getSetCookie())
            expect(c).not.toMatch(/Secure/i);
    });
});

describe("login", () => {
    test("a wrong password is 401, sets no session and counts as a failure", async () => {
        const { r, cookies } = await login("not the password");
        expect(r.status).toBe(401);
        expect(cookies.fm_session).toBeUndefined();
        expect(countSessions()).toBe(0);
        expect(await r.text()).toContain("Incorrect password.");
    });

    test("the right password gives a 30-day HttpOnly SameSite=Lax session and opens the dashboard", async () => {
        const { r, cookies } = await login();
        expect(r.status).toBe(303);
        expect(r.headers.get("location")).toBe("/");
        const line = r.headers
            .getSetCookie()
            .find((c) => c.startsWith("fm_session="))!;
        expect(line).toMatch(/HttpOnly/i);
        expect(line).toMatch(/SameSite=Lax/i);
        expect(line).toMatch(/Max-Age=2592000/);
        expect(line).toMatch(/Path=\//);
        const page = await call("/", {
            headers: { cookie: jar({ fm_session: cookies.fm_session! }) },
        });
        expect(page.status).toBe(200);
        expect(countSessions()).toBe(1);
    });

    test("each login mints a new session (no fixation)", async () => {
        const a = await login();
        const b = await login();
        expect(a.cookies.fm_session).not.toBe(b.cookies.fm_session);
        expect(countSessions()).toBe(2);
    });

    test("a visitor who is already signed in is sent on from /login", async () => {
        const { cookie } = await session();
        const r = await call("/login", { headers: { cookie } });
        expect([r.status, r.headers.get("location")]).toEqual([303, "/"]);
    });

    test("the password is never logged, on success or failure", async () => {
        const lines: string[] = [];
        const spies = (["log", "warn", "error", "info"] as const).map((m) =>
            spyOn(console, m).mockImplementation(
                (...a: unknown[]) => void lines.push(a.map(String).join(" ")),
            ),
        );
        try {
            await login("wrong-password-12345");
            await login();
        } finally {
            spies.forEach((s) => s.mockRestore());
        }
        const text = lines.join("\n");
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain("wrong-password-12345");
        expect(text).toContain("[dashboard] login failed");
        expect(text).toContain("[dashboard] login ok");
    });
});

describe("CSRF", () => {
    test("login without the form token, with a wrong one, or with a cookie from another secret is refused", async () => {
        const form = await loginForm();
        const post = (
            body: Record<string, string>,
            cookie = jar(form.cookies),
            extra: Record<string, string> = {},
        ) =>
            call("/login", {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    cookie,
                    ...extra,
                },
                body: new URLSearchParams(body).toString(),
            });
        expect((await post({ password: PASSWORD })).status).toBe(403);
        expect((await post({ password: PASSWORD, csrf: "wrong" })).status).toBe(
            403,
        );
        expect(
            (await post({ password: PASSWORD, csrf: form.csrf }, "")).status,
        ).toBe(403);
        // A login cookie signed with some other secret.
        const other = makeApp("a-completely-different-secret-".padEnd(48, "D"));
        const foreign = await other.request("http://x/login", {}, { ip: IP });
        const fCookies = cookiesOf(foreign);
        const fCsrf = csrfIn(await foreign.text());
        expect(
            (await post({ password: PASSWORD, csrf: fCsrf }, jar(fCookies)))
                .status,
        ).toBe(403);
        // Declared cross-site by the browser.
        expect(
            (
                await post(
                    { password: PASSWORD, csrf: form.csrf },
                    jar(form.cookies),
                    { "sec-fetch-site": "cross-site" },
                )
            ).status,
        ).toBe(403);
        expect(countSessions()).toBe(0);
        // The legitimate one still works.
        expect(
            (await post({ password: PASSWORD, csrf: form.csrf })).status,
        ).toBe(303);
    });

    test("logout needs the session's token; with it the session is revoked server-side", async () => {
        const { cookie, csrf } = await session();
        const post = (body: string, extra: Record<string, string> = {}) =>
            call("/logout", {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    cookie,
                    ...extra,
                },
                body,
            });
        expect((await post("")).status).toBe(403);
        expect((await post("csrf=nope")).status).toBe(403);
        expect(
            (await post(`csrf=${csrf}`, { "sec-fetch-site": "cross-site" }))
                .status,
        ).toBe(403);
        expect(countSessions()).toBe(1);
        const out = await post(`csrf=${csrf}`);
        expect([out.status, out.headers.get("location")]).toEqual([
            303,
            "/login",
        ]);
        expect(countSessions()).toBe(0);
        // The old cookie is dead even though the browser still holds it.
        expect((await call("/", { headers: { cookie } })).status).toBe(303);
    });

    test("logout-all revokes every session", async () => {
        const a = await session();
        await session();
        expect(countSessions()).toBe(2);
        const r = await call("/logout-all", {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: a.cookie,
            },
            body: `csrf=${a.csrf}`,
        });
        expect(r.status).toBe(303);
        expect(countSessions()).toBe(0);
    });
});

describe("session cookie", () => {
    test("a tampered, truncated or foreign-signed cookie is not a session", async () => {
        const { cookie } = await session();
        const value = cookie.split("=")[1]!;
        const bad = [
            `${value.slice(0, -2)}xx`,
            value.slice(0, 20),
            value.split(".")[0]!, // token without signature
            `${value.split(".")[0]}.${"A".repeat(43)}`,
            "",
        ];
        for (const v of bad) {
            const r = await call("/", {
                headers: { cookie: `fm_session=${v}` },
            });
            expect([v, r.status]).toEqual([v, 303]);
        }
        // Signed by a different secret.
        const other = makeApp("a-completely-different-secret-".padEnd(48, "D"));
        expect(
            (
                await other.request(
                    "http://x/",
                    { headers: { cookie } },
                    { ip: IP },
                )
            ).status,
        ).toBe(303);
    });

    test("it expires after 30 days idle and is deleted server-side", async () => {
        const { cookie } = await session();
        clock = new Date(clock.getTime() + 30 * 86_400_000 + 1000);
        expect((await call("/", { headers: { cookie } })).status).toBe(303);
        expect(countSessions()).toBe(0);
    });

    test("use slides the expiry: active at day 29, still valid at day 58", async () => {
        const { cookie } = await session();
        clock = new Date(clock.getTime() + 29 * 86_400_000);
        const r = await call("/", { headers: { cookie } });
        expect(r.status).toBe(200);
        expect(
            r.headers.getSetCookie().some((c) => c.startsWith("fm_session=")),
        ).toBe(true); // re-issued
        clock = new Date(clock.getTime() + 29 * 86_400_000);
        expect((await call("/", { headers: { cookie } })).status).toBe(200);
    });
});

describe("login rate limit", () => {
    test("five wrong passwords lock the address, a correct one is then refused too, with Retry-After", async () => {
        for (let i = 0; i < 5; i++)
            expect((await login("nope-nope-nope")).r.status).toBe(401);
        const locked = await login();
        expect(locked.r.status).toBe(429);
        expect(Number(locked.r.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(countSessions()).toBe(0);
        // After the lock passes, the right password works again.
        clock = new Date(clock.getTime() + 31_000);
        expect((await login()).r.status).toBe(303);
    });

    test("another address is not locked out by the first one's failures", async () => {
        for (let i = 0; i < 6; i++) await login("nope-nope-nope");
        expect((await login(PASSWORD, "203.0.113.9")).r.status).toBe(303);
    });
});
