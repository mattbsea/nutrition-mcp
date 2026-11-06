/** Row and input shapes of the SQLite persistence layer. */
import type { LengthUnit, WeightUnit, BodyMeasurementKind } from "../units.js";
import type { DrinkUnit } from "../alcohol.js";
import type { ActivityEntry } from "../activity.js";
import type {
    MealItemValues,
    MealNutrientKey,
    NutrientValues,
} from "../meal-items.js";
import type { NutrientSources, SourceDetail } from "../provenance.js";

// ---------- Core nutrition rows ----------

export interface Meal {
    id: string;
    user_id: string;
    logged_at: string;
    meal_type: string | null;
    description: string;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    // Saturated and trans fat, grams, both inside fat_g. NULL means not
    // recorded (rows logged before the columns existed, or a call that did not
    // give the value), never 0. Trans fat has no goal; saturated fat has a
    // daily ceiling (see NutritionGoals).
    saturated_fat_g?: number | null;
    trans_fat_g?: number | null;
    // Total sugars (not added sugar); alcohol is pure ethanol in grams.
    fiber_g: number | null;
    sugar_g: number | null;
    // Added sugars (US label definition), part of sugar_g and never more than
    // it. NULL means not recorded — rows logged before the column existed
    // stay NULL and read as "not recorded", never as 0.
    added_sugar_g: number | null;
    alcohol_g: number | null;
    // MILLIGRAMS, unlike every other nutrient here — labels and guidelines are
    // all stated in mg, so the unit rides in the name at every layer.
    // Contributes no energy: never feed this into a kcal derivation.
    caffeine_mg: number | null;
    // Sodium (not salt), MILLIGRAMS like caffeine. NULL means not recorded,
    // never 0: rows logged before the column existed stay NULL. Carries a
    // daily ceiling (see NutritionGoals.daily_sodium_mg).
    sodium_mg?: number | null;
    notes: string | null;
    idempotency_key: string | null;
    // The saved meal this row was logged from (log_saved_meal), or null. Set
    // null again when that saved meal is deleted: the logged row keeps its
    // values, only the link goes.
    saved_meal_id: string | null;
    // Where each nutrient came from (src/provenance.ts) and the records those
    // labels point at. NULL on rows written before provenance existed; never
    // back-labelled.
    nutrient_sources?: NutrientSources | null;
    source_detail?: SourceDetail | null;
}

export interface MealInput {
    description: string;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    // See Meal.saturated_fat_g.
    saturated_fat_g?: number;
    trans_fat_g?: number;
    fiber_g?: number;
    sugar_g?: number;
    // See Meal.added_sugar_g.
    added_sugar_g?: number;
    alcohol_g?: number;
    // Milligrams — see Meal.caffeine_mg.
    caffeine_mg?: number;
    // Milligrams — see Meal.sodium_mg.
    sodium_mg?: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
    // Ingredients (src/meal-items.ts), already validated and summed: when
    // given, the nutrient fields above ARE their sum. Written as meal_items
    // rows in the same transaction as the meal.
    items?: MealItemValues[];
    // The saved meal this entry is copied from (log_saved_meal).
    saved_meal_id?: string;
    // Provenance of the nutrient fields above (see Meal.nutrient_sources).
    // Already verified and labelled by the caller; written as given. Not part
    // of the idempotency digest.
    nutrient_sources?: NutrientSources | null;
    source_detail?: SourceDetail | null;
}

export interface MealInsertResult {
    meal: Meal;
    deduplicated: boolean;
}

export interface SavedMeal extends NutrientValues {
    id: string;
    user_id: string;
    name: string;
    description: string;
    meal_type: string | null;
    created_at: string;
    updated_at: string;
    // Provenance of the nutrient values (see Meal.nutrient_sources).
    nutrient_sources?: NutrientSources | null;
    source_detail?: SourceDetail | null;
}

export interface SavedMealWithItems extends SavedMeal {
    items: MealItemValues[];
}

export interface SavedMealInput extends Partial<NutrientValues> {
    name: string;
    description: string;
    meal_type: string | null;
    nutrient_sources?: NutrientSources | null;
    source_detail?: SourceDetail | null;
}

export interface MealItemRow extends MealItemValues {
    id: string;
    meal_id: string;
    user_id: string;
}

export interface SavedMealItemRow extends MealItemValues {
    id: string;
    saved_meal_id: string;
    user_id: string;
}

export interface Profile {
    user_id: string;
    // null means "never set with set_timezone" — the column has no default
    // to fall back on that would be distinguishable from a deliberate
    // choice, so every reader must coalesce this explicitly (see
    // timezoneFromProfile / getUserTimezone below). Do not read this
    // directly to decide whether a timezone is "configured" outside those
    // two: that was #99 — a row can exist (any set_* tool creates one) with
    // this still null.
    timezone: string | null;
    preferred_weight_unit: WeightUnit | null;
    // null = never set with set_length_unit; same contract as preferred_weight_unit.
    // Coalesce through preferredLengthUnitFromProfile. Never derived from the weight unit.
    preferred_length_unit: LengthUnit | null;
    widgets_enabled: boolean;
    alcohol_tracking_enabled: boolean;
    preferred_drink_unit: DrinkUnit | null;
    // Share of active calories counted against intake, 0..100; null = never
    // set, which reads as 100. Coalesce through activityCreditPctFromProfile.
    activity_credit_pct: number | null;
    // null means "never set with set_language" — same null-is-not-a-default
    // contract as timezone above. Always coalesce through localeFromProfile /
    // getUserLocale, never read this directly.
    locale: string | null;
    created_at: string;
    updated_at: string;
}

export interface NutritionGoals {
    user_id: string;
    daily_calories: number | null;
    daily_protein_g: number | null;
    daily_carbs_g: number | null;
    daily_fat_g: number | null;
    // Saturated fat is a ceiling like sugar (0 is a real limit, "none").
    // Trans fat has no goal.
    daily_saturated_fat_g?: number | null;
    daily_fiber_g: number | null;
    // Total sugars, and pure ethanol. Both are ceilings ("stay under"), unlike
    // every other goal here, which is a floor — see formatGoalLine in mcp.ts.
    daily_sugar_g: number | null;
    // Added sugars only (see Meal.added_sugar_g), a ceiling like sugar; 0 is a
    // real limit ("none").
    daily_added_sugar_g: number | null;
    daily_alcohol_g: number | null;
    // Milligrams, and a ceiling too — 0 means "none". numeric(7,2) in the DB,
    // since mg targets run three orders larger than the gram ones above.
    daily_caffeine_mg: number | null;
    // Milligrams, a ceiling like caffeine (0 is a real limit). numeric(7,2),
    // like daily_caffeine_mg.
    daily_sodium_mg?: number | null;
    daily_water_ml: number | null;
    target_weight_g: number | null;
    updated_at: string;
}

export interface NutritionGoalsInput {
    daily_calories?: number | null;
    daily_protein_g?: number | null;
    daily_carbs_g?: number | null;
    daily_fat_g?: number | null;
    daily_saturated_fat_g?: number | null;
    daily_fiber_g?: number | null;
    daily_sugar_g?: number | null;
    daily_added_sugar_g?: number | null;
    daily_alcohol_g?: number | null;
    daily_caffeine_mg?: number | null;
    daily_sodium_mg?: number | null;
    daily_water_ml?: number | null;
    target_weight_g?: number | null;
}

export interface WaterEntry {
    id: string;
    user_id: string;
    amount_ml: number;
    logged_at: string;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
}

export interface WaterInput {
    amount_ml: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface WaterInsertResult {
    entry: WaterEntry;
    deduplicated: boolean;
}

export interface ActiveCaloriesEntry extends ActivityEntry {
    id: string;
    user_id: string;
    logged_at: string;
    kcal: number;
    /** Snapshot of the profile's credit percentage when this row was written. */
    credit_pct: number;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
    /** "apple_health" for a day total the activity sync wrote; null when
     *  logged by hand. Absent on rows read before the column existed. */
    source?: string | null;
    /** The local date an Apple Health day total covers; null otherwise. */
    source_date?: string | null;
}

export interface ActiveCaloriesInput {
    kcal: number;
    credit_pct: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface ActiveCaloriesInsertResult {
    entry: ActiveCaloriesEntry;
    deduplicated: boolean;
}

export interface HealthActivityDayWrite {
    date: string;
    kcal: number;
    logged_at: string;
    credit_pct: number;
}

export interface WeightEntry {
    id: string;
    user_id: string;
    weight_g: number;
    logged_at: string;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
}

export interface WeightInput {
    weight_g: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface WeightInsertResult {
    entry: WeightEntry;
    deduplicated: boolean;
}

export interface BodyMeasurementEntry {
    id: string;
    user_id: string;
    kind: BodyMeasurementKind;
    // Canonical value; every conversion and comparison reads this.
    value_mm: number;
    // Exactly what the user typed, in entered_unit — shown back verbatim when
    // displaying in that unit. A `numeric` column, which PostgREST may return
    // as a string, so readers wrap it in Number().
    value_entered: number;
    entered_unit: LengthUnit;
    logged_at: string;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
}

export interface BodyMeasurementInput {
    kind: BodyMeasurementKind;
    value_mm: number;
    value_entered: number;
    entered_unit: LengthUnit;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface BodyMeasurementInsertResult {
    entry: BodyMeasurementEntry;
    deduplicated: boolean;
}

export type MealFieldUpdate = Partial<Omit<MealInput, MealNutrientKey>> &
    Partial<Record<MealNutrientKey, number | null>>;

/** The stored values a write was computed from: every nutrient column of a
 *  meal or saved meal, and its two label columns. A write conditional on this
 *  snapshot only lands while the row still holds exactly these values.
 *  `null` means IS NULL; an object label compares as JSON. */
export type MealSnapshotGuard = Partial<
    Record<MealNutrientKey, number | null>
> & {
    nutrient_sources?: unknown;
    source_detail?: unknown;
};

// ---------- Apple Health sync ----------

/** health_sync_pending without its hash columns. */
export interface HealthSyncPendingRow {
    id: string;
    /** Which shortcut started the connect: the original Apple Health sync,
     *  or the opt-in activity shortcut. Rows written before the column
     *  existed read as "health" (the migration's default). */
    kind: HealthSyncConnectKind;
    fields: string[];
    tz: string | null;
    backfill_days: number;
    /** Cleared once the claim code is minted. */
    pkce_verifier: string | null;
    /** Set, with claim_expires_at, once the browser finished sign-in. */
    user_id: string | null;
    claim_expires_at: string | null;
    created_at: string;
    expires_at: string;
}

/** health_sync_links without token_hash. */
export interface HealthSyncLinkRow {
    id: string;
    user_id: string;
    kind: "shortcut";
    fields: string[];
    fallback_tz: string | null;
    /** YYYY-MM-DD: days on or after it are eligible. */
    sync_start_date: string;
    lease_until: string | null;
    created_at: string;
    last_used_at: string | null;
    last_sync_at: string | null;
    expires_at: string;
}

/** One health_sync_days row. */
export interface HealthSyncDayRow {
    user_id: string;
    /** YYYY-MM-DD, local to `timezone`. */
    date: string;
    timezone: string;
    /** null until the day's initial entry is acknowledged. */
    sent_values: Record<string, number> | null;
    topup_seq: number;
    offer_count: number;
    notified: Record<string, unknown>;
    first_sent_at: string | null;
    last_sent_at: string | null;
}

/** The columns updateDay may write. */
export type HealthSyncDayPatch = Partial<
    Pick<
        HealthSyncDayRow,
        | "timezone"
        | "sent_values"
        | "topup_seq"
        | "offer_count"
        | "notified"
        | "first_sent_at"
        | "last_sent_at"
    >
>;

/** The state updateDay requires the row to still be in. */
export interface HealthSyncDayExpect {
    topup_seq: number;
    /** Whether `sent_values` was null when the caller read the row. */
    sentNull: boolean;
}

export type HealthSyncConnectKind = "health" | "activity";

export interface NewPendingConnection {
    kind: HealthSyncConnectKind;
    connectId: string;
    deviceSecret: string;
    pkceVerifier: string;
    fields: string[];
    tz: string | null;
    backfillDays: number;
    expiresAt: string;
}

export interface NewLink {
    fields: string[];
    fallbackTz: string | null;
    syncStartDate: string;
    expiresAt: string;
}

export type HealthSyncLinkLookup =
    | { status: "valid"; link: HealthSyncLinkRow }
    | { status: "invalid" }
    | { status: "unavailable" };

/** What get_profile and the export show about a link. Never a token hash. */
export interface HealthSyncLinkStatus {
    kind: "shortcut";
    fields: string[];
    fallback_tz: string | null;
    sync_start_date: string;
    created_at: string;
    last_used_at: string | null;
    last_sync_at: string | null;
    expires_at: string;
    /** Latest date whose initial entry was acknowledged, or null. */
    sent_through: string | null;
}

export interface HealthSyncStore {
    createPending(input: NewPendingConnection): Promise<void>;
    /** An unexpired pending row, claimed or not; null when none. */
    getPendingByConnectId(
        connectId: string,
        now?: Date,
    ): Promise<HealthSyncPendingRow | null>;
    /**
     * Attach the signed-in user and a claim code to an unexpired, still
     * unclaimed pending row, clearing its PKCE verifier. False when no such
     * row (expired, unknown, or another callback claimed it first).
     */
    setPendingClaim(
        connectId: string,
        claimCode: string,
        userId: string,
        claimExpiresAt: string,
        now?: Date,
    ): Promise<boolean>;
    /**
     * Atomically delete and return the pending row matching BOTH the claim
     * code and the device secret, if its claim is unexpired. Single-use.
     */
    consumeClaim(
        claimCode: string,
        deviceSecret: string,
        now?: Date,
    ): Promise<HealthSyncPendingRow | null>;
    /** The user's link, replaced wholesale (one statement, keyed on user_id). */
    replaceLink(userId: string, link: NewLink, token: string): Promise<void>;
    lookupLink(token: string, now?: Date): Promise<HealthSyncLinkLookup>;
    /** Stamp last_used_at and the slid expiry. The caller throttles. */
    touchLink(
        userId: string,
        lastUsedAt: string,
        expiresAt: string,
    ): Promise<void>;
    setLastSync(userId: string, at: string): Promise<void>;
    /**
     * Take the sync lease when it is free or lapsed, in one conditional
     * update, so two concurrent syncs can't both win. True when taken.
     */
    acquireLease(userId: string, until: string, now?: Date): Promise<boolean>;
    /** Free the lease; with `heldUntil`, only if it is still that lease. */
    releaseLease(userId: string, heldUntil?: string): Promise<void>;
    /** Day rows with from <= date <= to (YYYY-MM-DD), by date. */
    getDays(
        userId: string,
        from: string,
        to: string,
    ): Promise<HealthSyncDayRow[]>;
    /**
     * Insert day rows that do not exist yet; a (user, date) that already has
     * a row is left exactly as it is. Returns the dates actually inserted.
     */
    insertDays(rows: HealthSyncDayRow[]): Promise<string[]>;
    /**
     * Write `patch` to one day row only if it is still in the state the
     * caller read: the same `topup_seq`, and `sent_values` still null or
     * still set. False when the row moved on (or is gone) in between — an
     * ack and a /pending of two runs never overwrite each other's work,
     * since neither writes a whole row it read earlier.
     */
    updateDay(
        userId: string,
        date: string,
        patch: HealthSyncDayPatch,
        expect: HealthSyncDayExpect,
    ): Promise<boolean>;
    /** Remove the user's link and every sent-values row. */
    deleteLink(userId: string): Promise<void>;
    /** The user's link while it still works — past its sliding expiry or its
     *  365-day cap it is reported as none, exactly as lookupLink refuses it,
     *  even before the hourly sweep deletes it. */
    getLinkStatus(
        userId: string,
        now?: Date,
    ): Promise<HealthSyncLinkStatus | null>;
    getDaysForExport(userId: string): Promise<HealthSyncDayRow[]>;
}

export interface HealthSyncCleanupStore {
    /**
     * Pending rows whose connect window lapsed unclaimed, or whose claim code
     * lapsed unredeemed. A claimed row lives by claim_expires_at alone, since
     * a claim minted late in the 30 minutes may outlast expires_at.
     */
    deleteExpiredPending(nowIso: string): Promise<number>;
    /** Links past their sliding expiry or created before `createdBeforeIso`. */
    deleteExpiredLinks(
        nowIso: string,
        createdBeforeIso: string,
    ): Promise<number>;
    /** Sent-values rows dated strictly before `beforeDate` (YYYY-MM-DD). */
    deleteDaysBefore(beforeDate: string): Promise<number>;
    /** Activity links past their sliding expiry or created before
     *  `createdBeforeIso` — the same two bounds as deleteExpiredLinks. */
    deleteExpiredActivityLinks(
        nowIso: string,
        createdBeforeIso: string,
    ): Promise<number>;
}

export interface HealthActivityLinkRow {
    id: string;
    user_id: string;
    fallback_tz: string | null;
    created_at: string;
    last_used_at: string | null;
    last_sync_at: string | null;
    expires_at: string;
}

export type HealthActivityLinkLookup =
    | { status: "valid"; link: HealthActivityLinkRow }
    | { status: "invalid" }
    | { status: "unavailable" };

/** What get_profile and the export show about an activity link. */
export type HealthActivityLinkStatus = Omit<
    HealthActivityLinkRow,
    "id" | "user_id"
>;

export interface HealthActivityLinkStore {
    /** The user's activity link, replaced wholesale (upsert on user_id). */
    replaceActivityLink(
        userId: string,
        link: { fallbackTz: string | null; expiresAt: string },
        token: string,
    ): Promise<void>;
    lookupActivityLink(
        token: string,
        now?: Date,
    ): Promise<HealthActivityLinkLookup>;
    /** Stamp last_used_at and the slid expiry. The caller throttles. */
    touchActivityLink(
        userId: string,
        lastUsedAt: string,
        expiresAt: string,
    ): Promise<void>;
    /** Stamp the last sync, and the phone's zone it reported. */
    setActivitySynced(
        userId: string,
        at: string,
        fallbackTz: string | null,
    ): Promise<void>;
    deleteActivityLink(userId: string): Promise<void>;
    /** The link while it still works (same bounds as the lookup), or null. */
    getActivityLinkStatus(
        userId: string,
        now?: Date,
    ): Promise<HealthActivityLinkStatus | null>;
}
