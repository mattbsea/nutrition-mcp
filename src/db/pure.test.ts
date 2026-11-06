// Ported from src/supabase.test.ts: the pure-function blocks (idempotency key
// digests, profile derivations, export names, paging helpers, isUuid), pointed
// at the SQLite layer so its exports are proven to behave like the originals.
import { test, expect, describe } from "bun:test";
import {
    mealIdempotencyKey,
    updatedMealIdempotencyKey,
    widgetsEnabledFromProfile,
    alcoholTrackingEnabledFromProfile,
    preferredDrinkUnitFromProfile,
    preferredLengthUnitFromProfile,
    bodyMeasurementIdempotencyKey,
    timezoneFromProfile,
    fetchAllPages,
    assertWindowComplete,
    isUuid,
    exportArchivePath,
    exportStoragePaths,
    type Meal,
    type MealInput,
    type Profile,
} from "./repo.js";
import { rowContentDigest } from "../import.js";
import { validateItems } from "../meal-items.js";
import { ToolError } from "../errors.js";

const USER = "11111111-1111-4111-8111-111111111111";
const LOGGED_AT = "2026-03-14T12:00:00.000Z";

function meal(overrides: Partial<MealInput> = {}): MealInput {
    return {
        description: "oat porridge with berries",
        meal_type: "breakfast",
        calories: 300,
        protein_g: 12,
        carbs_g: 45,
        fat_g: 8,
        notes: "made with milk",
        ...overrides,
    };
}

function key(input: MealInput, userId = USER, loggedAt = LOGGED_AT): string {
    return mealIdempotencyKey(userId, input, loggedAt);
}

describe("mealIdempotencyKey", () => {
    test("fiber, sugar, alcohol and caffeine are EXCLUDED from the derived key", () => {
        const base = meal();
        const withNewFields = meal({
            fiber_g: 6.2,
            sugar_g: 14.5,
            alcohol_g: 3.1,
            caffeine_mg: 95,
        });

        // The whole point of the frozen array: adding one of the four
        // non-macro columns to it would change the key of every future write,
        // so a user re-logging or re-importing something they already have
        // would get a duplicate row instead of a clean no-op — and every
        // "auto:" key already in the table would be orphaned.
        expect(key(withNewFields)).toBe(key(base));

        // Negative control — this test must be able to fail. A field that IS
        // hashed changes the key, proving the assertion above is not just
        // "every input produces the same key".
        expect(key(meal({ calories: 301 }))).not.toBe(key(base));
    });

    test("each new field is excluded on its own, not just in combination", () => {
        const base = key(meal());
        expect(key(meal({ fiber_g: 6.2 }))).toBe(base);
        expect(key(meal({ sugar_g: 14.5 }))).toBe(base);
        expect(key(meal({ alcohol_g: 3.1 }))).toBe(base);
        expect(key(meal({ caffeine_mg: 95 }))).toBe(base);
        // Zero is not the same as absent to a hasher that stringifies parts,
        // so pin it too: it must still be excluded.
        expect(
            key(
                meal({
                    fiber_g: 0,
                    sugar_g: 0,
                    alcohol_g: 0,
                    caffeine_mg: 0,
                }),
            ),
        ).toBe(base);
    });

    test("added_sugar_g is EXCLUDED from the derived key too", () => {
        // Same frozen-array rule as the four columns above: adding it would
        // re-key every future write and turn a replayed log or import into a
        // duplicate row.
        const base = key(meal());
        expect(key(meal({ added_sugar_g: 9.5 }))).toBe(base);
        expect(key(meal({ added_sugar_g: 0 }))).toBe(base);
        expect(key(meal({ sugar_g: 14.5, added_sugar_g: 9.5 }))).toBe(base);
        // And the mirror in src/import.ts still agrees with it.
        expect(key(meal({ logged_at: LOGGED_AT, added_sugar_g: 9.5 }))).toBe(
            `auto:${rowContentDigest(USER, meal({ logged_at: LOGGED_AT, added_sugar_g: 9.5 }))}`,
        );
    });

    test("two coffees differing only in caffeine dedupe to one — the accepted cost", () => {
        // Same trade as fiber above, restated for the mg column because it is
        // the one whose values a user is most likely to tune after the fact
        // (a single vs a double shot logged under the same description).
        expect(key(meal({ caffeine_mg: 63 }))).toBe(
            key(meal({ caffeine_mg: 126 })),
        );
    });

    test("two meals differing only in fiber dedupe to one — the accepted cost", () => {
        // Documented in CONTRACT §2 and in the comment on the array: this is a
        // deliberate trade, not an oversight. A caller who needs the rows kept
        // apart passes an explicit idempotency_key.
        expect(key(meal({ fiber_g: 1 }))).toBe(key(meal({ fiber_g: 99 })));
    });

    test("every field that IS hashed changes the key", () => {
        const base = key(meal());
        const variants: [string, MealInput][] = [
            ["description", meal({ description: "oat porridge" })],
            ["meal_type", meal({ meal_type: "snack" })],
            ["calories", meal({ calories: 301 })],
            ["protein_g", meal({ protein_g: 12.5 })],
            ["carbs_g", meal({ carbs_g: 46 })],
            ["fat_g", meal({ fat_g: 8.5 })],
            ["notes", meal({ notes: "made with water" })],
        ];
        for (const [label, input] of variants) {
            expect(`${label}:${key(input)}`).not.toBe(`${label}:${base}`);
        }

        // The two arguments outside MealInput matter as much: without userId
        // two users' identical meals would collide, and without logged_at the
        // same breakfast eaten on two days would dedupe into one.
        expect(key(meal(), "22222222-2222-4222-8222-222222222222")).not.toBe(
            base,
        );
        expect(key(meal(), USER, "2026-03-15T12:00:00.000Z")).not.toBe(base);
    });

    test("is deterministic and marked as server-derived", () => {
        expect(key(meal())).toBe(key(meal()));
        expect(key(meal())).toMatch(/^auto:[0-9a-f]{64}$/);
    });

    test("an absent field and an explicitly null-ish one hash alike", () => {
        // parts.map(p => p ?? "") — undefined and null collapse to the same
        // empty segment, so an omitted note and a cleared note dedupe together.
        expect(key(meal({ notes: undefined }))).toBe(
            key({ ...meal(), notes: undefined }),
        );
    });

    test("stays in step with rowContentDigest in src/import.ts", () => {
        // The two frozen arrays are mirrors: same fields, same order, same
        // hash. If either drifts, meals written through log_meal and the same
        // meals written through bulk_import_meals stop deduping against each
        // other. Both are frozen by CONTRACT §2.
        const input = meal({
            logged_at: LOGGED_AT,
            fiber_g: 6.2,
            sugar_g: 14.5,
            alcohol_g: 3.1,
            caffeine_mg: 95,
        });
        expect(key(input)).toBe(`auto:${rowContentDigest(USER, input)}`);
    });
});

function existingMeal(overrides: Partial<Meal> = {}): Meal {
    return {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: USER,
        logged_at: LOGGED_AT,
        meal_type: "breakfast",
        description: "oat porridge with berries",
        calories: 300,
        protein_g: 12,
        carbs_g: 45,
        fat_g: 8,
        fiber_g: null,
        sugar_g: null,
        added_sugar_g: null,
        alcohol_g: null,
        caffeine_mg: null,
        notes: "made with milk",
        idempotency_key: key(meal()),
        saved_meal_id: null,
        ...overrides,
    };
}

describe("updatedMealIdempotencyKey", () => {
    test("recomputes the digest when an edit changes content, for an auto: key", () => {
        const existing = existingMeal();
        const updated = updatedMealIdempotencyKey(USER, existing, {
            calories: 600,
        });

        expect(updated).not.toBeNull();
        // Differs from the pre-edit row's key...
        expect(updated).not.toBe(existing.idempotency_key);
        // ...and from what the ORIGINAL (pre-edit) content would still hash to
        // — this is the #84 replay case: a replay of the original log_meal
        // call must no longer dedupe onto the corrected row.
        expect(updated).not.toBe(key(meal()));
        // It matches recomputing over the merged (post-edit) content.
        expect(updated).toBe(key(meal({ calories: 600 })));
    });

    test("a caller-supplied idempotency_key is left untouched", () => {
        const existing = existingMeal({
            idempotency_key: "client-supplied-key-123",
        });
        expect(
            updatedMealIdempotencyKey(USER, existing, { calories: 600 }),
        ).toBeNull();
    });

    test("a row with idempotency_key: null returns null", () => {
        const existing = existingMeal({ idempotency_key: null });
        expect(
            updatedMealIdempotencyKey(USER, existing, { calories: 600 }),
        ).toBeNull();
    });

    test("fields not passed in the update fall back to the existing row's content", () => {
        const existing = existingMeal();
        const updated = updatedMealIdempotencyKey(USER, existing, {
            notes: "made with oat milk",
        });

        expect(updated).toBe(key(meal({ notes: "made with oat milk" })));
    });

    test("editing fiber_g/sugar_g/alcohol_g/caffeine_mg alone does not change the recomputed key", () => {
        const existing = existingMeal();
        const updated = updatedMealIdempotencyKey(USER, existing, {
            fiber_g: 6.2,
            sugar_g: 14.5,
            alcohol_g: 3.1,
            caffeine_mg: 95,
        });

        expect(updated).toBe(existing.idempotency_key);
    });

    test("backfilling added_sugar_g alone does not change the recomputed key", () => {
        const existing = existingMeal({ sugar_g: 14.5 });
        expect(
            updatedMealIdempotencyKey(USER, existing, { added_sugar_g: 9.5 }),
        ).toBe(existing.idempotency_key);
    });

    test("editing logged_at changes the key to match the new timestamp", () => {
        const existing = existingMeal();
        const newLoggedAt = "2026-03-15T12:00:00.000Z";
        const updated = updatedMealIdempotencyKey(USER, existing, {
            logged_at: newLoggedAt,
        });

        expect(updated).toBe(key(meal(), USER, newLoggedAt));
    });

    test("an existing row's logged_at in PostgREST's +00:00 form recomputes the same key a fresh identical log_meal call would produce", () => {
        // PostgREST renders timestamptz as "+00:00" (and drops an all-zero
        // fractional part), never as the "Z"-suffixed, millisecond-padded
        // form every write path hashes with. A row fetched back from the DB
        // carries the former; verify the fallback canonicalizes it before
        // hashing, rather than baking the DB's rendering into the key.
        const existing = existingMeal({
            logged_at: "2026-03-14T12:00:00+00:00",
        });
        const updated = updatedMealIdempotencyKey(USER, existing, {
            calories: 600,
        });

        expect(updated).toBe(key(meal({ calories: 600 })));
    });
});

// ---------- Profile-derived display preferences ----------

function profile(overrides: Partial<Profile> = {}): Profile {
    return {
        user_id: USER,
        timezone: "Europe/Kyiv",
        preferred_weight_unit: "kg",
        preferred_length_unit: null,
        widgets_enabled: true,
        alcohol_tracking_enabled: false,
        preferred_drink_unit: null,
        activity_credit_pct: null,
        locale: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

// A row written before the column existed: present in the DB, absent from the
// JSON, so the property reads as undefined at runtime despite the type.
function withoutColumn(column: keyof Profile): Profile {
    const row = profile();
    delete (row as unknown as Record<string, unknown>)[column];
    return row;
}

describe("widgetsEnabledFromProfile", () => {
    test("defaults to true when there is no profile row", () => {
        expect(widgetsEnabledFromProfile(null)).toBe(true);
        expect(widgetsEnabledFromProfile(undefined)).toBe(true);
    });

    test("defaults to true when the column is absent", () => {
        expect(
            widgetsEnabledFromProfile(withoutColumn("widgets_enabled")),
        ).toBe(true);
    });

    test("honours an explicit opt-out", () => {
        expect(
            widgetsEnabledFromProfile(profile({ widgets_enabled: false })),
        ).toBe(false);
        expect(
            widgetsEnabledFromProfile(profile({ widgets_enabled: true })),
        ).toBe(true);
    });
});

describe("alcoholTrackingEnabledFromProfile", () => {
    test("defaults to FALSE when there is no profile row — alcohol is opt-in", () => {
        // CONTRACT §7. Flipping this default to true turns the opt-in into an
        // opt-out and surfaces alcohol — including the trace alcohol recipe
        // exports carry — to users who never asked to see it.
        expect(alcoholTrackingEnabledFromProfile(null)).toBe(false);
        expect(alcoholTrackingEnabledFromProfile(undefined)).toBe(false);
    });

    test("defaults to false when the column is absent", () => {
        expect(
            alcoholTrackingEnabledFromProfile(
                withoutColumn("alcohol_tracking_enabled"),
            ),
        ).toBe(false);
    });

    test("an existing profile that never opted in stays off", () => {
        expect(
            alcoholTrackingEnabledFromProfile(
                profile({ alcohol_tracking_enabled: false }),
            ),
        ).toBe(false);
    });

    test("honours an explicit opt-in", () => {
        expect(
            alcoholTrackingEnabledFromProfile(
                profile({ alcohol_tracking_enabled: true }),
            ),
        ).toBe(true);
    });
});

describe("preferredDrinkUnitFromProfile", () => {
    test("returns null when there is no profile row or no preference", () => {
        expect(preferredDrinkUnitFromProfile(null)).toBeNull();
        expect(preferredDrinkUnitFromProfile(undefined)).toBeNull();
        expect(
            preferredDrinkUnitFromProfile(
                profile({ preferred_drink_unit: null }),
            ),
        ).toBeNull();
        expect(
            preferredDrinkUnitFromProfile(
                withoutColumn("preferred_drink_unit"),
            ),
        ).toBeNull();
    });

    test("returns a saved preference", () => {
        expect(
            preferredDrinkUnitFromProfile(
                profile({ preferred_drink_unit: "us" }),
            ),
        ).toBe("us");
        expect(
            preferredDrinkUnitFromProfile(
                profile({ preferred_drink_unit: "uk" }),
            ),
        ).toBe("uk");
    });

    test("degrades unrecognised column values to null", () => {
        // The isDrinkUnit guard is what keeps junk out of the
        // Record<DrinkUnit, …> lookups in src/alcohol.ts, where an unguarded
        // value would surface as NaN grams per drink rather than as a missing
        // preference.
        for (const junk of ["US", "UK", "pints", "", "usa", 1, true, {}]) {
            expect(
                preferredDrinkUnitFromProfile(
                    profile({
                        preferred_drink_unit: junk as never,
                    }),
                ),
            ).toBeNull();
        }
    });
});

describe("preferredLengthUnitFromProfile", () => {
    test("is null when never chosen", () => {
        expect(preferredLengthUnitFromProfile(null)).toBeNull();
        expect(preferredLengthUnitFromProfile(undefined)).toBeNull();
        expect(
            preferredLengthUnitFromProfile(
                profile({ preferred_length_unit: null }),
            ),
        ).toBeNull();
        expect(
            preferredLengthUnitFromProfile(
                withoutColumn("preferred_length_unit"),
            ),
        ).toBeNull();
    });

    test("returns a saved preference", () => {
        expect(
            preferredLengthUnitFromProfile(
                profile({ preferred_length_unit: "cm" }),
            ),
        ).toBe("cm");
        expect(
            preferredLengthUnitFromProfile(
                profile({ preferred_length_unit: "in" }),
            ),
        ).toBe("in");
    });

    test("degrades unrecognised column values to null", () => {
        for (const junk of ["mm", 'cm"', "CM", "", 1]) {
            expect(
                preferredLengthUnitFromProfile(
                    profile({ preferred_length_unit: junk as never }),
                ),
            ).toBeNull();
        }
    });

    test("is never derived from the weight unit", () => {
        expect(
            preferredLengthUnitFromProfile(
                profile({
                    preferred_weight_unit: "lb",
                    preferred_length_unit: null,
                }),
            ),
        ).toBeNull();
    });
});

describe("bodyMeasurementIdempotencyKey", () => {
    const base = { kind: "waist" as const, value_mm: 800, notes: undefined };

    test("is deterministic and server-prefixed", () => {
        const a = bodyMeasurementIdempotencyKey(USER, base, LOGGED_AT);
        expect(a).toBe(bodyMeasurementIdempotencyKey(USER, base, LOGGED_AT));
        expect(a.startsWith("auto:")).toBe(true);
    });

    test("waist and hips with the same value and instant are two rows", () => {
        expect(bodyMeasurementIdempotencyKey(USER, base, LOGGED_AT)).not.toBe(
            bodyMeasurementIdempotencyKey(
                USER,
                { ...base, kind: "hips" },
                LOGGED_AT,
            ),
        );
    });

    test("value_mm and logged_at change the key", () => {
        const a = bodyMeasurementIdempotencyKey(USER, base, LOGGED_AT);
        expect(
            bodyMeasurementIdempotencyKey(
                USER,
                { ...base, value_mm: 801 },
                LOGGED_AT,
            ),
        ).not.toBe(a);
        expect(
            bodyMeasurementIdempotencyKey(
                USER,
                base,
                "2026-03-14T12:00:01.000Z",
            ),
        ).not.toBe(a);
    });

    test("value_entered and entered_unit do not enter the key", () => {
        // 80 cm and 31.5 in of the same site are one 800 mm measurement.
        const asCm = { ...base, value_entered: 80, entered_unit: "cm" };
        const asIn = { ...base, value_entered: 31.5, entered_unit: "in" };
        expect(bodyMeasurementIdempotencyKey(USER, asCm, LOGGED_AT)).toBe(
            bodyMeasurementIdempotencyKey(USER, asIn, LOGGED_AT),
        );
    });

    test("insertBodyMeasurement decodes notes before hashing them", async () => {
        const body = fnBody(
            await Bun.file("./src/supabase.ts").text(),
            "insertBodyMeasurement",
        );
        const decode = body.indexOf("decodeEscapeSequences(");
        expect(decode).toBeGreaterThan(-1);
        expect(decode).toBeLessThan(
            body.indexOf("bodyMeasurementIdempotencyKey("),
        );
    });
});

describe("no-profile defaults, together", () => {
    test("a user with no profile row gets widgets on, alcohol off, no drink unit", () => {
        // The exact triple buildMcpServer derives from one getProfile call.
        expect({
            widgets: widgetsEnabledFromProfile(null),
            alcohol: alcoholTrackingEnabledFromProfile(null),
            drinkUnit: preferredDrinkUnitFromProfile(null),
        }).toEqual({ widgets: true, alcohol: false, drinkUnit: null });
    });
});

// #99: profiles.timezone is nullable specifically so "never chosen" is
// representable. Unlike the three preferences above, a profile ROW existing
// is not by itself evidence of a choice here — set_weight_unit,
// set_widget_display and set_alcohol_tracking all upsert a profile without
// ever touching timezone, so callers must key "configured" off this
// function's return value, never off `profile !== null`.
describe("timezoneFromProfile", () => {
    test("returns null when there is no profile row", () => {
        expect(timezoneFromProfile(null)).toBeNull();
        expect(timezoneFromProfile(undefined)).toBeNull();
    });

    // The realistic path into #99: a profile row exists (created by some
    // other set_* tool) but timezone was never explicitly set.
    test("returns null for an existing profile whose timezone was never set", () => {
        expect(timezoneFromProfile(profile({ timezone: null }))).toBeNull();
    });

    test("returns a saved timezone", () => {
        expect(timezoneFromProfile(profile({ timezone: "Asia/Tokyo" }))).toBe(
            "Asia/Tokyo",
        );
    });
});

// ---------- export storage keys ----------

// Deleting an account must not leave the export archive behind: it holds the
// user's entire history, `storage.remove` reports a missing path as success,
// and the signed URL they were handed keeps resolving for the rest of its
// hour. So the deletion list is asserted against the path the writer actually
// uses — the two were spelled out separately once, and renaming the archive
// from meals.csv to the .zip silently orphaned a full copy of everyone's data.
describe("exportStoragePaths", () => {
    test("covers the archive the exporter writes", () => {
        expect(exportStoragePaths("u1")).toContain(exportArchivePath("u1"));
    });

    test("keeps the pre-ZIP meals.csv so old exports are still cleaned up", () => {
        expect(exportStoragePaths("u1")).toContain("u1/meals.csv");
    });

    test("scopes every key to the user's own folder", () => {
        for (const path of exportStoragePaths("u1")) {
            expect(path.startsWith("u1/")).toBe(true);
        }
    });

    // The guard above is only worth anything if deletion actually routes
    // through it; inlining a path there again is the regression.
    test("deleteAllUserData removes exactly this list", async () => {
        const src = await Bun.file("./src/supabase.ts").text();
        const body = src.slice(
            src.indexOf("export async function deleteAllUserData"),
        );
        expect(body).toContain("exportStoragePaths(userId)");
    });

    test("deleteAllUserData removes body measurements", async () => {
        const src = await Bun.file("./src/supabase.ts").text();
        const body = src.slice(
            src.indexOf("export async function deleteAllUserData"),
        );
        expect(body).toContain('.from("body_measurement_log")');
    });

    // The link goes first so the Shortcut stops syncing (and writing another
    // sent-values row) while the rest of the account is being deleted.
    test("deleteAllUserData removes Apple Health sync first", async () => {
        const src = await Bun.file("./src/supabase.ts").text();
        const body = src.slice(
            src.indexOf("export async function deleteAllUserData"),
        );
        const at = (table: string) => body.indexOf(`.from("${table}")`);
        for (const table of [
            "health_sync_links",
            "health_sync_days",
            "health_sync_pending",
        ]) {
            expect(at(table), `${table} not deleted`).toBeGreaterThan(-1);
            expect(at(table)).toBeLessThan(at("meals"));
        }
        expect(at("health_sync_links")).toBeLessThan(at("health_sync_days"));
    });

    // Every per-user table goes into the export, deletion and the privacy
    // policy together; history goes immediately before the goals row.
    test("deleteAllUserData removes goals history just before goals", async () => {
        const src = await Bun.file("./src/supabase.ts").text();
        const body = src.slice(
            src.indexOf("export async function deleteAllUserData"),
        );
        const fromCalls = [...body.matchAll(/\.from\("([a-z_]+)"\)/g)].map(
            (m) => m[1],
        );
        const at = fromCalls.indexOf("nutrition_goals_history");
        expect(at).toBeGreaterThan(-1);
        expect(fromCalls[at + 1]).toBe("nutrition_goals");
    });
});

/** An in-memory paged source, standing in for a `.range(from, to)` query. */
function paged<T>(rows: T[]) {
    const calls: Array<[number, number]> = [];
    const fetchPage = async (from: number, to: number): Promise<T[]> => {
        calls.push([from, to]);
        return rows.slice(from, to + 1);
    };
    return { fetchPage, calls };
}

describe("fetchAllPages", () => {
    test("returns everything when it all fits in one short page", async () => {
        const rows = Array.from({ length: 5 }, (_, i) => i);
        const { fetchPage, calls } = paged(rows);
        expect(await fetchAllPages(fetchPage, 1000)).toEqual(rows);
        // A page shorter than pageSize is itself proof there is no more —
        // one fetch should be enough, not a second empty-page round trip.
        expect(calls).toEqual([[0, 999]]);
    });

    test("empty source returns an empty array from a single fetch", async () => {
        const { fetchPage, calls } = paged<number>([]);
        expect(await fetchAllPages(fetchPage, 1000)).toEqual([]);
        expect(calls).toEqual([[0, 999]]);
    });

    test("pages through a total larger than one page (the reported bug)", async () => {
        // 1500 rows with the default 1000-row page: the original unbounded
        // select returned only the first 1000 and silently dropped the rest.
        const rows = Array.from({ length: 1500 }, (_, i) => i);
        const { fetchPage, calls } = paged(rows);
        const result = await fetchAllPages(fetchPage, 1000);
        expect(result).toEqual(rows);
        expect(result).toHaveLength(1500);
        expect(calls).toEqual([
            [0, 999],
            [1000, 1999],
        ]);
    });

    test("total an exact multiple of pageSize still terminates", async () => {
        // A full last page is indistinguishable from "there might be more"
        // until the next fetch comes back empty — this pins that the loop
        // does make that extra call, and does stop once it does.
        const rows = Array.from({ length: 2000 }, (_, i) => i);
        const { fetchPage, calls } = paged(rows);
        const result = await fetchAllPages(fetchPage, 1000);
        expect(result).toEqual(rows);
        expect(calls).toEqual([
            [0, 999],
            [1000, 1999],
            [2000, 2999],
        ]);
    });

    test("honours a custom page size", async () => {
        const rows = Array.from({ length: 25 }, (_, i) => i);
        const { fetchPage, calls } = paged(rows);
        const result = await fetchAllPages(fetchPage, 10);
        expect(result).toEqual(rows);
        expect(calls).toEqual([
            [0, 9],
            [10, 19],
            [20, 29],
        ]);
    });

    test("preserves row order across page boundaries", async () => {
        // getAllMeals sorts by logged_at then id before paging; fetchAllPages
        // must not reorder or interleave what each page hands back.
        const rows = Array.from({ length: 12 }, (_, i) => ({
            id: i,
            logged_at: `2026-01-${String(i + 1).padStart(2, "0")}`,
        }));
        const { fetchPage } = paged(rows);
        const result = await fetchAllPages(fetchPage, 5);
        expect(result.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    });
});

// ---------- Window readers (the #66 truncation, round two). The export readers
// got .range() paging in #66, but the day and range readers did not: they sorted
// logged_at ASC with no .range(), so past PostgREST's 1000-row cap they kept the
// OLDEST rows, and a 365-day get_trends showed the latest 30 days as zeros.
// src/supabase-window.test.ts drives the real paged reader; these pin the
// reconcile rule and that every reader still routes through it. ----------

describe("assertWindowComplete", () => {
    test("equal counts pass", () => {
        expect(() => assertWindowComplete("meals", 1400, 1400)).not.toThrow();
    });

    test("more rows than counted (a concurrent insert) pass", () => {
        expect(() => assertWindowComplete("meals", 1401, 1400)).not.toThrow();
    });

    test("no count passes", () => {
        expect(() => assertWindowComplete("meals", 3, null)).not.toThrow();
    });

    test("a shortfall throws", () => {
        expect(() => assertWindowComplete("meals", 1000, 1400)).toThrow(
            "result would be truncated",
        );
    });
});

/** One exported function's source, cut at the next top-level export. An
 *  unbounded slice would reach into whatever is declared after it and pass
 *  vacuously (getMealsByDate sits right above getMealsInRange). */
function fnBody(src: string, name: string): string {
    const start = src.indexOf(`export async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
}

describe("isUuid", () => {
    test.each([
        "3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e",
        "3F2B9C1E-4D5A-4B6C-8D7E-9F0A1B2C3D4E",
    ])("true for %s", (v) => {
        expect(isUuid(v)).toBe(true);
    });

    test.each([
        "m1",
        "",
        "abc",
        "3f2b9c1e4d5a-4b6c-8d7e-9f0a1b2c3d4e",
        "3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e ",
        "3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e\n",
    ])("false for %j", (v) => {
        expect(isUuid(v)).toBe(false);
    });
});

describe("mealIdempotencyKey: saturated and trans fat are excluded (#201)", () => {
    test("the key for the fixture meal is pinned, with both fields absent", () => {
        // The digest is frozen (see the comment on mealIdempotencyKey): this is
        // the value every auto: key written before the columns existed.
        expect(key(meal())).toBe(
            "auto:2cb5c578de992b77444e0d0121854d3292e642215a15dfa2599dd6d9f432fac4",
        );
    });

    test("saturated_fat_g and trans_fat_g never change the key", () => {
        expect(key(meal({ saturated_fat_g: 5, trans_fat_g: 0.2 }))).toBe(
            key(meal()),
        );
    });
});
