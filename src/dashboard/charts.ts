/**
 * Server-rendered inline SVG charts. No script, no library: every number is
 * computed here and written as an attribute. Colours come from CSS classes so
 * light and dark mode need no second chart. Each chart carries a <title> and
 * <desc>, and callers pair it with a data table in <details>.
 */
import { esc, html, raw, type Raw } from "./html.js";

const W = 640;
const H = 220;
const L = 46;
const R = 8;
const T = 10;
const B = 26;
const PW = W - L - R;
const PH = H - T - B;

const f = (n: number): string => (Math.round(n * 10) / 10).toString();

/** A tidy axis maximum at or above v (1, 2, 2.5, 5 x 10^k). */
export function niceMax(v: number): number {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = 10 ** exp;
    for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= v) return m * base;
    return 10 * base;
}

const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];
/** "2026-03-09" -> "Mar 9". */
export function shortDate(date: string): string {
    const m = Number(date.slice(5, 7));
    return `${MONTHS[m - 1] ?? "?"} ${Number(date.slice(8, 10))}`;
}

const fmt = (n: number): string =>
    Math.abs(n) >= 1000
        ? `${f(n / 1000)}k`
        : Math.round(n * 10) % 10 === 0
          ? String(Math.round(n))
          : f(n);

function frame(
    title: string,
    desc: string,
    ticks: { y: number; label: string }[],
    xLabels: { x: number; label: string; anchor: string }[],
    inner: Raw,
): Raw {
    return html`<svg
        class="chart"
        viewBox="0 0 ${W} ${H}"
        role="img"
        aria-labelledby="t d"
        preserveAspectRatio="xMidYMid meet"
    >
        <title id="t">${title}</title>
        <desc id="d">${desc}</desc>
        ${ticks.map(
            (t) =>
                html`<line
                        class="grid-line"
                        x1="${L}"
                        x2="${W - R}"
                        y1="${f(t.y)}"
                        y2="${f(t.y)}"
                    /><text x="${L - 6}" y="${f(t.y + 4)}" text-anchor="end"
                        >${t.label}</text
                    >`,
        )}
        ${xLabels.map((x) => html`<text x="${f(x.x)}" y="${H - 6}" text-anchor="${x.anchor}">${x.label}</text>`)}
        ${inner}
    </svg>`;
}

/** Evenly spread x labels, always including the first and last. */
function xLabelsFor(labels: string[], xAt: (i: number) => number) {
    const n = labels.length;
    if (n === 0) return [];
    const want = Math.min(n, 5);
    const idx = new Set<number>();
    for (let k = 0; k < want; k++)
        idx.add(Math.round((k * (n - 1)) / Math.max(1, want - 1)));
    return [...idx].map((i) => ({
        x: xAt(i),
        label: labels[i]!,
        anchor: i === 0 ? "start" : i === n - 1 ? "end" : "middle",
    }));
}

export interface BarPoint {
    label: string;
    value: number;
}

/** Daily bars from zero, with an optional dashed goal line. */
export function barChart(opts: {
    title: string;
    unit: string;
    points: BarPoint[];
    goal?: number | null;
    cls: string;
}): Raw {
    const n = opts.points.length;
    const max = niceMax(
        Math.max(opts.goal ?? 0, ...opts.points.map((p) => p.value), 0),
    );
    const y = (v: number) => T + PH - (v / max) * PH;
    const slot = PW / Math.max(1, n);
    const bw = Math.max(1.5, slot * 0.7);
    const xAt = (i: number) => L + slot * i + slot / 2;
    const ticks = [0, 1, 2, 3, 4].map((k) => ({
        y: y((max * k) / 4),
        label: fmt((max * k) / 4),
    }));
    const bars = opts.points.map((p, i) =>
        p.value > 0
            ? html`<rect
                  class="${opts.cls}"
                  x="${f(xAt(i) - bw / 2)}"
                  y="${f(y(p.value))}"
                  width="${f(bw)}"
                  height="${f(T + PH - y(p.value))}"
                  rx="1.5"
              />`
            : "",
    );
    const goal =
        opts.goal && opts.goal > 0
            ? html`<line
                  class="goal"
                  x1="${L}"
                  x2="${W - R}"
                  y1="${f(y(opts.goal))}"
                  y2="${f(y(opts.goal))}"
              />`
            : "";
    const total = opts.points.reduce((s, p) => s + p.value, 0);
    return frame(
        opts.title,
        `${n} days, ${opts.unit}; total ${fmt(total)}${opts.goal ? `; goal ${fmt(opts.goal)} per day` : ""}.`,
        ticks,
        xLabelsFor(
            opts.points.map((p) => p.label),
            xAt,
        ),
        html`${bars}${goal}`,
    );
}

export interface StackPoint {
    label: string;
    parts: number[];
}

/** Daily stacked bars (e.g. protein / carbs / fat grams); `classes` per part. */
export function stackedBarChart(opts: {
    title: string;
    unit: string;
    points: StackPoint[];
    classes: string[];
}): Raw {
    const n = opts.points.length;
    const totals = opts.points.map((p) => p.parts.reduce((s, v) => s + v, 0));
    const max = niceMax(Math.max(...totals, 0));
    const y = (v: number) => T + PH - (v / max) * PH;
    const slot = PW / Math.max(1, n);
    const bw = Math.max(1.5, slot * 0.7);
    const xAt = (i: number) => L + slot * i + slot / 2;
    const ticks = [0, 1, 2, 3, 4].map((k) => ({
        y: y((max * k) / 4),
        label: fmt((max * k) / 4),
    }));
    const bars = opts.points.map((p, i) => {
        let acc = 0;
        return p.parts.map((v, k) => {
            if (v <= 0) return "";
            const top = y(acc + v);
            const h = y(acc) - top;
            acc += v;
            return html`<rect
                class="${opts.classes[k]!}"
                x="${f(xAt(i) - bw / 2)}"
                y="${f(top)}"
                width="${f(bw)}"
                height="${f(h)}"
            />`;
        });
    });
    return frame(
        opts.title,
        `${n} days, stacked ${opts.unit} per day.`,
        ticks,
        xLabelsFor(
            opts.points.map((p) => p.label),
            xAt,
        ),
        html`${bars}`,
    );
}

export interface LinePoint {
    label: string;
    value: number;
}

/** A line through the readings that exist (gaps are skipped, not zeroed). */
export function lineChart(opts: {
    title: string;
    unit: string;
    points: LinePoint[];
    cls: string;
}): Raw {
    const n = opts.points.length;
    const values = opts.points.map((p) => p.value);
    const lo0 = Math.min(...values);
    const hi0 = Math.max(...values);
    const pad = Math.max((hi0 - lo0) * 0.15, 0.5);
    const lo = lo0 - pad;
    const hi = hi0 + pad;
    const y = (v: number) => T + PH - ((v - lo) / (hi - lo)) * PH;
    const xAt = (i: number) => (n === 1 ? L + PW / 2 : L + (PW * i) / (n - 1));
    const ticks = [0, 1, 2, 3].map((k) => {
        const v = lo + ((hi - lo) * k) / 3;
        return { y: y(v), label: f(v) };
    });
    const path = opts.points
        .map((p, i) => `${i === 0 ? "M" : "L"}${f(xAt(i))} ${f(y(p.value))}`)
        .join(" ");
    const dots =
        n <= 45
            ? opts.points.map(
                  (p, i) =>
                      html`<circle
                          class="dot ${opts.cls}"
                          cx="${f(xAt(i))}"
                          cy="${f(y(p.value))}"
                          r="3.5"
                      />`,
              )
            : "";
    return frame(
        opts.title,
        `${n} readings in ${opts.unit}, from ${f(values[0]!)} to ${f(values[n - 1]!)}.`,
        ticks,
        xLabelsFor(
            opts.points.map((p) => p.label),
            xAt,
        ),
        html`<path class="line ${opts.cls}" d="${path}" />${dots}`,
    );
}

/** A horizontal progress bar; `over` recolours it. Width is an attribute, not style. */
export function meter(opts: {
    value: number;
    goal: number | null;
    cls?: string;
    label: string;
}): Raw {
    const pct =
        opts.goal && opts.goal > 0
            ? Math.min(100, (opts.value / opts.goal) * 100)
            : 0;
    const over = opts.goal !== null && opts.goal > 0 && opts.value > opts.goal;
    return html`<svg
        class="meter"
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        role="img"
        aria-label="${opts.label}"
    >
        <rect
            class="f ${opts.cls ?? ""} ${over ? "over" : ""}"
            x="0"
            y="0"
            width="${f(pct)}"
            height="6"
        />
    </svg>`;
}

/** The calorie ring: eaten (net of credited activity) against the goal. */
export function ring(opts: {
    value: number;
    goal: number | null;
    centre: string;
    sub: string;
    label: string;
}): Raw {
    const r = 52;
    const c = 2 * Math.PI * r;
    const ratio =
        opts.goal && opts.goal > 0
            ? Math.max(0, Math.min(1, opts.value / opts.goal))
            : 0;
    const over = opts.goal !== null && opts.goal > 0 && opts.value > opts.goal;
    return html`<svg
        viewBox="0 0 140 140"
        role="img"
        aria-label="${opts.label}"
    >
        <circle
            class="track"
            cx="70"
            cy="70"
            r="${r}"
            fill="none"
            stroke-width="12"
        />
        <circle
            class="fill${over ? " over" : ""}"
            cx="70"
            cy="70"
            r="${r}"
            fill="none"
            stroke-width="12"
            stroke-dasharray="${f(c * ratio)} ${f(c)}"
            transform="rotate(-90 70 70)"
        />
        <text x="70" y="68" text-anchor="middle" font-size="24">
            ${opts.centre}
        </text>
        <text x="70" y="88" text-anchor="middle" font-size="11" class="sub">
            ${opts.sub}
        </text>
    </svg>`;
}

/** A table of the plotted values, offered under each chart. */
export function dataTable(headers: string[], rows: (string | number)[][]): Raw {
    return html`<details>
        <summary>Show the numbers</summary>
        <div class="scroll">
            <table>
                <thead>
                    <tr>
                        ${headers.map((h, i) => html`<th${i === 0 ? "" : raw(' class="num"')}>${h}</th>`)}
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(
                        (r) =>
                            html`<tr>
                                ${r.map((c, i) => html`<td${i === 0 ? "" : raw(' class="num"')}>${c}</td>`)}
                            </tr>`,
                    )}
                </tbody>
            </table>
        </div>
    </details>`;
}

export { esc };
