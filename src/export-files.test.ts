import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    EXPORT_TTL_SECONDS,
    exportsDir,
    readExportArchive,
    removeAllExports,
    signExportLink,
    startExportCleanup,
    stopExportCleanup,
    sweepStaleExports,
    verifyExportLink,
    writeExportArchive,
} from "./export-files.js";

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "expf-"));
});
afterEach(() => {
    stopExportCleanup();
    rmSync(dir, { recursive: true, force: true });
});

const SECRET = "s".repeat(40);
const REL = "owner/nutrition-mcp-export.zip";

describe("signing", () => {
    test("a fresh link verifies; the lifetime is the documented hour", () => {
        const now = new Date("2026-03-14T10:00:00Z");
        const { path, expiresAt } = signExportLink(SECRET, REL, now);
        expect(expiresAt.getTime() - now.getTime()).toBe(
            EXPORT_TTL_SECONDS * 1000,
        );
        const q = new URL(path, "http://x").searchParams;
        expect(
            verifyExportLink(SECRET, REL, q.get("exp")!, q.get("sig")!, now),
        ).toBe(true);
        expect(
            verifyExportLink(
                SECRET,
                REL,
                q.get("exp")!,
                q.get("sig")!,
                new Date(expiresAt.getTime() - 1),
            ),
        ).toBe(true);
        expect(
            verifyExportLink(
                SECRET,
                REL,
                q.get("exp")!,
                q.get("sig")!,
                expiresAt,
            ),
        ).toBe(false);
    });

    test("every ingredient is bound: secret, path, expiry", () => {
        const now = new Date("2026-03-14T10:00:00Z");
        const q = new URL(signExportLink(SECRET, REL, now).path, "http://x")
            .searchParams;
        const exp = q.get("exp")!;
        const sig = q.get("sig")!;
        expect(verifyExportLink("t".repeat(40), REL, exp, sig, now)).toBe(
            false,
        );
        expect(verifyExportLink(SECRET, "other/x.zip", exp, sig, now)).toBe(
            false,
        );
        expect(
            verifyExportLink(SECRET, REL, String(Number(exp) + 60), sig, now),
        ).toBe(false);
    });

    test("garbage input is refused without throwing", () => {
        const now = new Date();
        for (const [e, s] of [
            [undefined, undefined],
            ["", ""],
            ["abc", "def"],
            ["1".repeat(30), "x"],
            ["-5", "x"],
            [String(Math.floor(now.getTime() / 1000) + 60), ""],
            [String(Math.floor(now.getTime() / 1000) + 60), "short"],
        ] as const) {
            expect(verifyExportLink(SECRET, REL, e, s, now)).toBe(false);
        }
    });
});

describe("files", () => {
    test("write, read and the path-escape guard", async () => {
        const file = writeExportArchive(
            REL,
            new TextEncoder().encode("zip"),
            dir,
        );
        expect(file.startsWith(exportsDir(dir))).toBe(true);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(await readExportArchive(REL, dir)!.text()).toBe("zip");
        expect(readExportArchive("owner/missing.zip", dir)).toBeNull();
        expect(() =>
            writeExportArchive("../escape.zip", new Uint8Array(1), dir),
        ).toThrow(/Invalid export path/);
        expect(() => readExportArchive("../../etc/passwd", dir)).toThrow(
            /Invalid export path/,
        );
        expect(() =>
            writeExportArchive("/etc/passwd", new Uint8Array(1), dir),
        ).toThrow(/Invalid export path/);
    });

    test("sweep removes only archives older than the link lifetime", () => {
        const old = writeExportArchive("a/old.zip", new Uint8Array(1), dir);
        const fresh = writeExportArchive("b/fresh.zip", new Uint8Array(1), dir);
        const longAgo = new Date(
            Date.now() - (EXPORT_TTL_SECONDS + 600) * 1000,
        );
        utimesSync(old, longAgo, longAgo);
        expect(sweepStaleExports(dir)).toBe(1);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
        expect(sweepStaleExports(dir)).toBe(0);
    });

    test("sweep on a data dir that never exported is a no-op", () => {
        expect(sweepStaleExports(dir)).toBe(0);
    });

    test("startExportCleanup sweeps immediately (startup) and is idempotent", () => {
        const old = writeExportArchive("a/old.zip", new Uint8Array(1), dir);
        const longAgo = new Date(
            Date.now() - (EXPORT_TTL_SECONDS + 600) * 1000,
        );
        utimesSync(old, longAgo, longAgo);
        startExportCleanup(dir);
        startExportCleanup(dir);
        expect(existsSync(old)).toBe(false);
    });

    test("removeAllExports deletes everything, and tolerates there being nothing", () => {
        writeExportArchive("a/x.zip", new Uint8Array(1), dir);
        writeExportArchive("b/y.zip", new Uint8Array(1), dir);
        removeAllExports(dir);
        expect(existsSync(exportsDir(dir))).toBe(false);
        expect(() => removeAllExports(dir)).not.toThrow();
    });
});
