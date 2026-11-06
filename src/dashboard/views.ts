/**
 * The dashboard pages as functions from data to markup. Every stored string
 * goes through the escaping `html` template; nothing here builds markup by
 * concatenating user text.
 */
import type { Meal, NutritionGoals } from "../db/repo.js";
import type { MealItemValues } from "../meal-items.js";
import { HEALTH_SYNC_FIELDS, type HealthSyncField } from "../health-sync.js";
import type { HealthSyncStatus } from "../health-sync-status.js";
import {
    barChart,
    dataTable,
    lineChart,
    meter,
    ring,
    shortDate,
    stackedBarChart,
} from "./charts.js";
import type {
    MealsDayData,
    TodayData,
    TrendRange,
    TrendsData,
} from "./data.js";
import { TREND_RANGES } from "./data.js";
import { ago, dateTimeIn, longDate, n0, n1, timeIn } from "./format.js";
import { dateInTz } from "../tz.js";
import { html, raw, type Raw } from "./html.js";

// ---------- shared pieces ----------

export function mealRow(
    m: Meal,
    tz: string,
    opts: { withDate?: boolean } = {},
): Raw {
    const when = opts.withDate
        ? dateTimeIn(m.logged_at, tz)
        : timeIn(m.logged_at, tz);
    return html`<li>
        <div class="row">
            <span class="meal-name"
                ><a href="/meals/${m.id}">${m.description}</a
                >${m.meal_type ? html`<span class="tag">${m.meal_type}</span>` : ""}</span
            >
            <span class="muted">${when}</span>
        </div>
        <div class="macros">
            ${n0(m.calories)} kcal · P ${n0(m.protein_g)} g · C ${n0(m.carbs_g)}
            g · F ${n0(m.fat_g)} g
        </div>
    </li>`;
}

function emptyState(text: string): Raw {
    return html`<p class="empty">${text}</p>`;
}

// ---------- Today ----------

interface Extra {
    label: string;
    value: number;
    goal: number | null | undefined;
    unit: string;
    kind: "limit" | "target";
}

export function todayBody(d: TodayData): Raw {
    const g = d.goals;
    const t = d.totals;
    const kcalGoal = g?.daily_calories ?? null;
    const net = t.net_kcal;
    const left = kcalGoal === null ? null : Math.round(kcalGoal - net);
    const macro = (
        label: string,
        value: number,
        goal: number | null,
        cls: string,
    ) =>
        html`<div>
            <div class="row">
                <span>${label}</span
                ><span
                    ><strong>${n0(value)}</strong>
                    ${goal !== null ? html`<span class="muted">/ ${n0(goal)} g</span>` : html`<span class="muted">g</span>`}</span
                >
            </div>
            ${goal !== null ? meter({ value, goal, cls, label: `${label} ${n0(value)} of ${n0(goal)} grams` }) : ""}
        </div>`;
    const extras: Extra[] = [
        {
            label: "Fibre",
            value: t.fiber_g,
            goal: g?.daily_fiber_g,
            unit: "g",
            kind: "target",
        },
        {
            label: "Sugar",
            value: t.sugar_g,
            goal: g?.daily_sugar_g,
            unit: "g",
            kind: "limit",
        },
        {
            label: "Added sugar",
            value: t.added_sugar_g,
            goal: g?.daily_added_sugar_g,
            unit: "g",
            kind: "limit",
        },
        {
            label: "Saturated fat",
            value: t.saturated_fat_g,
            goal: g?.daily_saturated_fat_g,
            unit: "g",
            kind: "limit",
        },
        {
            label: "Sodium",
            value: t.sodium_mg,
            goal: g?.daily_sodium_mg,
            unit: "mg",
            kind: "limit",
        },
        {
            label: "Caffeine",
            value: t.caffeine_mg,
            goal: g?.daily_caffeine_mg,
            unit: "mg",
            kind: "limit",
        },
        ...(d.alcoholTracking
            ? [
                  {
                      label: "Alcohol",
                      value: t.alcohol_g,
                      goal: g?.daily_alcohol_g,
                      unit: "g",
                      kind: "limit",
                  } as Extra,
              ]
            : []),
    ];
    const meals = d.meals.length ? d.meals : [];
    return html` <h1>Today</h1>
        <p class="sub">${longDate(d.date)} · ${d.tz}</p>
        <div class="grid two">
            <section class="card" aria-labelledby="h-cal">
                <h2 id="h-cal">Calories</h2>
                <div class="ring">
                    ${ring({
                        value: net,
                        goal: kcalGoal,
                        centre: n0(net),
                        sub:
                            kcalGoal === null
                                ? "kcal"
                                : `of ${n0(kcalGoal)} kcal`,
                        label:
                            kcalGoal === null
                                ? `${n0(net)} kilocalories net`
                                : `${n0(net)} of ${n0(kcalGoal)} kilocalories`,
                    })}
                    <div class="stack">
                        <div>
                            <span class="kpi">${n0(t.calories)}</span>
                            <small>kcal eaten</small>
                        </div>
                        ${
                            t.credited_kcal > 0
                                ? html`<div class="muted">
                                      − ${n0(t.credited_kcal)} kcal active
                                      (counted) =
                                      <strong>${n0(net)}</strong> net
                                  </div>`
                                : ""
                        }
                        ${
                            left === null
                                ? html`<div class="muted">
                                      No calorie goal set.
                                  </div>`
                                : left >= 0
                                  ? html`<div class="good">
                                        <strong>${n0(left)}</strong> kcal left
                                    </div>`
                                  : html`<div class="bad">
                                        <strong>${n0(-left)}</strong> kcal over
                                    </div>`
                        }
                    </div>
                </div>
            </section>
            <section class="card stack" aria-labelledby="h-mac">
                <h2 id="h-mac">Macros</h2>
                ${macro("Protein", t.protein_g, g?.daily_protein_g ?? null, "")}
                ${macro("Carbs", t.carbs_g, g?.daily_carbs_g ?? null, "carb")}
                ${macro("Fat", t.fat_g, g?.daily_fat_g ?? null, "fat")}
                ${
                    extras.some((e) => e.value > 0 || (e.goal ?? null) !== null)
                        ? html`<details>
                              <summary>More nutrients</summary>
                              <div class="scroll">
                                  <table>
                                      <thead>
                                          <tr>
                                              <th>Nutrient</th>
                                              <th class="num">Today</th>
                                              <th class="num">Goal</th>
                                          </tr>
                                      </thead>
                                      <tbody>
                                          ${extras.map(
                                              (e) =>
                                                  html`<tr>
                                                      <td>${e.label}</td>
                                                      <td class="num">
                                                          ${n1(e.value)}
                                                          ${e.unit}
                                                      </td>
                                                      <td class="num">
                                                          ${e.goal === null || e.goal === undefined ? "–" : html`${e.kind === "limit" ? "max " : ""}${n1(e.goal)} ${e.unit}`}
                                                      </td>
                                                  </tr>`,
                                          )}
                                      </tbody>
                                  </table>
                              </div>
                          </details>`
                        : ""
                }
            </section>
        </div>
        <div class="grid three" id="stats">
            <section class="card" aria-labelledby="h-water">
                <h2 id="h-water">Water</h2>
                <div class="kpi">
                    ${n0(t.water_ml)}
                    <small
                        >${g?.daily_water_ml ? html`/ ${n0(g.daily_water_ml)} ml` : "ml"}</small
                    >
                </div>
                ${g?.daily_water_ml ? meter({ value: t.water_ml, goal: g.daily_water_ml, cls: "water", label: `Water ${n0(t.water_ml)} of ${n0(g.daily_water_ml)} millilitres` }) : ""}
            </section>
            <section class="card" aria-labelledby="h-weight">
                <h2 id="h-weight">Weight</h2>
                ${
                    d.latestWeight
                        ? html`<div class="kpi">
                                  ${n1(d.latestWeight.value)}
                                  <small>${d.weightUnit}</small>
                              </div>
                              <div class="muted">
                                  ${longDate(d.latestWeight.date)}
                              </div>`
                        : emptyState("No weight logged yet.")
                }
            </section>
            <section class="card" aria-labelledby="h-act">
                <h2 id="h-act">Active calories</h2>
                ${
                    t.burned_kcal > 0
                        ? html`<div class="kpi">
                                  ${n0(t.burned_kcal)}
                                  <small>kcal burned</small>
                              </div>
                              <div class="muted">
                                  ${n0(t.credited_kcal)} kcal counted against
                                  intake
                              </div>`
                        : emptyState("None logged today.")
                }
            </section>
        </div>
        <section class="card" aria-labelledby="h-meals">
            <h2 id="h-meals">
                ${meals.length ? "Meals today" : "Recent meals"}
            </h2>
            ${
                meals.length
                    ? html`<ul class="plain meals">
                          ${meals.map((m) => mealRow(m, d.tz))}
                      </ul>`
                    : d.recent.length
                      ? html`<p class="muted">
                                Nothing logged today yet. The latest meals:
                            </p>
                            <ul class="plain meals">
                                ${d.recent.map((m) => mealRow(m, d.tz, { withDate: true }))}
                            </ul>`
                      : emptyState(
                            "No meals logged yet. Tell Claude what you ate and it shows up here.",
                        )
            }
        </section>`;
}

// ---------- Trends ----------

function rangeLinks(active: TrendRange): Raw {
    return html`<nav class="range" aria-label="Range">
        ${TREND_RANGES.map(
            (r) =>
                html`<a
                    href="/trends?days=${r}"
                    ${r === active ? raw(' aria-current="true"') : ""}
                    >${r} days</a
                >`,
        )}
    </nav>`;
}

export function trendsBody(d: TrendsData): Raw {
    const g = d.goals;
    const pts = (f: (x: TrendsData["series"][number]) => number) =>
        d.series.map((s) => ({ label: shortDate(s.date), value: f(s) }));
    const hasMeals = d.loggedDays > 0;
    const hasWater = d.series.some((s) => s.water_ml > 0);
    const hasAct = d.series.some((s) => s.burned_kcal > 0);
    const rowsOf = (
        f: (x: TrendsData["series"][number]) => (string | number)[],
    ) => d.series.map((s) => [shortDate(s.date), ...f(s)]);
    return html` <h1>Trends</h1>
        <p class="sub">${longDate(d.from)} to ${longDate(d.to)} · ${d.tz}</p>
        ${rangeLinks(d.days)}
        <div class="grid two">
            <section class="card wide" aria-labelledby="t-cal">
                <h2 id="t-cal">Calories per day</h2>
                ${
                    hasMeals
                        ? html`${barChart({ title: "Calories per day", unit: "kcal", points: pts((s) => s.calories), goal: g?.daily_calories ?? null, cls: "s-cal" })}
                              <p class="legend">
                                  <span><i class="cal"></i>Eaten</span
                                  >${g?.daily_calories ? html`<span><i class="goal"></i>Goal ${n0(g.daily_calories)}</span>` : ""}<span
                                      >Average ${n0(d.avgCalories)} kcal on
                                      ${d.loggedDays} logged
                                      ${d.loggedDays === 1 ? "day" : "days"}</span
                                  >
                              </p>
                              ${dataTable(
                                  ["Day", "Eaten", "Active (counted)", "Net"],
                                  rowsOf((s) => [
                                      n0(s.calories),
                                      n0(s.credited_kcal),
                                      n0(s.net_kcal),
                                  ]),
                              )}`
                        : emptyState("No meals in this range yet.")
                }
            </section>
            <section class="card wide" aria-labelledby="t-mac">
                <h2 id="t-mac">Protein, carbs and fat (grams per day)</h2>
                ${
                    hasMeals
                        ? html`${stackedBarChart({ title: "Protein, carbs and fat per day", unit: "grams", points: d.series.map((s) => ({ label: shortDate(s.date), parts: [s.protein_g, s.carbs_g, s.fat_g] })), classes: ["s-pro", "s-carb", "s-fat"] })}
                              <p class="legend">
                                  <span><i class="pro"></i>Protein</span
                                  ><span><i class="carb"></i>Carbs</span
                                  ><span><i class="fat"></i>Fat</span
                                  ><span
                                      >Average protein ${n0(d.avgProtein)}
                                      g</span
                                  >
                              </p>
                              ${dataTable(
                                  ["Day", "Protein g", "Carbs g", "Fat g"],
                                  rowsOf((s) => [
                                      n0(s.protein_g),
                                      n0(s.carbs_g),
                                      n0(s.fat_g),
                                  ]),
                              )}`
                        : emptyState("No meals in this range yet.")
                }
            </section>
            <section class="card" aria-labelledby="t-weight">
                <h2 id="t-weight">Weight (${d.weightUnit})</h2>
                ${
                    d.weights.length
                        ? html`${lineChart({ title: "Weight", unit: d.weightUnit, points: d.weights.map((w) => ({ label: shortDate(w.date), value: w.value })), cls: "s-weight" })}
                          ${dataTable(
                              ["Day", d.weightUnit],
                              d.weights.map((w) => [
                                  shortDate(w.date),
                                  n1(w.value),
                              ]),
                          )}`
                        : emptyState("No weight readings in this range.")
                }
            </section>
            <section class="card" aria-labelledby="t-water">
                <h2 id="t-water">Water (ml per day)</h2>
                ${
                    hasWater
                        ? html`${barChart({ title: "Water per day", unit: "ml", points: pts((s) => s.water_ml), goal: g?.daily_water_ml ?? null, cls: "s-water" })}
                          ${dataTable(
                              ["Day", "ml"],
                              rowsOf((s) => [n0(s.water_ml)]),
                          )}`
                        : emptyState("No water logged in this range.")
                }
            </section>
            <section class="card wide" aria-labelledby="t-act">
                <h2 id="t-act">Active calories (kcal burned per day)</h2>
                ${
                    hasAct
                        ? html`${barChart({ title: "Active calories per day", unit: "kcal", points: pts((s) => s.burned_kcal), goal: null, cls: "s-act" })}
                          ${dataTable(
                              ["Day", "Burned", "Counted"],
                              rowsOf((s) => [
                                  n0(s.burned_kcal),
                                  n0(s.credited_kcal),
                              ]),
                          )}`
                        : emptyState("No active calories in this range.")
                }
            </section>
        </div>`;
}

// ---------- Meals ----------

function shiftDate(date: string, days: number): string {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

export function mealsDayBody(d: MealsDayData, q = ""): Raw {
    const prev = shiftDate(d.date, -1);
    const next = shiftDate(d.date, 1);
    return html` <h1>Meals</h1>
        <form method="get" action="/meals" class="pager" role="search">
            <label class="sr" for="q" hidden>Search meals</label>
            <input
                id="q"
                type="search"
                name="q"
                value="${q}"
                placeholder="Search meals and notes"
                maxlength="100"
            />
            <button type="submit">Search</button>
        </form>
        <div class="pager">
            <a class="btn" href="/meals?date=${prev}" rel="prev"
                >← ${longDate(prev)}</a
            >
            <form method="get" action="/meals" class="inline">
                <input
                    type="date"
                    name="date"
                    value="${d.date}"
                    aria-label="Date"
                    max="${d.today}"
                /><button type="submit">Go</button>
            </form>
            ${d.date < d.today ? html`<a class="btn" href="/meals?date=${next}" rel="next">${longDate(next)} →</a>` : ""}
            ${d.date !== d.today ? html`<a class="btn" href="/meals">Today</a>` : ""}
        </div>
        <section class="card" aria-labelledby="m-day">
            <h2 id="m-day">${longDate(d.date)}</h2>
            ${
                d.meals.length
                    ? html`<p class="macros">
                              ${n0(d.totals.calories)} kcal · P
                              ${n0(d.totals.protein_g)} g · C
                              ${n0(d.totals.carbs_g)} g · F
                              ${n0(d.totals.fat_g)}
                              g${d.totals.water_ml ? html` · water ${n0(d.totals.water_ml)} ml` : ""}
                          </p>
                          <ul class="plain meals">
                              ${d.meals.map((m) => mealRow(m, d.tz))}
                          </ul>`
                    : emptyState("No meals logged on this day.")
            }
        </section>`;
}

export function mealsSearchBody(
    q: string,
    tz: string,
    meals: Meal[],
    limit: number,
): Raw {
    return html` <h1>Meals</h1>
        <form method="get" action="/meals" class="pager" role="search">
            <input
                type="search"
                name="q"
                value="${q}"
                aria-label="Search meals"
                maxlength="100"
            />
            <button type="submit">Search</button>
            <a class="btn" href="/meals">Clear</a>
        </form>
        <section class="card" aria-labelledby="m-res">
            <h2 id="m-res">
                ${meals.length} ${meals.length === 1 ? "result" : "results"} for
                “${q}”
            </h2>
            ${
                meals.length
                    ? html`<ul class="plain meals">
                              ${meals.map((m) => mealRow(m, tz, { withDate: true }))}
                          </ul>
                          ${meals.length >= limit ? html`<p class="muted">Showing the latest ${limit}.</p>` : ""}`
                    : emptyState(
                          "Nothing matches. Searches look at meal descriptions, ingredients and notes.",
                      )
            }
        </section>`;
}

const NUTRIENT_ROWS: [keyof Meal, string, string][] = [
    ["calories", "Calories", "kcal"],
    ["protein_g", "Protein", "g"],
    ["carbs_g", "Carbs", "g"],
    ["fat_g", "Fat", "g"],
    ["saturated_fat_g", "Saturated fat", "g"],
    ["trans_fat_g", "Trans fat", "g"],
    ["fiber_g", "Fibre", "g"],
    ["sugar_g", "Sugar", "g"],
    ["added_sugar_g", "Added sugar", "g"],
    ["alcohol_g", "Alcohol", "g"],
    ["caffeine_mg", "Caffeine", "mg"],
    ["sodium_mg", "Sodium", "mg"],
];

export function mealDetailBody(
    tz: string,
    m: Meal,
    items: MealItemValues[],
): Raw {
    return html` <p>
            <a href="/meals?date=${dateInTz(m.logged_at, tz)}">← Meals</a>
        </p>
        <h1>${m.description}</h1>
        <p class="sub">
            ${dateTimeIn(m.logged_at, tz)} ·
            ${tz}${m.meal_type ? html`<span class="tag">${m.meal_type}</span>` : ""}
        </p>
        <div class="grid two">
            <section class="card" aria-labelledby="d-nut">
                <h2 id="d-nut">Nutrition</h2>
                <div class="scroll">
                    <table>
                        <tbody>
                            ${NUTRIENT_ROWS.filter(
                                ([k]) => m[k] !== null && m[k] !== undefined,
                            ).map(
                                ([k, label, unit]) =>
                                    html`<tr>
                                        <th scope="row">${label}</th>
                                        <td class="num">
                                            ${n1(m[k] as number)} ${unit}
                                        </td>
                                    </tr>`,
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
            <section class="card" aria-labelledby="d-items">
                <h2 id="d-items">Ingredients</h2>
                ${
                    items.length
                        ? html`<div class="scroll">
                              <table>
                                  <thead>
                                      <tr>
                                          <th>Item</th>
                                          <th class="num">Amount</th>
                                          <th class="num">kcal</th>
                                          <th class="num">P</th>
                                          <th class="num">C</th>
                                          <th class="num">F</th>
                                      </tr>
                                  </thead>
                                  <tbody>
                                      ${items.map(
                                          (i) =>
                                              html`<tr>
                                                  <td>${i.name}</td>
                                                  <td class="num">
                                                      ${i.amount === null ? "–" : `${n1(i.amount)} ${i.unit ?? ""}`}
                                                  </td>
                                                  <td class="num">
                                                      ${n0(i.calories)}
                                                  </td>
                                                  <td class="num">
                                                      ${n0(i.protein_g)}
                                                  </td>
                                                  <td class="num">
                                                      ${n0(i.carbs_g)}
                                                  </td>
                                                  <td class="num">
                                                      ${n0(i.fat_g)}
                                                  </td>
                                              </tr>`,
                                      )}
                                  </tbody>
                              </table>
                          </div>`
                        : emptyState(
                              "This meal was logged as a total, without ingredients.",
                          )
                }
            </section>
        </div>
        ${
            m.notes
                ? html`<section class="card">
                      <h2>Notes</h2>
                      <p class="notes">${m.notes}</p>
                  </section>`
                : ""
        }`;
}

export function mealNotFoundBody(): Raw {
    return html`<h1>Meal not found</h1>
        <p class="sub">
            It may have been deleted. <a href="/meals">Back to meals</a>
        </p>`;
}

// ---------- Apple Health ----------

const FIELD_LABEL: Record<HealthSyncField, string> = {
    energy_kcal: "Energy (kcal)",
    protein_g: "Protein (g)",
    carbohydrates_g: "Carbs (g)",
    fat_g: "Fat (g)",
    fiber_g: "Fibre (g)",
    caffeine_mg: "Caffeine (mg)",
    water_ml: "Water (ml)",
};

export function healthBody(s: HealthSyncStatus, now: Date): Raw {
    const when = (iso: string | null) =>
        iso
            ? html`${ago(iso, now)}
                  <span class="muted">(${dateTimeIn(iso, s.timezone)})</span>`
            : html`<span class="muted">never</span>`;
    const fields = HEALTH_SYNC_FIELDS.filter((f) =>
        s.days.some(
            (d) => d.logged[f] !== undefined || d.sent[f] !== undefined,
        ),
    );
    const cell = (v: number | undefined) => (v === undefined ? "–" : n0(v));
    return html` <h1>Apple Health</h1>
        <p class="sub">
            What the iPhone shortcut has written to Apple Health. Days are in
            ${s.timezone}${s.timezone_source === "profile" ? "" : " (set a timezone with Claude to change this)"}.
        </p>
        <div class="grid three">
            <section class="card">
                <h2>Last sync</h2>
                <div>${when(s.last_sync_at)}</div>
                <p class="muted">The shortcut last asked for entries.</p>
            </section>
            <section class="card">
                <h2>Last data written</h2>
                <div>${when(s.last_ack_at)}</div>
                <p class="muted">Entries Health confirmed.</p>
            </section>
            <section class="card">
                <h2>Last activity sync</h2>
                <div>${when(s.last_activity_at)}</div>
                <p class="muted">Active calories read from Health.</p>
            </section>
        </div>
        <p>
            ${s.pending_entries > 0 ? html`<strong>${s.pending_entries}</strong> ${s.pending_entries === 1 ? "entry is" : "entries are"} waiting for the next run.` : "Nothing is waiting: Apple Health is up to date."}
        </p>
        ${s.notices.map((n) => html`<div class="notice">${n}</div>`)}
        ${
            s.discrepancies.length
                ? html`<section class="card" aria-labelledby="hd">
                      <h2 id="hd">Needs your attention</h2>
                      <p class="muted">
                          These days were logged lower than what Apple Health
                          already holds. Nothing is removed automatically; edit
                          them in the Health app if you want them to match.
                      </p>
                      <ul class="plain">
                          ${s.discrepancies.map(
                              (x) =>
                                  html`<li>
                                      ${longDate(x.date)} ·
                                      ${FIELD_LABEL[x.field]}: Health holds
                                      <strong>${n0(x.sent)}</strong>, logged now
                                      <strong>${n0(x.current)}</strong>
                                      (${n0(x.difference)})
                                  </li>`,
                          )}
                      </ul>
                  </section>`
                : ""
        }
        <section class="card" aria-labelledby="hdays">
            <h2 id="hdays">
                Logged vs sent (${longDate(s.window.from)} to
                ${longDate(s.window.to)})
            </h2>
            ${
                s.days.length
                    ? html`<div class="scroll">
                              <table>
                                  <thead>
                                      <tr>
                                          <th>Day</th>
                                          ${fields.map((f) => html`<th class="num">${FIELD_LABEL[f]}</th>`)}
                                          <th class="num">Sent</th>
                                      </tr>
                                  </thead>
                                  <tbody>
                                      ${s.days.map(
                                          (d) =>
                                              html`<tr>
                                                  <td>
                                                      ${longDate(d.date)}${d.closed ? "" : html` <span class="tag">today's window</span>`}
                                                  </td>
                                                  ${fields.map((f) => html`<td class="num"><span title="logged">${cell(d.logged[f])}</span> <span class="muted" title="sent to Health">/ ${cell(d.sent[f])}</span></td>`)}
                                                  <td class="num">
                                                      ${d.rounds}×
                                                  </td>
                                              </tr>`,
                                      )}
                                  </tbody>
                              </table>
                          </div>
                          <p class="muted">
                              Each cell is logged / sent to Health. “Sent”
                              counts how many hourly entries Health holds for
                              that day.
                          </p>`
                    : emptyState("No days in the sync window yet.")
            }
        </section>`;
}

// ---------- Settings ----------

const GOAL_ROWS: [keyof NutritionGoals, string, string, "limit" | "target"][] =
    [
        ["daily_calories", "Calories", "kcal", "target"],
        ["daily_protein_g", "Protein", "g", "target"],
        ["daily_carbs_g", "Carbs", "g", "target"],
        ["daily_fat_g", "Fat", "g", "target"],
        ["daily_fiber_g", "Fibre", "g", "target"],
        ["daily_water_ml", "Water", "ml", "target"],
        ["daily_saturated_fat_g", "Saturated fat", "g", "limit"],
        ["daily_sugar_g", "Sugar", "g", "limit"],
        ["daily_added_sugar_g", "Added sugar", "g", "limit"],
        ["daily_sodium_mg", "Sodium", "mg", "limit"],
        ["daily_caffeine_mg", "Caffeine", "mg", "limit"],
        ["daily_alcohol_g", "Alcohol", "g", "limit"],
    ];

export interface SettingsView {
    csrf: string;
    goals: NutritionGoals | null;
    tz: string;
    tzConfigured: boolean;
    weightUnit: string;
    lengthUnit: string;
    creditPct: number;
    alcohol: boolean;
    baseUrl: string;
    exportFile: { name: string; bytes: number; modified: string } | null;
    reveal?: { mcpUrl: string; shortcutKey: string; shortcutUrl: string };
    error?: string;
}

export function settingsBody(v: SettingsView): Raw {
    const g = v.goals;
    const setGoals = g
        ? GOAL_ROWS.filter(([k]) => g[k] !== null && g[k] !== undefined)
        : [];
    return html` <h1>Settings</h1>
        <p class="sub">
            Read-only. Change goals, timezone and units by asking Claude.
        </p>
        <div class="grid two">
            <section class="card" aria-labelledby="s-goals">
                <h2 id="s-goals">Goals</h2>
                ${
                    setGoals.length
                        ? html`<div class="scroll">
                              <table>
                                  <tbody>
                                      ${setGoals.map(
                                          ([k, label, unit, kind]) =>
                                              html`<tr>
                                                  <th scope="row">${label}</th>
                                                  <td class="num">
                                                      ${kind === "limit" ? "max " : ""}${n1(g![k] as number)}
                                                      ${unit}
                                                  </td>
                                              </tr>`,
                                      )}
                                  </tbody>
                              </table>
                          </div>`
                        : emptyState(
                              "No goals set. Ask Claude to set your daily targets.",
                          )
                }
            </section>
            <section class="card" aria-labelledby="s-prefs">
                <h2 id="s-prefs">Preferences</h2>
                <div class="scroll">
                    <table>
                        <tbody>
                            <tr>
                                <th scope="row">Timezone</th>
                                <td class="num">
                                    ${v.tz}${v.tzConfigured ? "" : " (default, not set)"}
                                </td>
                            </tr>
                            <tr>
                                <th scope="row">Weight unit</th>
                                <td class="num">${v.weightUnit}</td>
                            </tr>
                            <tr>
                                <th scope="row">Length unit</th>
                                <td class="num">${v.lengthUnit}</td>
                            </tr>
                            <tr>
                                <th scope="row">Active calories counted</th>
                                <td class="num">${v.creditPct}%</td>
                            </tr>
                            <tr>
                                <th scope="row">Alcohol tracking</th>
                                <td class="num">${v.alcohol ? "on" : "off"}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
            <section class="card wide" aria-labelledby="s-conn">
                <h2 id="s-conn">Connector</h2>
                ${v.error ? html`<div class="alert" role="alert">${v.error}</div>` : ""}
                <p class="muted">
                    Claude connects with the MCP URL; the iPhone shortcut sends
                    the shortcut key. Both stay hidden until you enter the
                    dashboard password.
                </p>
                <p>MCP URL: <code>${v.baseUrl}/mcp/••••••••</code></p>
                <p>
                    Shortcut: <code>Authorization: Bearer ••••••••</code> to
                    <code>${v.baseUrl}/api/v1/health-sync/</code>
                </p>
                ${
                    v.reveal
                        ? html`<div class="notice" role="status">
                              <strong>Keep these private.</strong> Anyone with
                              the MCP URL can read and change your food log.
                              <code class="secret">${v.reveal.mcpUrl}</code
                              ><button
                                  type="button"
                                  class="primary"
                                  data-copy="${v.reveal.mcpUrl}"
                              >
                                  Copy MCP URL
                              </button>
                              <code class="secret">${v.reveal.shortcutKey}</code
                              ><button
                                  type="button"
                                  data-copy="${v.reveal.shortcutKey}"
                              >
                                  Copy shortcut key
                              </button>
                          </div>`
                        : html`<form method="post" action="/settings/reveal">
                              <input
                                  type="hidden"
                                  name="csrf"
                                  value="${v.csrf}"
                              />
                              <div class="field">
                                  <label for="pw">Password</label
                                  ><input
                                      id="pw"
                                      type="password"
                                      name="password"
                                      autocomplete="current-password"
                                      required
                                      maxlength="200"
                                  />
                              </div>
                              <button class="primary" type="submit">
                                  Show MCP URL and shortcut key
                              </button>
                          </form>`
                }
            </section>
            <section class="card" aria-labelledby="s-exp">
                <h2 id="s-exp">Data export</h2>
                ${
                    v.exportFile
                        ? html`<p>
                                  An export from
                                  ${dateTimeIn(v.exportFile.modified, v.tz)}
                                  (${n1(v.exportFile.bytes / 1024)} KB) is
                                  ready.
                              </p>
                              <a
                                  class="btn primary"
                                  href="/exports/${v.exportFile.name}"
                                  download
                                  >Download ZIP</a
                              >`
                        : emptyState(
                              "No export yet. Ask Claude to export your data and it appears here for an hour.",
                          )
                }
            </section>
            <section class="card" aria-labelledby="s-sess">
                <h2 id="s-sess">Sessions</h2>
                <p class="muted">Signs out this browser and every other one.</p>
                <form method="post" action="/logout-all">
                    <input type="hidden" name="csrf" value="${v.csrf}" /><button
                        class="danger"
                        type="submit"
                    >
                        Sign out everywhere
                    </button>
                </form>
            </section>
        </div>`;
}
