/**
 * Minimal HTML templating with escaping by default. A tagged template escapes
 * every interpolated value unless it is a `Raw` (made by `raw()` or by another
 * `html` call). Meal names, notes and every other stored string therefore
 * reach the page as text, never as markup.
 */
export class Raw {
    constructor(readonly value: string) {}
    toString(): string {
        return this.value;
    }
}

/** Trusted markup: only ever literals in this codebase, never user data. */
export const raw = (value: string): Raw => new Raw(value);

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;",
};

/** Escapes text for element content AND quoted attribute values. */
export function esc(value: unknown): string {
    return String(value ?? "").replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]!);
}

type Part =
    Raw | string | number | boolean | null | undefined | readonly Part[];

function render(part: Part): string {
    if (part === null || part === undefined || part === false || part === true)
        return "";
    if (part instanceof Raw) return part.value;
    if (Array.isArray(part)) return part.map(render).join("");
    return esc(part);
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Raw {
    let out = strings[0]!;
    for (let i = 0; i < values.length; i++) {
        out += render(values[i]!) + strings[i + 1]!;
    }
    return new Raw(out);
}
