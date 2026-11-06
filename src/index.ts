import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { handleMcp, closeMcpHandler } from "./mcp.js";
import {
    MCP_PATH_PREFIX,
    accessLog,
    installLogRedaction,
    mcpKeyGuard,
    notFound,
    securityHeaders,
    trustProxy,
    type ServerEnv,
} from "./perimeter.js";
import { getKeys, dataDir, type KeyStore } from "./keys.js";
import {
    EXPORT_DOWNLOAD_PATH,
    readExportArchive,
    startExportCleanup,
    verifyExportLink,
} from "./export-files.js";
import { OWNER_ID, closeDb, exportArchivePath, getDb } from "./db/repo.js";
import { warmWidgets } from "./widgets.js";

const PUBLIC_ICONS: Record<string, string> = {
    "/favicon.ico": "image/x-icon",
    "/favicon.svg": "image/svg+xml",
    "/apple-touch-icon.png": "image/png",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
};

export interface AppOptions {
    /** The MCP path key. A function so tests can change it mid-run. */
    mcpKey: () => string;
    /** HMAC secret for export links. */
    exportSecret: () => string;
    /** DATA_DIR (export archives live under it). */
    dataDir?: string;
}

let shuttingDown = false;

/** Test seam: the shutdown gate's flag (the real flow sets it on SIGTERM). */
export function setShuttingDownForTest(value: boolean): void {
    shuttingDown = value;
}

/**
 * The whole HTTP surface. Everything not listed here is the one generic 404.
 *
 *   POST|GET|DELETE /mcp/:key            MCP (secret path; GET/DELETE answer 405
 *                                        after the key check: no SSE stream)
 *   GET  /exports/download?exp=&sig=     signed, short-lived export download
 *   GET  /health                         liveness
 *   GET  /favicon.ico, /icon-*.png ...   the server icon advertised over MCP
 *   *    /api/v1/health-sync/*           501 until step B
 *
 * No CORS middleware is installed at all: the API is called by Claude's servers
 * and by iOS Shortcuts, never by a page in a browser, so cross-origin access
 * stays closed and an OPTIONS preflight finds no route.
 */
export function createApp(opts: AppOptions): Hono<{ Bindings: ServerEnv }> {
    const app = new Hono<{ Bindings: ServerEnv }>();

    // Outermost: observes the final status; the key is redacted from the path.
    app.use("*", accessLog);
    app.use("*", securityHeaders);

    // Body limit. The MCP endpoint's largest legitimate request is a bulk
    // import batch; 1 MiB is far above any real payload.
    app.use(
        "*",
        bodyLimit({
            maxSize: 1024 * 1024,
            onError: (c) => c.json({ error: "payload_too_large" }, 413),
        }),
    );

    // Shutdown gate: from SIGTERM on, every request is refused before auth or
    // any route, so a restart reads as "come back in a second" rather than as
    // a 500 on a tool call.
    app.use("*", async (c, next) => {
        if (!shuttingDown) return next();
        const path = new URL(c.req.url).pathname;
        if (path.startsWith(MCP_PATH_PREFIX)) {
            return c.json(
                {
                    jsonrpc: "2.0",
                    id: null,
                    error: {
                        code: -32000,
                        message: "Server is shutting down, retry shortly",
                    },
                },
                503,
                { "Retry-After": "1" },
            );
        }
        return c.json({ error: "shutting_down" }, 503, { "Retry-After": "1" });
    });

    // The Apple Health sync API is rebuilt in step B (shortcut_key auth).
    const notAvailableYet = (c: Parameters<typeof notFound>[0]) =>
        c.json({ ok: false, error: "not_available_yet" }, 501, {
            "Cache-Control": "private, no-store",
        });
    app.all("/api/v1/health-sync", notAvailableYet);
    app.all("/api/v1/health-sync/*", notAvailableYet);

    // MCP: the key in the path is the only credential. mcpKeyGuard answers a
    // wrong/missing key with the generic 404 BEFORE the body is touched.
    app.on(["POST", "GET", "DELETE"], "/mcp/:key", mcpKeyGuard(opts.mcpKey), handleMcp);

    // Signed export download. This step checks only signature and expiry; the
    // dashboard step adds the login cookie. Any failure is the generic 404.
    app.get(EXPORT_DOWNLOAD_PATH, (c) => {
        const rel = exportArchivePath(OWNER_ID);
        if (
            !verifyExportLink(
                opts.exportSecret(),
                rel,
                c.req.query("exp"),
                c.req.query("sig"),
            )
        ) {
            return notFound(c);
        }
        const file = readExportArchive(rel, opts.dataDir);
        if (!file) return notFound(c);
        return new Response(file, {
            status: 200,
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": 'attachment; filename="nutrition-mcp-export.zip"',
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    });

    // Server icon (advertised in the MCP serverInfo).
    for (const [path, type] of Object.entries(PUBLIC_ICONS)) {
        app.get(path, async (c) => {
            const file = Bun.file(new URL(`../public${path}`, import.meta.url));
            if (!(await file.exists())) return notFound(c);
            return c.body(await file.arrayBuffer(), 200, {
                "Content-Type": type,
                "Cache-Control": "public, max-age=86400",
            });
        });
    }

    // Liveness for the supervisor. Gated by the shutdown gate on purpose.
    app.get("/health", (c) => c.text("ok"));

    // "/" is the dashboard login in step C. Until then, the generic 404.
    app.notFound((c) => notFound(c));

    // Never echo error text: it can embed request URLs (the key).
    app.onError((err, c) => {
        console.error("Unhandled error:", err.message);
        return c.json({ error: "internal_server_error" }, 500);
    });

    return app;
}

function startupKeyLine(keys: KeyStore): string {
    if (keys.mcpKeyFromEnv)
        return "[keys] MCP access key taken from the MCP_KEY environment variable";
    if (keys.mcpKeyGenerated)
        return `[keys] generated a new MCP access key and saved it to ${keys.file} (field "mcp_key"); the connector URL is /mcp/<that key>`;
    return `[keys] MCP access key loaded from ${keys.file} (field "mcp_key"); the connector URL is /mcp/<that key>`;
}

/**
 * Boot: keys, database, widgets, sweeps, signal handlers. Returns the app so
 * the caller can serve it. Only runs when this file is the entrypoint.
 */
async function boot(): Promise<Hono<{ Bindings: ServerEnv }>> {
    const keys = getKeys();
    installLogRedaction(() => [keys.mcpKey, keys.exportSecret]);
    console.log(startupKeyLine(keys));
    if (trustProxy()) console.log("[net] TRUST_PROXY=1: using the rightmost X-Forwarded-For entry");

    getDb(); // open + migrate now, so a broken database stops the boot
    await warmWidgets();
    startExportCleanup(dataDir());

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    return createApp({
        mcpKey: () => keys.mcpKey,
        exportSecret: () => keys.exportSecret,
        dataDir: dataDir(),
    });
}

// Exit cleanly on shutdown signals. Setting `shuttingDown` is the load-bearing
// step: it arms the 503 gate, which stops new work. closeMcpHandler aborts only
// 2026-era exchanges the SDK tracks; the bound exists so one wedged exchange
// cannot hold the process past the supervisor's grace period. The database is
// closed last (that checkpoints the WAL).
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    void Promise.race([closeMcpHandler(), new Promise((r) => setTimeout(r, 2000))])
        .catch((err) => console.error("Error closing MCP handler:", (err as Error).message))
        .finally(() => {
            try {
                closeDb();
            } catch (err) {
                console.error("Error closing database:", (err as Error).message);
            }
            process.exit(0);
        });
}

const port = parseInt(process.env.PORT || "8080");
const hostname = process.env.HOST || "0.0.0.0";

// Boot side effects run only when this file IS the entrypoint, so a test can
// import createApp without opening the production database or starting timers.
const app = import.meta.main ? await boot() : null;
if (import.meta.main) {
    console.log(`Nutrition MCP server listening on ${hostname}:${port}`);
}

export default {
    port,
    hostname,
    // Long-lived requests can idle between events; Bun's 10 s default closes
    // them. Raise it so a slow tool call is not severed.
    idleTimeout: 120,
    fetch(req: Request, server: { requestIP(r: Request): { address: string } | null }) {
        if (!app) return new Response("not started", { status: 503 });
        return app.fetch(req, { ip: server.requestIP(req)?.address });
    },
};
