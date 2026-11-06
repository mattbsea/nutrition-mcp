// Derive the public base URL of the server from the request, honoring the
// reverse-proxy forwarding headers used in production. The single
// implementation for every caller: the HTTP entry point and the /mcp server
// factory, which advertises the server icon URL. That factory only ever sees a
// raw `Request` — never a Hono context — which is why this accepts both.
import { trustProxy } from "./net.js";

type HonoLikeContext = {
    req: { header: (name: string) => string | undefined; url: string };
};

// Reads headers and the URL off either shape. Hono's `header` reads `this`,
// so it is called through the context rather than detached.
function requestLike(source: HonoLikeContext | Request): {
    header: (name: string) => string | undefined;
    url: string;
} {
    return source instanceof Request
        ? {
              header: (name: string) => source.headers.get(name) ?? undefined,
              url: source.url,
          }
        : {
              header: (name: string) => source.req.header(name),
              url: source.req.url,
          };
}

// A forwarded Host is a bare host[:port] or [v6]:port and nothing else; anything
// richer (a path, "@", spaces, a second host) is dropped rather than echoed.
const SAFE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** PUBLIC_URL reduced to its origin, or undefined when unset/invalid. */
function configuredOrigin(): string | undefined {
    const raw = process.env.PUBLIC_URL?.trim();
    if (!raw) return undefined;
    try {
        const u = new URL(raw);
        return u.protocol === "https:" || u.protocol === "http:"
            ? u.origin
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The server's public origin, in order of trust:
 *   1. PUBLIC_URL, when the operator set it;
 *   2. X-Forwarded-Proto/-Host, ONLY when TRUST_PROXY=1 (a proxy we run set
 *      them; otherwise any client could aim the advertised icon URLs, and so
 *      what a connector fetches, at a host of their choosing);
 *   3. the request's own URL.
 */
export function getBaseUrl(source: HonoLikeContext | Request): string {
    const configured = configuredOrigin();
    if (configured) return configured;
    const req = requestLike(source);
    if (trustProxy()) {
        const proto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
        const host = req.header("x-forwarded-host")?.split(",")[0]?.trim();
        if (host && SAFE_HOST.test(host)) {
            return `${proto === "https" ? "https" : "http"}://${host}`;
        }
    }
    return new URL(req.url).origin;
}

// Whether the client reached us over https: the proxy's x-forwarded-proto,
// but only when TRUST_PROXY=1; otherwise the request URL's own scheme. Decides
// the HSTS header, which must never reach a plain-http localhost (it would pin
// the dev machine's browser to https).
export function isHttpsRequest(source: HonoLikeContext | Request): boolean {
    const req = requestLike(source);
    if (trustProxy()) {
        const proto = req.header("x-forwarded-proto");
        if (proto) return proto.split(",")[0]!.trim() === "https";
    }
    return new URL(req.url).protocol === "https:";
}
