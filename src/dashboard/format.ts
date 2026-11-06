/** Number, time and date formatting shared by the dashboard views. */
const NF0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export const n0 = (n: number | null | undefined): string =>
    n === null || n === undefined ? "–" : NF0.format(Math.round(n));
export const n1 = (n: number | null | undefined): string =>
    n === null || n === undefined ? "–" : NF1.format(n);

/** "14:05" in the given zone. */
export function timeIn(instant: string, tz: string): string {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(new Date(instant));
}

/** "Mon 9 Mar 2026" from a YYYY-MM-DD (no timezone arithmetic: it is a label). */
export function longDate(date: string): string {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
    }).format(new Date(`${date}T12:00:00Z`));
}

/** "9 Mar 14:05" in the zone, for the date of an instant. */
export function dateTimeIn(instant: string, tz: string): string {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(new Date(instant));
}

/** "3 hours ago" / "just now" / "2 days ago". */
export function ago(instant: string, now: Date): string {
    const s = Math.round((now.getTime() - new Date(instant).getTime()) / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.round(h / 24);
    return `${d} days ago`;
}
