/**
 * Export archives on disk and their signed, short-lived download links.
 *
 * The ZIP lives at DATA_DIR/exports/<exportArchivePath(owner)>. A link is
 * `/exports/download?exp=<unix seconds>&sig=<hmac>`: the HMAC (SHA-256, keyed
 * with the persisted export_secret) covers the expiry and the file path, so a
 * link can be neither extended nor pointed at another file. A download is
 * allowed with either a valid signature or the dashboard login cookie (see
 * src/index.ts); a request with neither gets nothing.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { OWNER_ID } from "./db/owner.js";
import { dataDir } from "./keys.js";

/** Signed link lifetime. The cleanup sweep ages files out on the same horizon. */
export const EXPORT_TTL_SECONDS = 60 * 60;
export const EXPORT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const EXPORT_DOWNLOAD_PATH = "/exports/download";
/** The only file name /exports/:name will ever serve (the archive's own). */
export const EXPORT_FILE_NAME = "nutrition-mcp-export.zip";

export function exportsDir(dir: string = dataDir()): string {
    return resolve(join(dir, "exports"));
}

/** Absolute file for a relative archive path, refusing anything that would
 *  escape the exports directory. */
function archiveFile(relPath: string, dir: string): string {
    const base = exportsDir(dir);
    const full = resolve(base, relPath);
    if (!full.startsWith(base + sep)) throw new Error("Invalid export path");
    return full;
}

export function writeExportArchive(
    relPath: string,
    archive: Uint8Array,
    dir: string = dataDir(),
): string {
    const file = archiveFile(relPath, dir);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, archive, { mode: 0o600 });
    return file;
}

function sign(secret: string, relPath: string, exp: number): string {
    return createHmac("sha256", secret)
        .update(`export\n${relPath}\n${exp}`)
        .digest("base64url");
}

/** Path-and-query of a signed download link for `relPath`. */
export function signExportLink(
    secret: string,
    relPath: string,
    now: Date = new Date(),
    ttlSeconds: number = EXPORT_TTL_SECONDS,
): { path: string; expiresAt: Date } {
    const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
    const sig = sign(secret, relPath, exp);
    return {
        path: `${EXPORT_DOWNLOAD_PATH}?exp=${exp}&sig=${sig}`,
        expiresAt: new Date(exp * 1000),
    };
}

/** Whether `sig`/`exp` are a live, genuine signature for `relPath`. Constant
 *  time on the signature. */
export function verifyExportLink(
    secret: string,
    relPath: string,
    expRaw: string | undefined,
    sig: string | undefined,
    now: Date = new Date(),
): boolean {
    if (!expRaw || !sig || !/^\d{1,12}$/.test(expRaw)) return false;
    const exp = Number(expRaw);
    const want = Buffer.from(sign(secret, relPath, exp));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
    return exp * 1000 > now.getTime();
}

/** The archive's bytes, or null when it is missing. */
export function readExportArchive(
    relPath: string,
    dir: string = dataDir(),
): Bun.BunFile | null {
    const file = archiveFile(relPath, dir);
    return existsSync(file) ? Bun.file(file) : null;
}

/** Size and age of the current archive, for the dashboard; null when none. */
export function exportFileInfo(
    dir: string = dataDir(),
): { name: string; bytes: number; modified: string } | null {
    try {
        const file = archiveFile(`${OWNER_ID}/${EXPORT_FILE_NAME}`, dir);
        if (!existsSync(file)) return null;
        const st = statSync(file);
        return {
            name: EXPORT_FILE_NAME,
            bytes: st.size,
            modified: st.mtime.toISOString(),
        };
    } catch {
        return null;
    }
}

function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out;
}

/** Deletes archives older than the link TTL (and any empty folders). Returns
 *  how many files went. Runs at startup and hourly. */
export function sweepStaleExports(
    dir: string = dataDir(),
    now: Date = new Date(),
): number {
    const cutoff = now.getTime() - EXPORT_TTL_SECONDS * 1000;
    let removed = 0;
    for (const file of walk(exportsDir(dir))) {
        try {
            if (statSync(file).mtimeMs < cutoff) {
                rmSync(file, { force: true });
                removed++;
            }
        } catch {
            // vanished underneath us
        }
    }
    return removed;
}

/** Removes every export file (delete_account). */
export function removeAllExports(dir: string = dataDir()): void {
    rmSync(exportsDir(dir), { recursive: true, force: true });
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Sweeps now and then every hour. Idempotent. */
export function startExportCleanup(dir: string = dataDir()): void {
    if (timer) return;
    const run = () => {
        try {
            const n = sweepStaleExports(dir);
            if (n > 0) console.log(`Export sweep: removed ${n} stale file(s).`);
        } catch (err) {
            console.warn("Export sweep failed:", (err as Error).message);
        }
    };
    run();
    timer = setInterval(run, EXPORT_SWEEP_INTERVAL_MS);
    timer.unref?.();
}

export function stopExportCleanup(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
}
