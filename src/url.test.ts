import { afterEach, describe, expect, test } from "bun:test";
import { getBaseUrl, isHttpsRequest } from "./url.js";

const saved = {
    trust: process.env.TRUST_PROXY,
    pub: process.env.PUBLIC_URL,
};
afterEach(() => {
    for (const [k, v] of [
        ["TRUST_PROXY", saved.trust],
        ["PUBLIC_URL", saved.pub],
    ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const req = (headers: Record<string, string> = {}) =>
    new Request("http://10.0.0.5:8080/mcp/k", { headers });

describe("getBaseUrl", () => {
    test("ignores X-Forwarded-Host/Proto without TRUST_PROXY", () => {
        delete process.env.TRUST_PROXY;
        delete process.env.PUBLIC_URL;
        expect(
            getBaseUrl(
                req({
                    "x-forwarded-host": "evil.example",
                    "x-forwarded-proto": "https",
                }),
            ),
        ).toBe("http://10.0.0.5:8080");
    });

    test("uses them under TRUST_PROXY=1", () => {
        process.env.TRUST_PROXY = "1";
        delete process.env.PUBLIC_URL;
        expect(
            getBaseUrl(
                req({
                    "x-forwarded-host": "food.example.com",
                    "x-forwarded-proto": "https",
                }),
            ),
        ).toBe("https://food.example.com");
    });

    test("takes the first of a comma list and rejects hosts that are not bare host[:port]", () => {
        process.env.TRUST_PROXY = "1";
        delete process.env.PUBLIC_URL;
        expect(
            getBaseUrl(
                req({
                    "x-forwarded-host": "food.example.com, other.example",
                    "x-forwarded-proto": "https, http",
                }),
            ),
        ).toBe("https://food.example.com");
        for (const bad of [
            "evil.example/path",
            "user@evil.example",
            "a b",
            "evil.example:99999999",
            "evél.example",
        ]) {
            expect(getBaseUrl(req({ "x-forwarded-host": bad }))).toBe(
                "http://10.0.0.5:8080",
            );
        }
    });

    test("PUBLIC_URL wins over everything, reduced to its origin", () => {
        process.env.TRUST_PROXY = "1";
        process.env.PUBLIC_URL = "https://food.example.org/some/path/";
        expect(getBaseUrl(req({ "x-forwarded-host": "evil.example" }))).toBe(
            "https://food.example.org",
        );
    });

    test("an invalid PUBLIC_URL is ignored", () => {
        delete process.env.TRUST_PROXY;
        process.env.PUBLIC_URL = "javascript:alert(1)";
        expect(getBaseUrl(req())).toBe("http://10.0.0.5:8080");
        process.env.PUBLIC_URL = "not a url";
        expect(getBaseUrl(req())).toBe("http://10.0.0.5:8080");
    });
});

describe("isHttpsRequest", () => {
    test("X-Forwarded-Proto counts only under TRUST_PROXY=1", () => {
        delete process.env.TRUST_PROXY;
        expect(isHttpsRequest(req({ "x-forwarded-proto": "https" }))).toBe(
            false,
        );
        process.env.TRUST_PROXY = "1";
        expect(isHttpsRequest(req({ "x-forwarded-proto": "https" }))).toBe(
            true,
        );
        expect(isHttpsRequest(req({ "x-forwarded-proto": "http" }))).toBe(
            false,
        );
        expect(isHttpsRequest(req())).toBe(false);
    });
});
