/** Page chrome shared by every dashboard page, and the page response helper. */
import type { Context } from "hono";
import { esc, html, raw, type Raw } from "./html.js";

/** Strict: our own origin only, no inline script, no inline style, no framing,
 *  forms may post only back to us. */
export const DASHBOARD_CSP = [
    "default-src 'none'",
    "style-src 'self'",
    "script-src 'self'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "font-src 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
].join("; ");

export type NavKey = "today" | "trends" | "meals" | "health" | "settings";

const NAV: { key: NavKey; href: string; label: string }[] = [
    { key: "today", href: "/", label: "Today" },
    { key: "trends", href: "/trends", label: "Trends" },
    { key: "meals", href: "/meals", label: "Meals" },
    { key: "health", href: "/apple-health", label: "Health" },
    { key: "settings", href: "/settings", label: "Settings" },
];

export interface Page {
    title: string;
    body: Raw;
    /** Signed-in pages show the nav and the sign-out form. */
    signedIn?: { csrf: string; active: NavKey };
    status?: number;
    headers?: Record<string, string>;
}

export function renderPage(page: Page): Raw {
    const nav = page.signedIn
        ? html`<nav class="main" aria-label="Sections">
              ${NAV.map(
                  (n) =>
                      html`<a
                          href="${n.href}"
                          ${
                              n.key === page.signedIn!.active
                                  ? raw('aria-current="page"')
                                  : ""
                          }
                          >${n.label}</a
                      >`,
              )}
          </nav>`
        : "";
    const logout = page.signedIn
        ? html`<form method="post" action="/logout" class="inline">
              <input type="hidden" name="csrf" value="${page.signedIn.csrf}" />
              <button type="submit">Sign out</button>
          </form>`
        : "";
    return html`<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1"
                />
                <meta name="color-scheme" content="light dark" />
                <meta name="robots" content="noindex, nofollow" />
                <title>${page.title} · Food tracker</title>
                <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
                <link rel="stylesheet" href="/assets/dashboard.css" />
                <script src="/assets/dashboard.js" defer></script>
            </head>
            <body>
                <a class="skip" href="#content">Skip to content</a>
                <header class="top">
                    <div class="bar">
                        <span class="brand">Food tracker</span>${logout}
                    </div>
                    ${nav}
                </header>
                <main id="content">${page.body}</main>
            </body>
        </html>`;
}

/** The HTML response: strict CSP, never cached. */
export function pageResponse(c: Context, page: Page): Response {
    return c.html(renderPage(page).value, (page.status ?? 200) as 200, {
        "Content-Security-Policy": DASHBOARD_CSP,
        "Cache-Control": "no-store",
        ...page.headers,
    });
}

export { esc };
