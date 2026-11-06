/**
 * Reads behind Apple Health sync: the plan for the next /pending and the sync
 * status the dashboard and GET /status show. Both come from the same
 * computation, so the dashboard's "pending" is exactly what the next run would
 * be offered.
 */
import {
    OWNER_ID,
    createSqliteHealthSyncStore,
    getMealsInRange,
    getProfile,
    getWaterInRange,
    timezoneFromProfile,
    type HealthSyncStateRow,
    type HealthSyncStore,
} from "./db/repo.js";
import {
    computeDayTotals,
    effectiveTimezone,
    fieldsFor,
    planIntraday,
    windowDates,
    type DayStatus,
    type Discrepancy,
    type HealthSyncField,
    type HealthSyncMeal,
    type HealthSyncWater,
    type IntradayPlan,
    type TimezoneSource,
} from "./health-sync.js";

/** The user data /pending reads. Injectable so route tests can run on fakes;
 *  the default is src/db/repo.ts. */
export interface HealthSyncData {
    /** The profile's own timezone, null when never set. */
    getProfileTimezone(userId: string): Promise<string | null>;
    getMeals(
        userId: string,
        from: string,
        to: string,
        tz: string,
    ): Promise<HealthSyncMeal[]>;
    getWater(
        userId: string,
        from: string,
        to: string,
        tz: string,
    ): Promise<HealthSyncWater[]>;
}

export const repoHealthSyncData: HealthSyncData = {
    async getProfileTimezone(userId) {
        return timezoneFromProfile(await getProfile(userId));
    },
    getMeals: getMealsInRange,
    getWater: getWaterInRange,
};

export interface ComputedPlan extends IntradayPlan {
    timezone: string;
    timezone_source: TimezoneSource;
    fields: HealthSyncField[];
    now: Date;
}

/**
 * The plan for `now`. Fails closed: if any read throws, nothing is returned —
 * a partial read would offer a day's total that is too low, and Health cannot
 * lower a value once it is written.
 *
 * `includeWater`: true/false as the caller asked, or "auto" (status views):
 * water is included when the ledger already holds water for the window.
 */
export async function computePlan(
    userId: string,
    opts: {
        now: Date;
        phoneTz?: string | null;
        includeWater: boolean | "auto";
        store: HealthSyncStore;
        data: HealthSyncData;
    },
): Promise<ComputedPlan> {
    const { now, store, data } = opts;
    const profileTz = await data.getProfileTimezone(userId);
    const { tz, source } = effectiveTimezone(profileTz, opts.phoneTz);
    const dates = windowDates(now, tz);
    const from = dates[0]!;
    const to = dates[dates.length - 1]!;
    const ledger = await store.getDays(userId, from, to);
    const includeWater =
        opts.includeWater === "auto"
            ? ledger.some((d) => d.sent.water_ml !== undefined)
            : opts.includeWater;
    const fields = fieldsFor(includeWater);
    const [meals, water] = await Promise.all([
        data.getMeals(userId, from, to, tz),
        includeWater
            ? data.getWater(userId, from, to, tz)
            : Promise.resolve([] as HealthSyncWater[]),
    ]);
    const totals = computeDayTotals(meals, water, tz, dates);
    const plan = planIntraday({ now, tz, totals, ledger, fields });
    return { ...plan, timezone: tz, timezone_source: source, fields, now };
}

export interface HealthSyncStatus extends HealthSyncStateRow {
    timezone: string;
    timezone_source: TimezoneSource;
    window: { from: string; to: string };
    /** Per window day: logged vs sent vs what the next run would add. */
    days: DayStatus[];
    /** Days whose logged total is below what Health already holds. */
    discrepancies: Discrepancy[];
    /** How many entries the next /pending would offer. */
    pending_entries: number;
    notices: string[];
}

/** Sync status for the dashboard and GET /status. Read-only. */
export async function getHealthSyncStatus(
    opts: {
        userId?: string;
        now?: Date;
        includeWater?: boolean | "auto";
        store?: HealthSyncStore;
        data?: HealthSyncData;
    } = {},
): Promise<HealthSyncStatus> {
    const userId = opts.userId ?? OWNER_ID;
    const store = opts.store ?? createSqliteHealthSyncStore();
    const plan = await computePlan(userId, {
        now: opts.now ?? new Date(),
        includeWater: opts.includeWater ?? "auto",
        store,
        data: opts.data ?? repoHealthSyncData,
    });
    const state = await store.getState(userId);
    return {
        ...state,
        timezone: plan.timezone,
        timezone_source: plan.timezone_source,
        window: {
            from: plan.dates[0]!,
            to: plan.dates[plan.dates.length - 1]!,
        },
        days: plan.days,
        discrepancies: plan.discrepancies,
        pending_entries: plan.entries.length,
        notices: plan.notices,
    };
}
