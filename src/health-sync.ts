// Apple Health sync via an iOS Shortcut: the pure half. Everything here is a
// function of its arguments (plus the tz helpers, which only read the ICU
// database), so the rules that decide what reaches Apple Health are pinned by
// table-driven tests in src/health-sync.test.ts without a database or Hono.
//
// The shape of the feature, in one paragraph: the Shortcut runs every hour and
// asks GET /pending what to add to Apple Health. For each of the last seven
// local days (today included) the server totals what was logged, subtracts
// what it already told Health about ("sent so far", acknowledged by the
// Shortcut), and offers the positive difference as one entry per day. The
// Shortcut logs the values as samples and acks them; the ledger then moves up.
// Health can only ADD samples, so a day whose total later drops is reported
// as a discrepancy and never written as a negative.
//
// Must not import mcp.ts or db/repo.ts at runtime (types only), and must not
// reuse the zero-filling `sumMeals` / `totalsPayloadOf`: here a nutrient no
// meal carries is null and is never sent, while a real 0 is a value.

import type { HealthSyncDayRow, Meal, WaterEntry } from "./db/repo.js";
import {
    dateInTz,
    formatLocalDateTime,
    shiftLocalDate,
    validateTz,
    zonedHourUtc,
} from "./tz.js";

// ---------- constants ----------

/** A day D is "closed" at this local hour on D+1: after it the day only gets
 *  one last top-up of whatever is still unsent. */
export const HEALTH_SYNC_CLOSE_HOUR = 5;
/** How many local days /pending looks at: today and the six before it. */
export const HEALTH_SYNC_WINDOW_DAYS = 7;
/** How long a ledger row is kept after its date. */
export const HEALTH_SYNC_RETENTION_DAYS = 8;
/** One sync run holds the owner's lease this long. */
export const HEALTH_SYNC_LEASE_SECONDS = 120;
/** Most entries one POST /ack may carry. */
export const HEALTH_SYNC_MAX_ACK_ENTRIES = 20;
/** Entries acknowledged per day are capped: a day that needs more is almost
 *  certainly a loop, and the Health app becomes unreadable. */
export const HEALTH_SYNC_MAX_ROUNDS = 48;

// ---------- fields ----------

/** Keys the Shortcut maps onto HealthKit types, each named with its unit. */
export const HEALTH_SYNC_FIELDS = [
    "energy_kcal",
    "protein_g",
    "carbohydrates_g",
    "fat_g",
    "fiber_g",
    "caffeine_mg",
    "water_ml",
] as const;
export type HealthSyncField = (typeof HEALTH_SYNC_FIELDS)[number];

/** Sent always. Water is opt-in per request (an Apple Watch or another app
 *  often logs it already). Alcohol is never a field at all: HealthKit only has
 *  a drink count, and the alcohol opt-in exists for users in recovery. */
export const HEALTH_SYNC_DEFAULT_FIELDS: readonly HealthSyncField[] = [
    "energy_kcal",
    "protein_g",
    "carbohydrates_g",
    "fat_g",
    "fiber_g",
    "caffeine_mg",
];

type MealColumn =
    "calories" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g" | "caffeine_mg";

export interface HealthSyncFieldSpec {
    /** Where the value comes from: a meal column, or the sum of water rows. */
    source: { table: "meals"; column: MealColumn } | { table: "water" };
    unit: "kcal" | "g" | "mg" | "mL";
    /** 0 rounds to integers (kcal, mg, mL); 1 rounds grams to one decimal. */
    decimals: 0 | 1;
    /** An OPEN day's change smaller than this is ignored, up and down. A
     *  closed day uses the smallest step the precision allows. */
    threshold: number;
    /** Largest value POST /ack accepts for this field. */
    ackMax: number;
    /** How a notice names the amount ("420 kcal", "12.5 g protein"). */
    noun: string;
    /** The HealthKit type's name in the Health app. */
    healthName: string;
}

export const HEALTH_SYNC_FIELD_SPECS: Record<
    HealthSyncField,
    HealthSyncFieldSpec
> = {
    energy_kcal: {
        source: { table: "meals", column: "calories" },
        unit: "kcal",
        decimals: 0,
        threshold: 20,
        ackMax: 50_000,
        noun: "kcal",
        healthName: "Dietary Energy",
    },
    protein_g: {
        source: { table: "meals", column: "protein_g" },
        unit: "g",
        decimals: 1,
        threshold: 2,
        ackMax: 10_000,
        noun: "g protein",
        healthName: "Protein",
    },
    carbohydrates_g: {
        source: { table: "meals", column: "carbs_g" },
        unit: "g",
        decimals: 1,
        threshold: 2,
        ackMax: 10_000,
        noun: "g carbohydrates",
        healthName: "Carbohydrates",
    },
    fat_g: {
        source: { table: "meals", column: "fat_g" },
        unit: "g",
        decimals: 1,
        threshold: 2,
        ackMax: 10_000,
        noun: "g fat",
        healthName: "Total Fat",
    },
    fiber_g: {
        source: { table: "meals", column: "fiber_g" },
        unit: "g",
        decimals: 1,
        threshold: 2,
        ackMax: 10_000,
        noun: "g fiber",
        healthName: "Fiber",
    },
    caffeine_mg: {
        source: { table: "meals", column: "caffeine_mg" },
        unit: "mg",
        decimals: 0,
        threshold: 10,
        ackMax: 100_000,
        noun: "mg caffeine",
        healthName: "Caffeine",
    },
    water_ml: {
        source: { table: "water" },
        unit: "mL",
        decimals: 0,
        threshold: 100,
        ackMax: 100_000,
        noun: "mL water",
        healthName: "Water",
    },
};

export function isHealthSyncField(key: string): key is HealthSyncField {
    return (HEALTH_SYNC_FIELDS as readonly string[]).includes(key);
}

/** The fields one run sends: the defaults, plus water when asked for. Always
 *  in HEALTH_SYNC_FIELDS order. */
export function fieldsFor(includeWater: boolean): HealthSyncField[] {
    return HEALTH_SYNC_FIELDS.filter(
        (f) =>
            HEALTH_SYNC_DEFAULT_FIELDS.includes(f) ||
            (includeWater && f === "water_ml"),
    );
}

/** Round to the field's precision: integers for kcal/mg/mL, one decimal for
 *  grams. Also folds -0 to 0. */
export function roundField(field: HealthSyncField, value: number): number {
    const r =
        HEALTH_SYNC_FIELD_SPECS[field].decimals === 0
            ? Math.round(value)
            : Math.round(value * 10) / 10;
    return r === 0 ? 0 : r;
}

/** The smallest non-zero amount the field can carry (1, or 0.1 for grams). */
export function unitStep(field: HealthSyncField): number {
    return HEALTH_SYNC_FIELD_SPECS[field].decimals === 0 ? 1 : 0.1;
}

// ---------- daily totals ----------

/** Values for one day keyed by field. A missing key means "nothing carries a
 *  value" — never sent, never stored as 0. */
export type DayValues = Partial<Record<HealthSyncField, number>>;

/** Every field for one day: the rounded sum, or null when no meal (for water:
 *  no water row) carries a value for it. A real 0 stays 0. */
export type DayTotals = Record<HealthSyncField, number | null>;

export type HealthSyncMeal = Pick<Meal, "logged_at" | MealColumn>;
export type HealthSyncWater = Pick<WaterEntry, "logged_at" | "amount_ml">;

function emptyTotals(): DayTotals {
    return Object.fromEntries(
        HEALTH_SYNC_FIELDS.map((f) => [f, null]),
    ) as DayTotals;
}

/**
 * Per-local-day totals of `meals` and `water` in `tz`, with presence. Every
 * date in `dates` gets an entry (all-null when nothing was logged); rows on
 * other dates are ignored, so the caller may pass a read that is wider than
 * the window. Sums are taken raw and rounded once, so per-meal rounding never
 * accumulates.
 */
export function computeDayTotals(
    meals: readonly HealthSyncMeal[],
    water: readonly HealthSyncWater[],
    tz: string,
    dates: readonly string[],
): Map<string, DayTotals> {
    const raw = new Map<string, DayTotals>();
    for (const d of dates) raw.set(d, emptyTotals());
    const add = (day: DayTotals, f: HealthSyncField, v: unknown) => {
        if (typeof v !== "number" || !Number.isFinite(v)) return;
        day[f] = (day[f] ?? 0) + v;
    };
    for (const m of meals) {
        const day = raw.get(dateInTz(m.logged_at, tz));
        if (!day) continue;
        for (const f of HEALTH_SYNC_FIELDS) {
            const src = HEALTH_SYNC_FIELD_SPECS[f].source;
            if (src.table === "meals") add(day, f, m[src.column]);
        }
    }
    for (const w of water) {
        const day = raw.get(dateInTz(w.logged_at, tz));
        if (day) add(day, "water_ml", w.amount_ml);
    }
    for (const day of raw.values()) {
        for (const f of HEALTH_SYNC_FIELDS) {
            const v = day[f];
            if (v !== null) day[f] = roundField(f, v);
        }
    }
    return raw;
}

// ---------- time: window, close instant, timezone ----------

/**
 * The instant day `date` closes in `tz`: 05:00 local on the NEXT day, resolved
 * through zonedHourUtc — never "day start + N hours", which is an hour off on
 * either side of a DST change.
 */
export function closeInstant(date: string, tz: string): Date {
    return zonedHourUtc(shiftLocalDate(date, 1), tz, HEALTH_SYNC_CLOSE_HOUR);
}

/** Whether day `date` is closed (past 05:00 on the next day) at `now`. */
export function isClosed(date: string, now: Date, tz: string): boolean {
    return closeInstant(date, tz).getTime() <= now.getTime();
}

/** The local dates /pending covers, ascending: today and the six before. */
export function windowDates(now: Date, tz: string): string[] {
    const today = dateInTz(now, tz);
    const dates: string[] = [];
    for (let i = HEALTH_SYNC_WINDOW_DAYS - 1; i >= 0; i--) {
        dates.push(shiftLocalDate(today, -i));
    }
    return dates;
}

/**
 * The dates POST /ack accepts: the window, plus one day further back. An entry
 * is offered for one of the window's dates, and its ack may land after
 * midnight slid the window on by a day. Nothing older and nothing in the
 * future ever is, which keeps every ledger row inside the retention.
 */
export function ackWindow(now: Date, tz: string): { from: string; to: string } {
    const today = dateInTz(now, tz);
    return {
        from: shiftLocalDate(today, -HEALTH_SYNC_WINDOW_DAYS),
        to: today,
    };
}

export type TimezoneSource = "profile" | "phone" | "utc";

/** The zone days are bucketed in: the profile's, else the one the phone sent,
 *  else UTC. The phone's zone is never written to the profile. */
export function effectiveTimezone(
    profileTz: string | null | undefined,
    phoneTz: string | null | undefined,
): { tz: string; source: TimezoneSource } {
    if (profileTz && validateTz(profileTz)) {
        return { tz: profileTz, source: "profile" };
    }
    if (phoneTz && validateTz(phoneTz)) {
        return { tz: phoneTz, source: "phone" };
    }
    return { tz: "UTC", source: "utc" };
}

/** ISO 8601 with the zone's own offset, e.g. "2026-10-04T05:00:00+03:00". */
export function formatInstantWithOffset(instant: Date, tz: string): string {
    const local = formatLocalDateTime(instant, tz);
    const wallMs = Date.parse(`${local.replace(" ", "T")}Z`);
    const offsetMin = Math.round(
        (wallMs - Math.floor(instant.getTime() / 1000) * 1000) / 60_000,
    );
    const sign = offsetMin < 0 ? "-" : "+";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${local.replace(" ", "T")}${sign}${hh}:${mm}`;
}

/**
 * When the Shortcut dates a sample for `date`. Today's entries are dated NOW
 * (floored to the minute), which is when the food was synced; any other day's
 * are dated 23:59 on that day, so Health files them under the right date
 * whichever hour the run happens at.
 */
export function sampleAt(date: string, now: Date, tz: string): string {
    if (date === dateInTz(now, tz)) {
        const minute = Math.floor(now.getTime() / 60_000) * 60_000;
        return formatInstantWithOffset(new Date(minute), tz);
    }
    const late = new Date(zonedHourUtc(date, tz, 23).getTime() + 59 * 60_000);
    return formatInstantWithOffset(late, tz);
}

export function isCalendarDate(s: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(y, m - 1, d));
    return (
        probe.getUTCFullYear() === y &&
        probe.getUTCMonth() === m - 1 &&
        probe.getUTCDate() === d
    );
}

// ---------- entries ----------

/** "<date>:r<n>": the n-th entry of a day. Stable until acknowledged. */
export function entryId(date: string, round: number): string {
    return `${date}:r${round}`;
}

const ENTRY_ID_RE = /^(\d{4}-\d{2}-\d{2}):r([1-9]\d{0,2})$/;

export function parseEntryId(
    id: string,
): { date: string; round: number } | null {
    const m = ENTRY_ID_RE.exec(id);
    if (!m || !isCalendarDate(m[1]!)) return null;
    return { date: m[1]!, round: Number(m[2]) };
}

export interface Entry {
    entry_id: string;
    date: string;
    /** The day is over (past 05:00 the next morning): this is its final top-up. */
    closed: boolean;
    /** The instant the Shortcut dates the samples at (see sampleAt). */
    sample_at: string;
    /** Amounts to ADD to Health, per field. Always positive. */
    values: DayValues;
}

/** A day whose logged total fell below what Health already holds. Never
 *  written (Health cannot lower a value); reported instead. */
export interface Discrepancy {
    date: string;
    field: HealthSyncField;
    sent: number;
    current: number;
    /** current − sent, negative. */
    difference: number;
}

/** One window day as the dashboard and /status show it. */
export interface DayStatus {
    date: string;
    closed: boolean;
    /** Logged totals for the run's fields (null/absent fields omitted). */
    logged: DayValues;
    /** What Health holds from us ("sent so far"). */
    sent: DayValues;
    /** What the next /pending would offer for the day. */
    pending: DayValues;
    rounds: number;
}

export interface IntradayPlan {
    dates: string[];
    entries: Entry[];
    discrepancies: Discrepancy[];
    notices: string[];
    days: DayStatus[];
}

export interface PlanInput {
    now: Date;
    tz: string;
    /** computeDayTotals over windowDates(now, tz). */
    totals: ReadonlyMap<string, DayTotals>;
    /** Existing ledger rows; rows outside the window are ignored. */
    ledger: readonly HealthSyncDayRow[];
    fields: readonly HealthSyncField[];
}

function shortDate(date: string): string {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Decide what one GET /pending offers. Per window date, per enabled field:
 *
 *   delta = round(logged total − sent so far)
 *
 *  - delta ≥ the field's threshold (open day) or ≥ one unit of precision
 *    (closed day, i.e. "any positive amount still left") → part of the day's
 *    next entry. The entry carries the deltas only, never totals.
 *  - sent − logged ≥ that same bar → a discrepancy. Nothing is written for it;
 *    if the total later climbs back above what was sent, the delta is positive
 *    again and flows normally.
 *
 * A day whose ledger row was written in another timezone is frozen (the local
 * day no longer means the same 24 hours) with one notice per run; a day at
 * HEALTH_SYNC_MAX_ROUNDS entries stops being offered, also with a notice.
 *
 * Read-only: planning never writes the ledger. Only an acknowledged entry
 * moves "sent so far", so a run that dies half way simply offers the same
 * entry again.
 */
export function planIntraday(input: PlanInput): IntradayPlan {
    const { now, tz, fields } = input;
    const dates = windowDates(now, tz);
    const byDate = new Map(input.ledger.map((r) => [r.date, r]));
    const entries: Entry[] = [];
    const discrepancies: Discrepancy[] = [];
    const notices: string[] = [];
    const days: DayStatus[] = [];

    for (const date of dates) {
        const row = byDate.get(date);
        const cur = input.totals.get(date) ?? emptyTotals();
        const closed = isClosed(date, now, tz);
        const sent: DayValues = row ? { ...row.sent } : {};
        const logged: DayValues = {};
        const pending: DayValues = {};
        const frozen = !!row && row.rounds > 0 && row.timezone !== tz;

        for (const f of fields) {
            const c = cur[f];
            if (c !== null) logged[f] = c;
            if (frozen) continue;
            const s = sent[f] ?? 0;
            const delta = roundField(f, (c ?? 0) - s);
            const bar = closed
                ? unitStep(f)
                : HEALTH_SYNC_FIELD_SPECS[f].threshold;
            if (delta >= bar) {
                pending[f] = delta;
            } else if (-delta >= bar) {
                discrepancies.push({
                    date,
                    field: f,
                    sent: s,
                    current: c ?? 0,
                    difference: roundField(f, -(-delta)),
                });
            }
        }

        const rounds = row?.rounds ?? 0;
        if (frozen) {
            notices.push(
                `${shortDate(date)} was sent to Apple Health in ${row!.timezone} and the timezone is now ${tz}, so changes to that day are no longer synced. Any difference can be entered in Health by hand.`,
            );
        } else if (Object.keys(pending).length > 0) {
            if (rounds >= HEALTH_SYNC_MAX_ROUNDS) {
                notices.push(
                    `${shortDate(date)} has already had ${HEALTH_SYNC_MAX_ROUNDS} updates in Apple Health, so further changes to that day are not synced.`,
                );
                for (const f of Object.keys(pending)) {
                    delete pending[f as HealthSyncField];
                }
            } else {
                entries.push({
                    entry_id: entryId(date, rounds + 1),
                    date,
                    closed,
                    sample_at: sampleAt(date, now, tz),
                    values: { ...pending },
                });
            }
        }
        days.push({ date, closed, logged, sent, pending, rounds });
    }
    return { dates, entries, discrepancies, notices, days };
}

// ---------- ack ----------

export interface AckEntry {
    entry_id: string;
    date: string;
    values: DayValues;
}

export interface AckResult {
    applied: boolean;
    /** The row to write when `applied`; otherwise null. */
    row: HealthSyncDayRow | null;
}

/**
 * Apply one acknowledged entry to its day's row. Idempotent and strictly
 * ordered: entry `rN` applies only when the day has exactly N−1 acknowledged
 * rounds, so a replayed ack (its round already counted), a stale one, or one
 * that skips ahead changes nothing. The echoed `values` are what the phone
 * actually logged, so they, not a recomputation, are what the ledger adds.
 */
export function applyAck(
    row: HealthSyncDayRow | null,
    entry: AckEntry,
    tz: string,
    now: Date,
): AckResult {
    const parsed = parseEntryId(entry.entry_id);
    if (!parsed || parsed.date !== entry.date) {
        return { applied: false, row: null };
    }
    const have = row?.rounds ?? 0;
    if (parsed.round !== have + 1) return { applied: false, row: null };
    const stamp = now.toISOString();
    const sent: DayValues = row ? { ...row.sent } : {};
    let any = false;
    for (const [k, v] of Object.entries(entry.values)) {
        if (!isHealthSyncField(k) || typeof v !== "number") continue;
        sent[k] = roundField(k, (sent[k] ?? 0) + roundField(k, v));
        any = true;
    }
    if (!any) return { applied: false, row: null };
    return {
        applied: true,
        row: {
            date: entry.date,
            // Keep the zone the day was first counted in: later runs compare
            // against it, and a changed zone then freezes the day.
            timezone: row?.timezone ?? tz,
            rounds: parsed.round,
            sent,
            first_sent_at: row?.first_sent_at ?? stamp,
            last_sent_at: stamp,
        },
    };
}

// ---------- request bodies ----------

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface AckBody {
    entries: AckEntry[];
    done: boolean;
    /** The `lease_until` /pending returned. `done: true` frees the lease only
     *  when it is still this one, so a late ack from a run whose lease lapsed
     *  never frees the lease a newer run holds. Absent when not sent. */
    lease_until?: string;
}

/** POST /ack: `{ entries: [{ entry_id, date, values }], done?, lease_until? }`.
 *  At most HEALTH_SYNC_MAX_ACK_ENTRIES entries (zero is fine with
 *  `done: true`, to release the lease); every value a finite number in
 *  [0, the field's cap] for a known field. */
export function parseAckBody(body: unknown): Parsed<AckBody> {
    if (!isPlainObject(body)) {
        return {
            ok: false,
            message: "The request body must be a JSON object.",
        };
    }
    const done = body.done ?? false;
    if (typeof done !== "boolean") {
        return { ok: false, message: "done must be true or false." };
    }
    const lease = body.lease_until;
    if (
        lease !== undefined &&
        lease !== null &&
        (typeof lease !== "string" ||
            lease.length > 64 ||
            !Number.isFinite(Date.parse(lease)))
    ) {
        return {
            ok: false,
            message: "lease_until must be the lease_until /pending returned.",
        };
    }
    const raw = body.entries ?? [];
    if (!Array.isArray(raw)) {
        return { ok: false, message: "entries must be an array." };
    }
    if (raw.length > HEALTH_SYNC_MAX_ACK_ENTRIES) {
        return {
            ok: false,
            message: `At most ${HEALTH_SYNC_MAX_ACK_ENTRIES} entries per request.`,
        };
    }
    const entries: AckEntry[] = [];
    for (const [i, e] of raw.entries()) {
        const where = `entries[${i}]`;
        if (!isPlainObject(e)) {
            return { ok: false, message: `${where} must be an object.` };
        }
        const id = typeof e.entry_id === "string" ? e.entry_id : "";
        const parsed = parseEntryId(id);
        if (!parsed) {
            return {
                ok: false,
                message: `${where}.entry_id must be an entry_id from /pending.`,
            };
        }
        if (e.date !== parsed.date) {
            return {
                ok: false,
                message: `${where}.date must match its entry_id.`,
            };
        }
        if (!isPlainObject(e.values)) {
            return { ok: false, message: `${where}.values must be an object.` };
        }
        const values: DayValues = {};
        for (const [k, v] of Object.entries(e.values)) {
            if (!isHealthSyncField(k)) {
                return {
                    ok: false,
                    message: `${where}.values.${k} is not a field this server syncs.`,
                };
            }
            const max = HEALTH_SYNC_FIELD_SPECS[k].ackMax;
            if (
                typeof v !== "number" ||
                !Number.isFinite(v) ||
                v < 0 ||
                v > max
            ) {
                return {
                    ok: false,
                    message: `${where}.values.${k} must be a number from 0 to ${max}.`,
                };
            }
            values[k] = v;
        }
        if (Object.keys(values).length === 0) {
            return { ok: false, message: `${where}.values is empty.` };
        }
        entries.push({ entry_id: id, date: parsed.date, values });
    }
    const value: AckBody = { entries, done };
    if (typeof lease === "string") value.lease_until = lease;
    return { ok: true, value };
}
