import { describe, expect, test } from "bun:test";
import { CSS } from "./assets.js";

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const [r, g, bl] = [1, 3, 5].map((i) => {
            const c = parseInt(hex.slice(i, i + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
}

function vars(block: string): Record<string, string> {
    return Object.fromEntries(
        [...block.matchAll(/--([a-z-]+):(#[0-9a-f]{6})/gi)].map((m) => [
            m[1]!,
            m[2]!,
        ]),
    );
}

const light = vars(CSS.slice(0, CSS.indexOf("@media")));
const dark = vars(CSS.slice(CSS.indexOf("@media (prefers-color-scheme:dark)")));

// Text pairs that actually occur: [foreground, background].
const TEXT_PAIRS: [string, string][] = [
    ["ink", "bg"],
    ["ink", "surface"],
    ["muted", "bg"],
    ["muted", "surface"],
    ["accent", "surface"], // links
    ["accent", "bg"],
    ["accent-ink", "accent"], // primary buttons and the active tab
    ["warn", "surface"],
    ["ok", "surface"],
    ["focus", "bg"],
];

describe("colour contrast (WCAG AA, 4.5:1 for text)", () => {
    for (const [name, theme] of [
        ["light", light],
        ["dark", dark],
    ] as const) {
        test.each(TEXT_PAIRS)(`${name}: %s on %s`, (fg, bg) => {
            const ratio = contrast(theme[fg]!, theme[bg]!);
            expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
    }

    test("series colours are visible against the card (3:1 for graphics)", () => {
        for (const theme of [light, dark])
            for (const k of [
                "c-cal",
                "c-pro",
                "c-carb",
                "c-fat",
                "c-water",
                "c-weight",
                "c-act",
            ])
                expect(
                    contrast(theme[k]!, theme.surface!),
                ).toBeGreaterThanOrEqual(3);
    });
});
