import { test, expect, describe } from "bun:test";
import {
    HEALTH_SYNC_CLOSE_HOUR,
    HEALTH_SYNC_DEFAULT_FIELDS,
    HEALTH_SYNC_FIELDS,
    HEALTH_SYNC_FIELD_SPECS,
    HEALTH_SYNC_LEASE_SECONDS,
    HEALTH_SYNC_MAX_ACK_ENTRIES,
    HEALTH_SYNC_MAX_ROUNDS,
    HEALTH_SYNC_RETENTION_DAYS,
    HEALTH_SYNC_WINDOW_DAYS,
    ackWindow,
    applyAck,
    closeInstant,
    computeDayTotals,
    effectiveTimezone,
    entryId,
    fieldsFor,
    isClosed,
    parseAckBody,
    parseEntryId,
    planIntraday,
    roundField,
    sampleAt,
    unitStep,
    windowDates,
    type DayTotals,
    type HealthSyncField,
    type HealthSyncMeal,
} from "./health-sync.js";
import type { HealthSyncDayRow } from "./db/repo.js";

const TZ = "Europe/Kyiv";
const ALL = HEALTH_SYNC_FIELDS as readonly HealthSyncField[];
const DEFAULTS = HEALTH_SYNC_DEFAULT_FIELDS;

function totals(partial: Partial<DayTotals> = {}): DayTotals {
    const t = Object.fromEntries(
        HEALTH_SYNC_FIELDS.map((f) => [f, null]),
    ) as DayTotals;
    return { ...t, ...partial };
}

function ledgerDay(
    date: string,
    sent: HealthSyncDayRow["sent"],
    over: Partial<HealthSyncDayRow> = {},
): HealthSyncDayRow {
    return {
        date,
        timezone: TZ,
        rounds: 1,
        sent,
        first_sent_at: "2026-10-03T05:00:00.000Z",
        last_sent_at: "2026-10-03T05:00:00.000Z",
        ...over,
    };
}

function meal(
    logged_at: string,
    v: Partial<Omit<HealthSyncMeal, "logged_at">> = {},
): HealthSyncMeal {
    return {
        logged_at,
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        caffeine_mg: null,
        ...v,
    };
}

/** 10:00 in Kyiv on Oct 3 (EEST, UTC+3). */
const NOW = new Date("2026-10-03T07:00:00Z");

/** Plans with the given per-date totals (dates default to all-null). */
function plan(
    byDate: Record<string, Partial<DayTotals>>,
    ledger: HealthSyncDayRow[] = [],
    opts: { now?: Date; tz?: string; fields?: readonly HealthSyncField[] } = {},
) {
    const now = opts.now ?? NOW;
    const tz = opts.tz ?? TZ;
    const map = new Map(
        windowDates(now, tz).map((d) => [d, totals(byDate[d] ?? {})]),
    );
    return planIntraday({
        now,
        tz,
        totals: map,
        ledger,
        fields: opts.fields ?? DEFAULTS,
    });
}

describe("constants", () => {
    test("the numbers the docs restate", () => {
        expect(HEALTH_SYNC_CLOSE_HOUR).toBe(5);
        expect(HEALTH_SYNC_WINDOW_DAYS).toBe(7);
        expect(HEALTH_SYNC_RETENTION_DAYS).toBe(8);
        expect(HEALTH_SYNC_LEASE_SECONDS).toBe(120);
        expect(HEALTH_SYNC_MAX_ACK_ENTRIES).toBe(20);
        expect(HEALTH_SYNC_MAX_ROUNDS).toBe(48);
    });

    test("water is opt-in and alcohol is never a field", () => {
        expect(DEFAULTS).not.toContain("water_ml");
        expect(ALL.some((f) => f.includes("alcohol"))).toBe(false);
        expect(fieldsFor(false)).toEqual([...DEFAULTS]);
        expect(fieldsFor(true)).toEqual([...ALL]);
    });

    test.each([
        ["energy_kcal", 20],
        ["protein_g", 2],
        ["carbohydrates_g", 2],
        ["fat_g", 2],
        ["fiber_g", 2],
        ["caffeine_mg", 10],
        ["water_ml", 100],
    ] as const)("%s threshold is %d", (f, thr) => {
        expect(HEALTH_SYNC_FIELD_SPECS[f].threshold).toBe(thr);
    });

    test("unitStep is the smallest amount the precision can carry", () => {
        expect(unitStep("energy_kcal")).toBe(1);
        expect(unitStep("water_ml")).toBe(1);
        expect(unitStep("protein_g")).toBe(0.1);
    });
});

describe("roundField", () => {
    test.each([
        ["energy_kcal", 2140.5, 2141],
        ["energy_kcal", 2140.4, 2140],
        ["caffeine_mg", 189.6, 190],
        ["water_ml", 249.5, 250],
        ["protein_g", 132.44, 132.4],
        ["protein_g", 132.45, 132.5],
        ["fat_g", -0.04, 0],
    ] as const)("%s %d → %d", (f, v, want) => {
        expect(roundField(f, v)).toBe(want);
        expect(Object.is(roundField(f, v), -0)).toBe(false);
    });
});

// ---------- totals ----------

describe("computeDayTotals", () => {
    test("null when nothing carries a value, 0 when something does", () => {
        const m = computeDayTotals(
            [
                meal("2026-10-02T06:00:00Z", { calories: 500, fiber_g: 0 }),
                meal("2026-10-02T12:00:00Z", { calories: 0.4, protein_g: 20 }),
            ],
            [],
            TZ,
            ["2026-10-02"],
        );
        const t = m.get("2026-10-02")!;
        expect(t.energy_kcal).toBe(500);
        expect(t.protein_g).toBe(20);
        expect(t.fiber_g).toBe(0);
        expect(t.caffeine_mg).toBeNull();
        expect(t.water_ml).toBeNull();
    });

    test("sums raw and rounds once", () => {
        const meals = [0.04, 0.04, 0.04].map((g) =>
            meal("2026-10-02T09:00:00Z", { protein_g: g }),
        );
        const t = computeDayTotals(meals, [], TZ, ["2026-10-02"]);
        expect(t.get("2026-10-02")!.protein_g).toBe(0.1);
    });

    test("buckets by local day in tz and ignores rows outside the dates", () => {
        // 21:30Z on Oct 1 is 00:30 Oct 2 in Kyiv (UTC+3).
        const m = computeDayTotals(
            [
                meal("2026-10-01T21:30:00Z", { calories: 100 }),
                meal("2026-10-01T20:30:00Z", { calories: 7 }),
                meal("2026-10-05T10:00:00Z", { calories: 999 }),
            ],
            [
                { logged_at: "2026-10-02T08:00:00Z", amount_ml: 250 },
                { logged_at: "2026-10-02T09:00:00Z", amount_ml: 300 },
            ],
            TZ,
            ["2026-10-01", "2026-10-02"],
        );
        expect(m.get("2026-10-01")!.energy_kcal).toBe(7);
        expect(m.get("2026-10-02")!.energy_kcal).toBe(100);
        expect(m.get("2026-10-02")!.water_ml).toBe(550);
        expect(m.get("2026-10-01")!.water_ml).toBeNull();
        expect(m.has("2026-10-05")).toBe(false);
    });

    test("a date with nothing logged is all-null", () => {
        const t = computeDayTotals([], [], TZ, ["2026-10-02"]).get(
            "2026-10-02",
        )!;
        expect(Object.values(t).every((v) => v === null)).toBe(true);
    });
});

// ---------- time ----------

describe("closeInstant: 05:00 local on D+1, DST-correct", () => {
    test.each([
        // Europe/Kyiv: EEST (+3) until Oct 25 2026 04:00, then EET (+2).
        ["2026-10-01", "Europe/Kyiv", "2026-10-02T02:00:00.000Z"],
        ["2026-10-23", "Europe/Kyiv", "2026-10-24T02:00:00.000Z"],
        ["2026-10-24", "Europe/Kyiv", "2026-10-25T03:00:00.000Z"],
        ["2026-10-25", "Europe/Kyiv", "2026-10-26T03:00:00.000Z"],
        // Spring forward Mar 29 2026 03:00 → 04:00.
        ["2026-03-27", "Europe/Kyiv", "2026-03-28T03:00:00.000Z"],
        ["2026-03-28", "Europe/Kyiv", "2026-03-29T02:00:00.000Z"],
        // New York falls back Nov 1 2026 02:00; day start + 29h would say 04:00.
        ["2026-10-31", "America/New_York", "2026-11-01T10:00:00.000Z"],
        ["2026-03-07", "America/New_York", "2026-03-08T09:00:00.000Z"],
        ["2026-10-01", "UTC", "2026-10-02T05:00:00.000Z"],
        ["2026-12-31", "Asia/Tokyo", "2026-12-31T20:00:00.000Z"],
    ])("%s in %s closes at %s", (date, tz, iso) => {
        expect(closeInstant(date, tz).toISOString()).toBe(iso);
    });
});

describe("effectiveTimezone", () => {
    test.each([
        ["Europe/Kyiv", "America/New_York", "Europe/Kyiv", "profile"],
        [null, "America/New_York", "America/New_York", "phone"],
        ["Not/AZone", "America/New_York", "America/New_York", "phone"],
        [null, null, "UTC", "utc"],
        [undefined, "bogus", "UTC", "utc"],
    ] as const)("profile=%s phone=%s → %s (%s)", (p, f, tz, source) => {
        expect(effectiveTimezone(p, f)).toEqual({ tz, source });
    });
});

test("sugar is not sent to Apple Health", () => {
    // Sugar is left out of Apple Health sync for now: it stays tracked in
    // the MCP, but the shortcut has no sugar block. A link created while
    // it was one keeps "sugar_g" in its stored fields; the routes filter it
    // out with isHealthSyncField.
    expect((HEALTH_SYNC_FIELDS as readonly string[]).includes("sugar_g")).toBe(
        false,
    );
    expect(HEALTH_SYNC_DEFAULT_FIELDS).not.toContain("sugar_g" as never);
});

// ---------- the window ----------

describe("windowDates / ackWindow", () => {
    test("seven local days ending today, ascending", () => {
        const d = windowDates(NOW, TZ);
        expect(d).toEqual([
            "2026-09-27",
            "2026-09-28",
            "2026-09-29",
            "2026-09-30",
            "2026-10-01",
            "2026-10-02",
            "2026-10-03",
        ]);
    });

    test("the window follows the LOCAL date, not UTC", () => {
        // 21:30Z on Oct 3 is already Oct 4 in Kyiv (UTC+3).
        const d = windowDates(new Date("2026-10-03T21:30:00Z"), TZ);
        expect(d[6]).toBe("2026-10-04");
        expect(windowDates(new Date("2026-10-03T21:30:00Z"), "UTC")[6]).toBe(
            "2026-10-03",
        );
    });

    test("always seven distinct days across a DST change", () => {
        for (const [now, tz] of [
            ["2026-10-25T10:00:00Z", "Europe/Kyiv"],
            ["2026-03-29T10:00:00Z", "Europe/Kyiv"],
            ["2026-11-02T15:00:00Z", "America/New_York"],
            ["2026-03-08T15:00:00Z", "America/New_York"],
        ] as const) {
            const d = windowDates(new Date(now), tz);
            expect(new Set(d).size).toBe(7);
            expect([...d].sort()).toEqual(d);
        }
    });

    test("an ack is accepted for the window plus one older day, never the future", () => {
        expect(ackWindow(NOW, TZ)).toEqual({
            from: "2026-09-26",
            to: "2026-10-03",
        });
    });
});

describe("05:00 close boundary", () => {
    test.each([
        // Kyiv +3: Oct 2 closes at 05:00 Oct 3 = 02:00Z.
        ["2026-10-03T01:59:59Z", TZ, "2026-10-02", false],
        ["2026-10-03T02:00:00Z", TZ, "2026-10-02", true],
        ["2026-10-03T07:00:00Z", TZ, "2026-10-03", false],
        // Fall-back morning: Oct 24 closes at 05:00 EET = 03:00Z.
        ["2026-10-25T02:59:59Z", TZ, "2026-10-24", false],
        ["2026-10-25T03:00:00Z", TZ, "2026-10-24", true],
        // Spring forward Mar 29: Mar 28 closes at 05:00 EEST = 02:00Z.
        ["2026-03-29T01:59:59Z", TZ, "2026-03-28", false],
        ["2026-03-29T02:00:00Z", TZ, "2026-03-28", true],
        ["2026-11-01T09:59:59Z", "America/New_York", "2026-10-31", false],
        ["2026-11-01T10:00:00Z", "America/New_York", "2026-10-31", true],
    ])("at %s in %s, %s closed = %s", (now, tz, date, want) => {
        expect(isClosed(date, new Date(now), tz)).toBe(want);
    });
});

describe("sampleAt", () => {
    test("today is dated now (to the minute); other days 23:59 that day", () => {
        expect(
            sampleAt("2026-10-03", new Date("2026-10-03T07:00:45Z"), TZ),
        ).toBe("2026-10-03T10:00:00+03:00");
        expect(sampleAt("2026-10-02", NOW, TZ)).toBe(
            "2026-10-02T23:59:00+03:00",
        );
    });

    test("23:59 carries the offset of THAT day across a DST change", () => {
        const now = new Date("2026-10-27T10:00:00Z");
        expect(sampleAt("2026-10-24", now, TZ)).toBe(
            "2026-10-24T23:59:00+03:00",
        );
        expect(sampleAt("2026-10-25", now, TZ)).toBe(
            "2026-10-25T23:59:00+02:00",
        );
        expect(
            sampleAt(
                "2026-11-01",
                new Date("2026-11-03T15:00:00Z"),
                "America/New_York",
            ),
        ).toBe("2026-11-01T23:59:00-05:00");
    });

    test("just after local midnight, 'today' is the new day", () => {
        const now = new Date("2026-10-03T21:05:30Z"); // 00:05 Oct 4 in Kyiv
        expect(sampleAt("2026-10-04", now, TZ)).toBe(
            "2026-10-04T00:05:00+03:00",
        );
    });
});

// ---------- planning ----------

describe("planIntraday: first offers", () => {
    test("an open day with logged food gets one entry of the whole total", () => {
        const p = plan({
            "2026-10-03": { energy_kcal: 450, protein_g: 20.5, fiber_g: 0 },
        });
        expect(p.entries).toEqual([
            {
                entry_id: "2026-10-03:r1",
                date: "2026-10-03",
                closed: false,
                sample_at: "2026-10-03T10:00:00+03:00",
                values: { energy_kcal: 450, protein_g: 20.5 },
            },
        ]);
        expect(p.discrepancies).toEqual([]);
    });

    test("nothing logged, nothing offered; a real 0 is not an amount", () => {
        expect(plan({}).entries).toEqual([]);
        expect(
            plan({ "2026-10-03": { fiber_g: 0, energy_kcal: 0 } }).entries,
        ).toEqual([]);
    });

    test("entries cover every window day that has something to send, oldest first", () => {
        const p = plan({
            "2026-10-01": { energy_kcal: 1800 },
            "2026-10-03": { energy_kcal: 300 },
            "2026-09-20": { energy_kcal: 999 }, // outside the window
        });
        expect(p.entries.map((e) => e.entry_id)).toEqual([
            "2026-10-01:r1",
            "2026-10-03:r1",
        ]);
        expect(p.entries[0]!.closed).toBe(true);
        expect(p.entries[0]!.sample_at).toBe("2026-10-01T23:59:00+03:00");
    });

    test("water only counts when the run enables it", () => {
        const byDate = { "2026-10-03": { energy_kcal: 300, water_ml: 1500 } };
        expect(plan(byDate).entries[0]!.values).toEqual({ energy_kcal: 300 });
        expect(plan(byDate, [], { fields: ALL }).entries[0]!.values).toEqual({
            energy_kcal: 300,
            water_ml: 1500,
        });
        // water alone below its 100 mL bar is not worth an entry
        expect(
            plan({ "2026-10-03": { water_ml: 99 } }, [], { fields: ALL })
                .entries,
        ).toEqual([]);
    });
});

describe("planIntraday: only the new delta, above the threshold", () => {
    const sent = { energy_kcal: 450, protein_g: 20.5 };
    const led = [ledgerDay("2026-10-03", sent)];

    test("offers the positive difference, not the total, as the next round", () => {
        const p = plan(
            { "2026-10-03": { energy_kcal: 700, protein_g: 35 } },
            led,
        );
        expect(p.entries).toHaveLength(1);
        expect(p.entries[0]).toMatchObject({
            entry_id: "2026-10-03:r2",
            values: { energy_kcal: 250, protein_g: 14.5 },
        });
    });

    test("an unchanged total offers nothing", () => {
        expect(
            plan({ "2026-10-03": { energy_kcal: 450, protein_g: 20.5 } }, led)
                .entries,
        ).toEqual([]);
    });

    test.each([
        // open day: below the bar is ignored, at the bar is offered
        ["energy_kcal", 469, false],
        ["energy_kcal", 470, true],
        ["protein_g", 22.4, false],
        ["protein_g", 22.5, true],
    ] as const)("open day %s total %d offered=%s", (field, total, offered) => {
        const base = { energy_kcal: 450, protein_g: 20.5 };
        const p = plan({ "2026-10-03": { ...base, [field]: total } }, led);
        expect(p.entries.length > 0).toBe(offered);
    });

    test("fields are independent: only the ones that crossed their bar travel", () => {
        const p = plan(
            { "2026-10-03": { energy_kcal: 455, protein_g: 40 } },
            led,
        );
        expect(p.entries[0]!.values).toEqual({ protein_g: 19.5 });
    });

    test("the entry id is stable until acked, whatever the totals do meanwhile", () => {
        const a = plan({ "2026-10-03": { energy_kcal: 700 } }, led).entries[0]!;
        const b = plan({ "2026-10-03": { energy_kcal: 900 } }, led).entries[0]!;
        expect(a.entry_id).toBe("2026-10-03:r2");
        expect(b.entry_id).toBe(a.entry_id);
        expect(b.values.energy_kcal).toBe(450);
    });

    test("planning is read-only and repeatable", () => {
        const input = { "2026-10-03": { energy_kcal: 700 } };
        const first = plan(input, led);
        const second = plan(input, led);
        expect(second).toEqual(first);
        expect(led[0]!.rounds).toBe(1);
        expect(led[0]!.sent).toEqual(sent);
    });
});

describe("planIntraday: closed days get a final top-up of any positive amount", () => {
    test("a closed day is offered a delta below the open-day bar", () => {
        // Oct 2 closed at 02:00Z on Oct 3; it is 07:00Z.
        const led = [
            ledgerDay("2026-10-02", { energy_kcal: 2000, protein_g: 100 }),
        ];
        const p = plan(
            { "2026-10-02": { energy_kcal: 2005, protein_g: 100.1 } },
            led,
        );
        expect(p.entries).toHaveLength(1);
        expect(p.entries[0]).toMatchObject({
            entry_id: "2026-10-02:r2",
            closed: true,
            values: { energy_kcal: 5, protein_g: 0.1 },
        });
    });

    test("the same small delta on an OPEN day is held back", () => {
        const led = [
            ledgerDay("2026-10-03", { energy_kcal: 2000, protein_g: 100 }),
        ];
        expect(
            plan({ "2026-10-03": { energy_kcal: 2005, protein_g: 100.1 } }, led)
                .entries,
        ).toEqual([]);
    });

    test("the boundary: 04:59:59 local the day is still open, 05:00:00 it is closed", () => {
        const led = [ledgerDay("2026-10-02", { energy_kcal: 2000 })];
        const totalsFor = { "2026-10-02": { energy_kcal: 2005 } };
        const before = plan(totalsFor, led, {
            now: new Date("2026-10-03T01:59:59Z"),
        });
        expect(before.entries).toEqual([]);
        expect(before.days.find((d) => d.date === "2026-10-02")!.closed).toBe(
            false,
        );
        const after = plan(totalsFor, led, {
            now: new Date("2026-10-03T02:00:00Z"),
        });
        expect(after.entries).toHaveLength(1);
        expect(after.entries[0]!.closed).toBe(true);
    });

    test("once the final top-up is acked there is nothing left", () => {
        const led = [
            ledgerDay("2026-10-02", { energy_kcal: 2005 }, { rounds: 2 }),
        ];
        expect(
            plan({ "2026-10-02": { energy_kcal: 2005 } }, led).entries,
        ).toEqual([]);
    });

    test("on the fall-back day the close is 05:00 EET, an hour later in UTC than usual", () => {
        const led = [ledgerDay("2026-10-24", { energy_kcal: 1000 })];
        const t = { "2026-10-24": { energy_kcal: 1003 } };
        const open = plan(t, led, { now: new Date("2026-10-25T02:59:59Z") });
        const closed = plan(t, led, { now: new Date("2026-10-25T03:00:00Z") });
        expect(open.entries).toEqual([]);
        expect(closed.entries).toHaveLength(1);
        expect(closed.entries[0]!.sample_at).toBe("2026-10-24T23:59:00+03:00");
    });
});

describe("planIntraday: discrepancies are reported, never written", () => {
    const led = [ledgerDay("2026-10-03", { energy_kcal: 600, protein_g: 30 })];

    test("a total below what was sent is a discrepancy and no entry", () => {
        const p = plan(
            { "2026-10-03": { energy_kcal: 400, protein_g: 30 } },
            led,
        );
        expect(p.entries).toEqual([]);
        expect(p.discrepancies).toEqual([
            {
                date: "2026-10-03",
                field: "energy_kcal",
                sent: 600,
                current: 400,
                difference: -200,
            },
        ]);
    });

    test("a small dip under the bar is not even a discrepancy", () => {
        const p = plan(
            { "2026-10-03": { energy_kcal: 590, protein_g: 29 } },
            led,
        );
        expect(p.discrepancies).toEqual([]);
    });

    test("deleted food entirely: current 0 against sent", () => {
        const p = plan({}, led);
        expect(
            p.discrepancies.map((d) => [d.field, d.current, d.difference]),
        ).toEqual([
            ["energy_kcal", 0, -600],
            ["protein_g", 0, -30],
        ]);
    });

    test("if the total climbs back past what was sent, only the excess flows", () => {
        const p = plan({ "2026-10-03": { energy_kcal: 650 } }, [
            ledgerDay("2026-10-03", { energy_kcal: 600 }),
        ]);
        expect(p.discrepancies).toEqual([]);
        expect(p.entries[0]!.values).toEqual({ energy_kcal: 50 });
    });

    test("a closed day reports any shortfall of a whole unit", () => {
        const p = plan({ "2026-10-02": { energy_kcal: 1998 } }, [
            ledgerDay("2026-10-02", { energy_kcal: 2000 }),
        ]);
        expect(p.discrepancies).toHaveLength(1);
        expect(p.discrepancies[0]!.difference).toBe(-2);
    });

    test("NO entry ever carries a zero or negative value (swept over many totals)", () => {
        const sentVals = { energy_kcal: 500, protein_g: 25, caffeine_mg: 100 };
        for (let e = 0; e <= 1200; e += 7) {
            for (const p of [0, 12.3, 25, 61.7]) {
                const out = plan(
                    {
                        "2026-10-03": {
                            energy_kcal: e,
                            protein_g: p,
                            caffeine_mg: e % 300,
                        },
                    },
                    [ledgerDay("2026-10-03", sentVals)],
                );
                for (const entry of out.entries) {
                    for (const v of Object.values(entry.values)) {
                        expect(v).toBeGreaterThan(0);
                    }
                }
            }
        }
    });

    test("the dashboard status sees sent vs logged vs pending per day", () => {
        const p = plan(
            { "2026-10-03": { energy_kcal: 400, protein_g: 50 } },
            led,
        );
        const d = p.days.find((x) => x.date === "2026-10-03")!;
        expect(d).toMatchObject({
            closed: false,
            rounds: 1,
            sent: { energy_kcal: 600, protein_g: 30 },
            logged: { energy_kcal: 400, protein_g: 50 },
            pending: { protein_g: 20 },
        });
        expect(p.days).toHaveLength(7);
    });
});

describe("planIntraday: timezone and caps", () => {
    test("a day sent in another timezone is frozen, with a notice", () => {
        const led = [
            ledgerDay(
                "2026-10-03",
                { energy_kcal: 600 },
                { timezone: "Europe/Kyiv" },
            ),
        ];
        const p = plan({ "2026-10-03": { energy_kcal: 1500 } }, led, {
            tz: "America/New_York",
            now: NOW,
        });
        // New York is still Oct 3 at 03:00; the row is Kyiv's.
        expect(p.entries).toEqual([]);
        expect(p.notices.join(" ")).toContain("no longer synced");
        expect(p.notices.join(" ")).toContain("Europe/Kyiv");
    });

    test("a day that has hit the round cap stops being offered, with a notice", () => {
        const led = [
            ledgerDay(
                "2026-10-03",
                { energy_kcal: 600 },
                { rounds: HEALTH_SYNC_MAX_ROUNDS },
            ),
        ];
        const p = plan({ "2026-10-03": { energy_kcal: 1500 } }, led);
        expect(p.entries).toEqual([]);
        expect(p.notices.join(" ")).toContain(
            `${HEALTH_SYNC_MAX_ROUNDS} updates`,
        );
        expect(p.days.find((d) => d.date === "2026-10-03")!.pending).toEqual(
            {},
        );
    });

    test("a bucket by local day: food at 23:30 Kyiv lands on that day, not the UTC one", () => {
        const meals = [meal("2026-10-02T20:30:00Z", { calories: 300 })]; // 23:30 Oct 2 Kyiv
        const dates = windowDates(NOW, TZ);
        const t = computeDayTotals(meals, [], TZ, dates);
        expect(t.get("2026-10-02")!.energy_kcal).toBe(300);
        expect(t.get("2026-10-03")!.energy_kcal).toBeNull();
    });
});

// ---------- ack ----------

describe("entry ids", () => {
    test("round trip and rejects", () => {
        expect(entryId("2026-10-03", 3)).toBe("2026-10-03:r3");
        expect(parseEntryId("2026-10-03:r3")).toEqual({
            date: "2026-10-03",
            round: 3,
        });
        for (const bad of [
            "2026-10-03:i",
            "2026-10-03:t1",
            "2026-10-03:r0",
            "2026-10-03:r",
            "2026-13-03:r1",
            "2026-10-03:r1x",
            "x:r1",
            "",
        ]) {
            expect(parseEntryId(bad)).toBeNull();
        }
    });
});

describe("applyAck", () => {
    const AT = new Date("2026-10-03T07:05:00Z");
    const ack = (id: string, values: Record<string, number>) => ({
        entry_id: id,
        date: id.slice(0, 10),
        values,
    });

    test("r1 on a day with no row creates it and records what the phone echoed", () => {
        const r = applyAck(
            null,
            ack("2026-10-03:r1", { energy_kcal: 450.4, protein_g: 20.55 }),
            TZ,
            AT,
        );
        expect(r.applied).toBe(true);
        expect(r.row).toEqual({
            date: "2026-10-03",
            timezone: TZ,
            rounds: 1,
            sent: { energy_kcal: 450, protein_g: 20.6 },
            first_sent_at: AT.toISOString(),
            last_sent_at: AT.toISOString(),
        });
    });

    test("the next round ADDS to sent so far and keeps the first timestamp and zone", () => {
        const row = ledgerDay(
            "2026-10-03",
            { energy_kcal: 450 },
            { timezone: "Europe/Kyiv" },
        );
        const r = applyAck(
            row,
            ack("2026-10-03:r2", { energy_kcal: 250, fiber_g: 3 }),
            "America/New_York",
            AT,
        );
        expect(r.row).toMatchObject({
            rounds: 2,
            timezone: "Europe/Kyiv",
            sent: { energy_kcal: 700, fiber_g: 3 },
            first_sent_at: row.first_sent_at,
            last_sent_at: AT.toISOString(),
        });
    });

    test("a replayed ack changes nothing (its round is already counted)", () => {
        const row = ledgerDay("2026-10-03", { energy_kcal: 450 });
        expect(
            applyAck(row, ack("2026-10-03:r1", { energy_kcal: 450 }), TZ, AT),
        ).toEqual({ applied: false, row: null });
        expect(
            applyAck(null, ack("2026-10-03:r2", { energy_kcal: 1 }), TZ, AT)
                .applied,
        ).toBe(false);
    });

    test("an ack that skips a round is refused", () => {
        const row = ledgerDay("2026-10-03", { energy_kcal: 450 });
        expect(
            applyAck(row, ack("2026-10-03:r3", { energy_kcal: 5 }), TZ, AT)
                .applied,
        ).toBe(false);
    });

    test("a date that disagrees with the entry id, or no known field, is refused", () => {
        expect(
            applyAck(
                null,
                {
                    entry_id: "2026-10-03:r1",
                    date: "2026-10-04",
                    values: { energy_kcal: 1 },
                },
                TZ,
                AT,
            ).applied,
        ).toBe(false);
        expect(
            applyAck(null, ack("2026-10-03:r1", { sugar_g: 5 }), TZ, AT)
                .applied,
        ).toBe(false);
    });

    test("the input row is never mutated", () => {
        const row = ledgerDay("2026-10-03", { energy_kcal: 450 });
        const copy = structuredClone(row);
        applyAck(row, ack("2026-10-03:r2", { energy_kcal: 10 }), TZ, AT);
        expect(row).toEqual(copy);
    });
});

describe("parseAckBody", () => {
    const entry = {
        entry_id: "2026-10-02:r1",
        date: "2026-10-02",
        values: { energy_kcal: 2140, protein_g: 132.4 },
    };

    test("accepts entries and done", () => {
        expect(parseAckBody({ entries: [entry], done: true })).toEqual({
            ok: true,
            value: { entries: [entry], done: true },
        });
    });

    test("zero entries with done releases the lease", () => {
        expect(parseAckBody({ done: true })).toEqual({
            ok: true,
            value: { entries: [], done: true },
        });
    });

    test("lease_until is passed on when sent", () => {
        const lease = "2026-10-03T12:02:00.000Z";
        expect(parseAckBody({ done: true, lease_until: lease })).toEqual({
            ok: true,
            value: { entries: [], done: true, lease_until: lease },
        });
        const none = parseAckBody({ done: true, lease_until: null });
        expect(none.ok && "lease_until" in none.value).toBe(false);
    });

    test.each([
        ["not an object", [], /JSON object/],
        ["done not a boolean", { done: "yes" }, /done must be/],
        ["lease not a date", { lease_until: "soon" }, /lease_until/],
        ["entries not an array", { entries: {} }, /entries must be an array/],
        [
            "old-style entry id",
            { entries: [{ ...entry, entry_id: "2026-10-02:i" }] },
            /entry_id/,
        ],
        [
            "date mismatch",
            { entries: [{ ...entry, date: "2026-10-03" }] },
            /date must match/,
        ],
        [
            "values not an object",
            { entries: [{ ...entry, values: [] }] },
            /values must be an object/,
        ],
        [
            "unknown field",
            { entries: [{ ...entry, values: { sugar_g: 5 } }] },
            /not a field/,
        ],
        [
            "negative",
            { entries: [{ ...entry, values: { energy_kcal: -1 } }] },
            /0 to/,
        ],
        [
            "over the cap",
            { entries: [{ ...entry, values: { energy_kcal: 50_001 } }] },
            /0 to 50000/,
        ],
        [
            "not a number",
            { entries: [{ ...entry, values: { energy_kcal: "5" } }] },
            /0 to/,
        ],
        ["empty values", { entries: [{ ...entry, values: {} }] }, /empty/],
        [
            "too many entries",
            { entries: Array.from({ length: 21 }, () => entry) },
            /At most 20/,
        ],
    ])("refuses %s", (_name, body, message) => {
        const r = parseAckBody(body);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(message);
    });

    test("value caps are inclusive", () => {
        const r = parseAckBody({
            entries: [
                {
                    ...entry,
                    values: { energy_kcal: 50_000, water_ml: 100_000 },
                },
            ],
        });
        expect(r.ok).toBe(true);
    });
});
