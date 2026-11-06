# Apple Health shortcuts

Two iOS Shortcuts keep Apple Health in step with this server:

- **Nutrition Health sync** adds what you ate and drank to Apple Health (Dietary
  Energy, Protein, Carbohydrates, Total Fat, Fiber, Caffeine, and optionally
  Water). It runs **hourly** and adds only what was logged _since the last run_,
  so Health stays current through the day.
- **Nutrition Activity sync** reads your Active Energy from Apple Health and
  sends each day's total to the server (it replaces that day's figure; it never
  adds).

Nothing here is automatic until you build the shortcuts: this guide spells out
every action. Examples use `https://food.example.com` and `YOUR_KEY`; substitute
your own address and your shortcut key.

> **What is verified and what is not.** The server side (every route, the hourly
> algorithm, DST and the 05:00 close) is covered by automated tests and a scripted
> run that behaves exactly like the shortcut. The iPhone side was written from
> Apple's documentation and community reports; **nobody has run these recipes on
> a phone yet.** Section 8 lists exactly what to check on your iPhone, and
> section 9 what could not be verified.

## 1. How it works (so the recipes make sense)

For each of the last seven local days (today included, in your profile's
timezone) the server totals what you logged, subtracts what it has already told
Health ("sent so far"), and offers the _difference_ as one **entry** per day.

```
Shortcut  ->  GET  /api/v1/health-sync/pending   "what should I add?"
Shortcut  <-  { entries: [ { entry_id, date, sample_at, values: { energy_kcal: 250 } } ], lease_until }
Shortcut  :   Log Health Sample for each value, dated sample_at
Shortcut  ->  POST /api/v1/health-sync/ack       "I added exactly this"
```

- **Only the new amount** is offered, and only when it is big enough to matter
  (20 kcal, 2 g of protein/carbs/fat/fiber, 10 mg caffeine, 100 mL water). Once a
  day is over (05:00 the next morning) any remaining positive amount is offered
  once, as a final top-up.
- **Nothing is counted until you ack.** If a run dies half way, the next run is
  offered the same entry (same `entry_id`). An ack that is sent twice, or two
  overlapping runs, never count twice (a 2-minute lease makes the second run wait:
  `409 busy`).
- **Health can only be added to.** If you delete food after it reached Health,
  the server does _not_ send a negative number. The difference appears in
  `discrepancies` in the response, and on the dashboard's sync status; correct it
  by hand in the Health app (Browse → Nutrition → the type → Show All Data).
- Samples are dated `sample_at`: _now_ for today's entries; 23:59 on the day for
  earlier days, so Health files them under the right date.

Add a `?water=1` to the pending URL to include Water. Leave it out if another
app or your Watch already logs water.

## 2. Before you start

1. **Find your shortcut key.** It is the add-on option `shortcut_key`, or (when
   that is empty) the `shortcut_key` field of `keys.json` in the add-on's data
   folder; the server's startup log tells you where, never what. It is a
   different secret from the MCP connector URL's key.
2. **Test the server without a phone** (needs `curl` and `jq`):

    ```sh
    scripts/health-sync-curl.sh https://food.example.com YOUR_KEY
    ```

    Read-only by default. Every line should say OK; a `401` means a wrong key.

3. **Set your timezone in chat** (the `set_timezone` tool). The server buckets
   days by your profile's timezone, not the phone's.
4. **Allow Shortcuts to write to Health.** The first time each Log Health Sample
   action runs, iOS asks for permission for that data type. Run the shortcut by
   hand once and approve every type (Health → Sharing → Apps → Shortcuts shows
   them). An unattended run cannot answer that prompt.

### Where to keep the key

A Shortcut has no secret store. The two sensible places are:

- **A Text action at the top of the shortcut** holding the key (simple; fine for
  a shortcut that never leaves your devices). Never share the shortcut or its
  iCloud link afterwards: the key goes with it.
- **A note or file** read at the start (`Get Contents of File`), so the shortcut
  itself carries no secret and can be shared. Slightly more to set up.

Either way, if the key leaks, change `shortcut_key` and restart the server; the
old key stops working at once.

## 3. Recipe A: "Nutrition Health sync"

Create a new shortcut named **Nutrition Health sync**. Add these actions in order
(names are the English iOS labels; the app's search finds each).

**Setup**

1. **Text** → `YOUR_KEY`. Then **Set Variable** → `key`.
2. **Text** → `Bearer ` followed by the variable `key` (insert it with the
   variable picker so it shows as a blue token). **Set Variable** → `auth`.
3. **Text** → `https://food.example.com/api/v1/health-sync` → **Set Variable** →
   `api`.

**Ask the server what to add**

4. **Get Contents of URL**
    - URL: `api` + `/pending?water=1` (or without `?water=1`).
    - Show More → **Method: GET**.
    - **Headers** → add: key `Authorization`, value `auth` (the variable).
      (Check there is no stray space after `Authorization`.)
5. **Set Variable** → `pending` (the result is a Dictionary; Shortcuts parses the
   JSON for you).
6. **Get Dictionary Value** → `ok` from `pending`. **If** that value **is** `no`
   (JSON `false`):
    - **Get Dictionary Value** → `error` from `pending`.
    - **If** `error` **is** `busy`: **Stop Shortcut** (another run is in progress;
      this is normal, stay silent).
    - **Otherwise**: **Get Dictionary Value** `message` → **Show Notification**
      ("Nutrition sync failed: …") → **Stop Shortcut**.
    - **End If**.
    - **End If**.

    `401` (`error: unauthorized`) means the key is wrong; `503 unavailable` means
    the server could not read its database and _nothing was changed_: try again.

**Add each entry to Health**

7. **Get Dictionary Value** → `entries` from `pending`; **Set Variable** →
   `entries`. **Get Dictionary Value** → `lease_until` from `pending`; **Set
   Variable** → `lease`.
8. **Repeat with Each** item in `entries`. Inside the loop:
    1. **Get Dictionary Value** `values` from _Repeat Item_ → **Set Variable**
       `vals`. Also `entry_id` → `eid`, `date` → `edate`, and `sample_at` →
       `when`.
    2. **Get Dates from Input** with `when` → **Set Variable** `sampleDate`. (The
       text looks like `2026-10-03T10:00:00+03:00`; Shortcuts reads that as a
       date and time with its zone.)
    3. For **each field below**, add this block:
        - **Get Dictionary Value** `<key>` from `vals`.
        - **If** the result **has any value**:
          **Log Health Sample**: _Type_ = the Health type, _Value_ = the number
          (with the unit), _Date_ = `sampleDate`.
        - **End If**.

        | JSON key in `vals` | Health type to choose | Unit                                                     |
        | ------------------ | --------------------- | -------------------------------------------------------- |
        | `energy_kcal`      | Dietary Energy        | kilocalories                                             |
        | `protein_g`        | Protein               | grams                                                    |
        | `carbohydrates_g`  | Carbohydrates         | grams                                                    |
        | `fat_g`            | Total Fat             | grams                                                    |
        | `fiber_g`          | Fiber                 | grams                                                    |
        | `caffeine_mg`      | Caffeine              | milligrams                                               |
        | `water_ml`         | Water                 | milliliters (skip this block if you left out `?water=1`) |

        Seven blocks, one per type, is not laziness: the Log Health Sample action
        will not take its _Type_ from a variable (reported by users; check yours),
        so each type needs its own action.

    4. **Acknowledge this entry now** (before the next one, so a crash can only
       lose the entry in flight): **Get Contents of URL**
        - URL: `api` + `/ack`, **Method: POST**, header `Authorization` = `auth`.
        - **Request Body: JSON**, with fields:
          `entries` (Array) containing one **Dictionary** with `entry_id` (Text
          = `eid`), `date` (Text = `edate`) and `values` (Dictionary = `vals`);
          `done` (Boolean) = `no`.
        - The reply has `applied` and `skipped` counts; you can ignore it.
9. **End Repeat**.

**Release the lease and finish**

10. **Get Contents of URL** → `api` + `/ack`, **POST**, header `Authorization`,
    JSON body: `entries` = an empty Array, `done` = `yes`, `lease_until` = `lease`.
    (This frees the lease immediately so the next run is not told "busy".)
11. _Optional, for hand runs:_ **Get Dictionary Value** `count` from `pending` →
    **Show Notification** ("Added N entries to Health"). Leave this out of the
    hourly automation: it is the one notification you do not want 16 times a day.
    If `discrepancies` is not empty, a notification is worth showing; the text of
    each is `date`, `field`, `sent`, `current`.

> **If you want to ack once at the end instead:** inside the loop use **Add to
> Variable** (`acked`) with a Dictionary of `entry_id`, `date`, `values`, then one
> POST after the loop with `entries` = `acked`, `done` = `yes`, `lease_until` =
> `lease`. It is fewer actions but widens the window in which a crash leaves
> samples in Health that the server does not know about (they would be offered
> and logged again). Per-entry ack is the safer default.

## 4. Recipe B: "Nutrition Activity sync"

Active Energy changes all day, so the shortcut sends the **whole day's total** for
today and the six days before; the server replaces each day's figure.

1. Steps 1-3 of Recipe A (`key`, `auth`, `api`).
2. **Repeat** `7` times (index 1..7 → days back 0..6). Inside:
    1. **Adjust Date**: _Current Date_ minus `Repeat Index - 1` days → **Start of**
       **Day** (Adjust or **Get Start of Day** → `dayStart`).
    2. **Find Health Samples** where **Type is Active Energy** and **Start Date
       is in the last…** the same day (e.g. _is between_ `dayStart` and
       `dayStart` + 1 day). Turn **Group By: Day** on, **Fill Missing** off and
       **Limit** off, so you get one total per day (grouping avoids summing
       hundreds of Watch samples one by one). Sort order does not matter.
    3. **Get Details of Health Samples** → _Value_ (the day's total).
       If you cannot group, **Calculate Statistics → Sum** of the values instead.
    4. **Format Date**: `dayStart`, _Custom_ format `yyyy-MM-dd` → `dstr`.
    5. **Add to Variable** `days` ← a Dictionary with `date` (Text = `dstr`) and
       `active_kcal` (Number = the value; rounding is fine).
3. **Get Contents of URL**: `api` + `/activity`, **POST**, header
   `Authorization` = `auth`, **Request Body: JSON** with `days` (Array) = the
   variable `days`. Optionally `tz` (Text) = your IANA zone, used only when your
   profile has none.
4. The reply: `written` (days sent), `changed` (rows that actually changed),
   `skipped` (each with a reason: `zero`, `outside_window`, `too_high`).

Rules worth knowing: **a day of `0` writes nothing and removes nothing** (a read
Health refused looks like zero); anything older than six days or in the future is
skipped, not an error; manual active-calorie entries you logged in chat are never
touched.

## 5. Make it run hourly

Apple's _Time of Day_ automation repeats **Daily, Weekly or Monthly** only; there
is **no hourly repeat** (Apple Support, _Event triggers in Shortcuts_). Practical
options, most reliable first:

**Option 1: one Time-of-Day automation per slot (recommended).** In the Shortcuts
app: **Automation** tab → **+** → **Create Personal Automation** → **Time of Day**.

1. Choose a time (e.g. 07:00), **Repeat: Daily**, Next.
2. **Add Action → Run Shortcut →** _Nutrition Health sync_. Next.
3. Turn **Ask Before Running** off (some iOS versions word this _Run Immediately_)
   and **Notify When Run** off. Confirm with _Don't Ask_ if iOS asks.
4. Done. Repeat for every hour you want (07:00-22:00 is 16 automations). For the
   Activity shortcut, either add it to the same automations (add a second _Run
   Shortcut_ action) or use a few slots, e.g. 12:00, 18:00 and 22:30.

There is no way to duplicate an automation; each is created by hand (about a
minute each). The server is cheap per call: a run with nothing new offers
nothing and releases at once.

**Option 2: event triggers that fire often.** Create a Personal Automation with
the trigger **App → Is Opened** (pick an app you open many times a day), or
**Charger → Is Connected**, **Arrive/Leave** a place, **Wi-Fi** joined, **Focus**
on/off, or **Alarm** stopped. Same action and settings as above. These run only
when the event happens, so they give irregular coverage; use them _in addition
to_ a few time slots, not instead.

**Option 3: third-party schedulers** exist (MFC Deck, Cronios and similar). They
were not evaluated here and are not required.

Settings to check on the **shortcut** (the (i) button → Privacy): **Allow Running
When Locked** (Apple documents this for unattended automations). Whether Health
may be written while the phone is locked is _not_ something this guide can
promise; see section 9. If it will not run locked, keep the phone-unlocked
triggers (opening an app, picking it up with a Focus change) in the mix.

## 6. If something looks wrong

| Symptom                              | Cause / fix                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notification "unauthorized"          | Wrong or missing key, or a space after `Authorization`. Key is a bearer token: `Bearer <key>`.                                                                                             |
| Every run says busy                  | A previous run died holding the lease (it frees itself after 2 minutes).                                                                                                                   |
| Duplicated samples in Health         | A run wrote samples and died before acking. Delete the extras in Health → the type → Show All Data. Per-entry ack keeps this rare.                                                         |
| Totals in Health lower than the app  | An entry below the threshold waits until it adds up (or until the day closes at 05:00).                                                                                                    |
| Totals in Health higher than the app | Food was deleted after sync. See `discrepancies`; fix by hand in Health.                                                                                                                   |
| `discrepancies` never clears         | By design: the server never lowers Health. Once you log enough to pass the sent total, only the excess is added.                                                                           |
| Started over                         | `POST /api/v1/health-sync/revoke` with `{"confirm": true}` forgets what was sent, then the whole 7-day window is offered again. Delete the old samples in Health first or you will double. |

Check what the server thinks at any time:
`GET /api/v1/health-sync/status` (same Authorization header) returns the last
check-in, last write, last activity sync and, per day, logged vs sent vs pending.

## 7. API reference (for debugging)

All routes need `Authorization: Bearer YOUR_KEY` and answer
`{ "ok": true, ... }` or `{ "ok": false, "error": "...", "message": "..." }`.
A wrong key is `401`; too many wrong keys from one address is `429`.

| Route                                                      | Purpose                                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health-sync/pending[?water=1][&tz=Area/City]` | Entries to add, `lease_until`, `discrepancies`, `notices`.                                                                          |
| `POST /api/v1/health-sync/ack`                             | `{ "entries": [{ "entry_id", "date", "values" }], "done": false, "lease_until": "…" }` → `applied`, `skipped`, per-entry `results`. |
| `POST /api/v1/health-sync/activity`                        | `{ "tz"?: "…", "days": [{ "date": "YYYY-MM-DD", "active_kcal": 512 }] }` (1-8 days) → `written`, `changed`, `skipped`.              |
| `GET /api/v1/health-sync/status`                           | Clocks and the per-day view.                                                                                                        |
| `POST /api/v1/health-sync/revoke`                          | `{ "confirm": true }` forgets the ledger.                                                                                           |

## 8. Test checklist (do these on your iPhone, in order)

1. [ ] `scripts/health-sync-curl.sh https://food.example.com YOUR_KEY` prints
       `ALL ROUTES OK`.
2. [ ] In chat: set your timezone; log one meal (e.g. 300 kcal, 20 g protein).
3. [ ] Run **Nutrition Health sync** by hand. Approve every Health permission
       prompt. In Health → Browse → Nutrition → Dietary Energy → Show All Data
       there is **one** new sample of 300 kcal, source _Shortcuts_, dated now.
4. [ ] Run it again immediately: **no new samples**.
5. [ ] Log another meal (e.g. 150 kcal). Run again: **one new sample of 150**,
       not 450.
6. [ ] Log a 5 kcal snack. Run: nothing new (below the 20 kcal threshold). Log
       more until the unsent amount passes 20: only the unsent amount appears.
7. [ ] In chat, delete the 150 kcal meal. Run: no new sample and no negative
       one. The response's `discrepancies` (or the `status` route) shows it.
8. [ ] Break the key on purpose (add a letter): a notification names the problem
       and nothing is written; fix it.
9. [ ] Turn Airplane Mode on and run: the shortcut errors, Health unchanged. Turn
       it off and run: it catches up.
10. [ ] Run **Nutrition Activity sync**. In chat, the active calories for today
        match Apple Health's Active Energy. Move more, run again: the figure
        **replaces** the old one, it does not add.
11. [ ] Create one Time-of-Day automation for a few minutes from now with the
        settings in section 5. Lock the phone and wait: did it run (check the
        server's last check-in via `status`)? Note whether it ran while locked.
12. [ ] After a day of hourly runs, Health's daily totals equal the app's totals
        (within a few kcal).

## 9. What could not be verified without an iPhone

- **The action fields and labels** above come from Apple's Shortcuts guide and
  community references. Confirmed in sources: _Log Health Sample_ has a _Type_
  and an optional _Date_ ("the current date will be used if you don't provide a
  date"); _Get Contents of URL_ supports POST/PUT/PATCH with a JSON, Form or File
  request body and custom headers; Time of Day repeats Daily, Weekly or Monthly.
  **Not confirmed:** the exact _Value_/_Unit_ fields of Log Health Sample per
  nutrition type, how a JSON `true`/`false` shows in an _If_, and whether the
  nested Array/Dictionary body editor behaves as described on your iOS version.
- **Whether a dated sample (`sample_at`) is filed under that date in Health.**
  Expected from the _Date_ field; test step 3 and a yesterday top-up.
- **Locked-phone behaviour.** A reported limitation: Shortcuts can read Health
  data only while the phone is unlocked. Whether _writing_ works on a locked phone
  in a "run immediately" automation was not verified; step 11 tells you.
- **Time-of-Day reliability.** A developer-forum report says a Time-of-Day
  automation may not fire if the phone has been untouched for hours; the hourly
  slots are best effort. The server does not depend on the schedule: it catches
  up on the next run.
- **Grouping Active Energy by day** in _Find Health Samples_ and the exact
  statistics action are described from community recipes, not tested.
- **Permissions prompts** for each Health type cannot appear in an unattended
  run; approve them by running by hand first.

### Sources

- Apple Support, _Event triggers in Shortcuts_: <https://support.apple.com/guide/shortcuts/apd932ff833f/ios>
- Apple Support, _Add automations_: <https://support.apple.com/guide/shortcuts/add-automations-apdfbdbd7123/ios>
- Apple Support, _Request your first API_: <https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios>
- Matthew Cassinelli, _Log Health Sample_ action reference: <https://matthewcassinelli.com/actions/log-health-sample/>
- Apple Community, _Shortcuts - Log health sample_: <https://discussions.apple.com/thread/255593910>
- M. Heckel, _Using Shortcuts and serverless to build a personal Apple Health API_ (unlock requirement, 2-hour schedule): <https://blog.maximeheckel.com/posts/build-personal-health-api-shortcuts-serverless/>
