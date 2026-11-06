import { describe, expect, test } from "bun:test";
import {
    HEALTH_SYNC_FIELDS,
    HEALTH_SYNC_FIELD_SPECS,
    HEALTH_SYNC_LEASE_SECONDS,
    HEALTH_SYNC_WINDOW_DAYS,
} from "./health-sync.js";

const doc = (
    await Bun.file(
        new URL("../docs/apple-health-shortcuts.md", import.meta.url),
    ).text()
)
    .replace(/\n> /g, "\n")
    .replace(/\s+/g, " ");

describe("docs/apple-health-shortcuts.md says what the code does", () => {
    test("every route and every field is named", () => {
        for (const route of [
            "/api/v1/health-sync/pending",
            "/api/v1/health-sync/ack",
            "/api/v1/health-sync/activity",
            "/api/v1/health-sync/status",
            "/api/v1/health-sync/revoke",
        ])
            expect(doc).toContain(route);
        for (const f of HEALTH_SYNC_FIELDS) expect(doc).toContain(f);
    });

    test("the thresholds, window and lease it quotes are the real ones", () => {
        const spec = HEALTH_SYNC_FIELD_SPECS;
        expect(doc).toContain(`${spec.energy_kcal.threshold} kcal`);
        expect(doc).toContain(`${spec.protein_g.threshold} g of protein`);
        expect(doc).toContain(`${spec.caffeine_mg.threshold} mg caffeine`);
        expect(doc).toContain(`${spec.water_ml.threshold} mL water`);
        expect(doc).toContain(`last seven local days`);
        expect(HEALTH_SYNC_WINDOW_DAYS).toBe(7);
        expect(doc).toContain(`${HEALTH_SYNC_LEASE_SECONDS / 60}-minute lease`);
        expect(doc).toContain("05:00");
    });

    test("it uses placeholders only: no real hostname, address, key or path", () => {
        expect(doc).toContain("https://food.example.com");
        expect(doc).toContain("YOUR_KEY");
        // (built from parts so this file itself carries no real hostname)
        const realHost = ["mbar", "clay"].join("");
        expect(doc.toLowerCase()).not.toContain(realHost);
        expect(doc).not.toMatch(
            /192\.168\.|10\.\d+\.\d+\.\d+|\/share\/paseo|\/data\/home/,
        );
        // no long random-looking token pasted in
        expect(
            doc.replace(/https?:\/\/\S+/g, "").replace(/\/api\/\S+/g, ""),
        ).not.toMatch(
            /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/,
        );
    });

    test("it is honest about what was not verified", () => {
        expect(doc).toContain("could not be verified");
        expect(doc).toContain("nobody has run these recipes on a phone yet");
    });
});
