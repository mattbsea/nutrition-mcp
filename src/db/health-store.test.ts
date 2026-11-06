import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getDb } from "./conn.js";
import {
    HEALTH_SYNC_LINK_MAX_AGE_MS,
    createSqliteHealthActivityLinkStore,
    createSqliteHealthSyncStore,
    createSupabaseHealthActivityLinkStore,
    createSupabaseHealthSyncStore,
    sqliteHealthSyncCleanupStore,
    type HealthSyncDayRow,
} from "./repo.js";
import { OTHER, USER, useMemoryDb } from "./test-helpers.js";

useMemoryDb();

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NOW = new Date("2026-03-14T12:00:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const store = () => createSqliteHealthSyncStore();
const link = (over: object = {}) => ({
    fields: ["calories", "protein"],
    fallbackTz: "America/Denver",
    syncStartDate: "2026-03-10",
    expiresAt: iso(90 * DAY),
    ...over,
});

const dayRow = (
    date: string,
    over: Partial<HealthSyncDayRow> = {},
): HealthSyncDayRow => ({
    user_id: USER,
    date,
    timezone: "America/Denver",
    sent_values: null,
    topup_seq: 0,
    offer_count: 0,
    notified: {},
    first_sent_at: null,
    last_sent_at: null,
    ...over,
});

test("the Supabase-named factories are aliases of the SQLite ones (until A2 renames call sites)", () => {
    expect(createSupabaseHealthSyncStore).toBe(createSqliteHealthSyncStore);
    expect(createSupabaseHealthActivityLinkStore).toBe(
        createSqliteHealthActivityLinkStore,
    );
});

describe("pending connects and claims", () => {
    const pending = (over: object = {}) => ({
        kind: "health" as const,
        connectId: "connect-1",
        deviceSecret: "device-1",
        pkceVerifier: "verifier-1",
        fields: ["calories"],
        tz: "Europe/Berlin",
        backfillDays: 3,
        expiresAt: iso(30 * MIN),
        ...over,
    });

    test("secrets are stored only as sha256 hashes", async () => {
        await store().createPending(pending());
        const row = getDb()
            .query("SELECT * FROM health_sync_pending")
            .get() as Record<string, unknown>;
        expect(row.connect_id_hash).toBe(sha("connect-1"));
        expect(row.device_secret_hash).toBe(sha("device-1"));
        expect(JSON.stringify(row)).not.toContain("connect-1");
        expect(JSON.stringify(row)).not.toContain("device-1");
    });

    test("getPendingByConnectId returns the row without hash columns while unexpired", async () => {
        await store().createPending(pending());
        const got = await store().getPendingByConnectId("connect-1", NOW);
        expect(got).toMatchObject({
            kind: "health",
            fields: ["calories"],
            tz: "Europe/Berlin",
            backfill_days: 3,
            user_id: null,
        });
        expect(got).not.toHaveProperty("connect_id_hash");
        expect(await store().getPendingByConnectId("other", NOW)).toBeNull();
        // a stored hash presented as the secret matches nothing
        expect(
            await store().getPendingByConnectId(sha("connect-1"), NOW),
        ).toBeNull();
        expect(
            await store().getPendingByConnectId(
                "connect-1",
                new Date(NOW.getTime() + 31 * MIN),
            ),
        ).toBeNull();
    });

    test("setPendingClaim attaches once and clears the PKCE verifier; consumeClaim is single-use and needs both secrets", async () => {
        await store().createPending(pending());
        expect(
            await store().setPendingClaim(
                "connect-1",
                "claim-1",
                USER,
                iso(5 * MIN),
                NOW,
            ),
        ).toBe(true);
        expect(
            await store().setPendingClaim(
                "connect-1",
                "claim-2",
                USER,
                iso(5 * MIN),
                NOW,
            ),
        ).toBe(false);
        expect(
            (await store().getPendingByConnectId("connect-1", NOW))!
                .pkce_verifier,
        ).toBeNull();
        expect(
            await store().consumeClaim("claim-1", "wrong-device", NOW),
        ).toBeNull();
        expect(
            await store().consumeClaim("wrong-claim", "device-1", NOW),
        ).toBeNull();
        const consumed = await store().consumeClaim("claim-1", "device-1", NOW);
        expect(consumed).toMatchObject({
            user_id: USER,
            kind: "health",
            backfill_days: 3,
        });
        expect(
            await store().consumeClaim("claim-1", "device-1", NOW),
        ).toBeNull();
    });

    test("an expired claim cannot be consumed; an expired connect cannot be claimed", async () => {
        await store().createPending(pending());
        expect(
            await store().setPendingClaim(
                "connect-1",
                "c",
                USER,
                iso(MIN),
                NOW,
            ),
        ).toBe(true);
        expect(
            await store().consumeClaim(
                "c",
                "device-1",
                new Date(NOW.getTime() + 2 * MIN),
            ),
        ).toBeNull();
        await store().createPending(
            pending({ connectId: "connect-2", deviceSecret: "d2" }),
        );
        expect(
            await store().setPendingClaim(
                "connect-2",
                "c2",
                USER,
                iso(MIN),
                new Date(NOW.getTime() + 31 * MIN),
            ),
        ).toBe(false);
    });

    test("backfill_days outside 0..7 and an unknown kind are rejected", async () => {
        await expect(
            store().createPending(pending({ backfillDays: 8 })),
        ).rejects.toThrow();
        await expect(
            store().createPending(pending({ kind: "weird" })),
        ).rejects.toThrow();
    });
});

describe("the Health link", () => {
    test("replaceLink stores only the token hash; lookup validates, with expiry and age caps", async () => {
        await store().replaceLink(USER, link(), "nmhs_secret");
        const row = getDb()
            .query("SELECT token_hash FROM health_sync_links")
            .get() as { token_hash: string };
        expect(row.token_hash).toBe(sha("nmhs_secret"));

        const ok = await store().lookupLink("nmhs_secret", NOW);
        expect(ok.status).toBe("valid");
        if (ok.status === "valid") {
            expect(ok.link).toMatchObject({
                user_id: USER,
                kind: "shortcut",
                fields: ["calories", "protein"],
                sync_start_date: "2026-03-10",
                lease_until: null,
            });
            expect(ok.link).not.toHaveProperty("token_hash");
        }
        expect((await store().lookupLink("nope", NOW)).status).toBe("invalid");
        expect((await store().lookupLink(sha("nmhs_secret"), NOW)).status).toBe(
            "invalid",
        );
        // past the sliding expiry
        expect(
            (
                await store().lookupLink(
                    "nmhs_secret",
                    new Date(NOW.getTime() + 91 * DAY),
                )
            ).status,
        ).toBe("invalid");
    });

    test("a link older than the 365-day cap is refused however recently used", async () => {
        await store().replaceLink(
            USER,
            link({ expiresAt: iso(1000 * DAY) }),
            "tok",
        );
        const future = new Date(Date.now() + HEALTH_SYNC_LINK_MAX_AGE_MS + DAY);
        expect((await store().lookupLink("tok", future)).status).toBe(
            "invalid",
        );
        expect(await store().getLinkStatus(USER, future)).toBeNull();
        expect((await store().lookupLink("tok")).status).toBe("valid");
    });

    test("replaceLink swaps the token in place and resets lease/last-sync, keeping one row and the sent record", async () => {
        await store().replaceLink(USER, link(), "old");
        await store().insertDays([
            dayRow("2026-03-12", { sent_values: { calories: 100 } }),
        ]);
        expect(await store().acquireLease(USER, iso(2 * MIN))).toBe(true);
        await store().setLastSync(USER, iso(0));
        await store().replaceLink(USER, link({ fields: ["calories"] }), "new");
        expect((await store().lookupLink("old")).status).toBe("invalid");
        const fresh = await store().lookupLink("new", NOW);
        expect(fresh.status === "valid" && fresh.link).toMatchObject({
            fields: ["calories"],
            lease_until: null,
            last_sync_at: null,
        });
        expect(
            getDb().query("SELECT count(*) n FROM health_sync_links").get(),
        ).toEqual({ n: 1 });
        expect(
            await store().getDays(USER, "2026-03-01", "2026-03-31"),
        ).toHaveLength(1);
    });

    test("touchLink and setLastSync stamp the link", async () => {
        await store().replaceLink(USER, link(), "tok");
        await store().touchLink(USER, iso(MIN), iso(30 * DAY));
        await store().setLastSync(USER, iso(2 * MIN));
        const st = await store().getLinkStatus(USER, NOW);
        expect(st).toMatchObject({
            kind: "shortcut",
            last_used_at: iso(MIN),
            last_sync_at: iso(2 * MIN),
            expires_at: iso(30 * DAY),
            sent_through: null,
        });
        expect(st).not.toHaveProperty("token_hash");
    });

    test("the lease: one winner, held until it lapses, released only by its holder", async () => {
        await store().replaceLink(USER, link(), "tok");
        expect(await store().acquireLease(USER, iso(2 * MIN), NOW)).toBe(true);
        expect(await store().acquireLease(USER, iso(3 * MIN), NOW)).toBe(false);
        // lapsed
        expect(
            await store().acquireLease(
                USER,
                iso(10 * MIN),
                new Date(NOW.getTime() + 3 * MIN),
            ),
        ).toBe(true);
        // a stale holder cannot release the newer lease
        await store().releaseLease(USER, iso(2 * MIN));
        expect(
            await store().acquireLease(
                USER,
                iso(20 * MIN),
                new Date(NOW.getTime() + 4 * MIN),
            ),
        ).toBe(false);
        await store().releaseLease(USER, iso(10 * MIN));
        expect(
            await store().acquireLease(
                USER,
                iso(20 * MIN),
                new Date(NOW.getTime() + 4 * MIN),
            ),
        ).toBe(true);
        await store().releaseLease(USER);
        expect(
            await store().acquireLease(
                USER,
                iso(30 * MIN),
                new Date(NOW.getTime() + 5 * MIN),
            ),
        ).toBe(true);
        await store().releaseLease(USER, "not a date"); // never throws, never matches
    });

    test("acquireLease on a user without a link is false", async () => {
        expect(await store().acquireLease(USER, iso(MIN))).toBe(false);
    });

    test("another owner's link is invisible to owner-scoped calls", async () => {
        await store().replaceLink(OTHER, link(), "theirs");
        expect(await store().getLinkStatus(USER, NOW)).toBeNull();
        expect(await store().acquireLease(USER, iso(MIN))).toBe(false);
    });
});

describe("sent-day ledger", () => {
    test("insertDays inserts only new dates and leaves existing rows exactly as they are", async () => {
        const first = await store().insertDays([
            dayRow("2026-03-12"),
            dayRow("2026-03-13"),
        ]);
        expect(first).toEqual(["2026-03-12", "2026-03-13"]);
        await store().updateDay(
            USER,
            "2026-03-12",
            { sent_values: { calories: 500 }, topup_seq: 1 },
            { topup_seq: 0, sentNull: true },
        );
        const again = await store().insertDays([
            dayRow("2026-03-12", { timezone: "UTC" }),
            dayRow("2026-03-14"),
        ]);
        expect(again).toEqual(["2026-03-14"]);
        const [d12] = await store().getDays(USER, "2026-03-12", "2026-03-12");
        expect(d12).toMatchObject({
            timezone: "America/Denver",
            sent_values: { calories: 500 },
            topup_seq: 1,
        });
        expect(await store().insertDays([])).toEqual([]);
    });

    test("getDays is a date-ordered inclusive window with JSON columns parsed", async () => {
        await store().insertDays([
            dayRow("2026-03-13", { notified: { a: 1 } }),
            dayRow("2026-03-11", { sent_values: { calories: 1, protein: 2 } }),
            dayRow("2026-03-15"),
        ]);
        const got = await store().getDays(USER, "2026-03-11", "2026-03-13");
        expect(got.map((d) => d.date)).toEqual(["2026-03-11", "2026-03-13"]);
        expect(got[0]!.sent_values).toEqual({ calories: 1, protein: 2 });
        expect(got[1]!.notified).toEqual({ a: 1 });
        expect(got[1]!.sent_values).toBeNull();
    });

    test("updateDay is compare-and-set on topup_seq and on sent_values null-ness", async () => {
        await store().insertDays([dayRow("2026-03-12")]);
        const patch = {
            sent_values: { calories: 100 },
            topup_seq: 1,
            last_sent_at: iso(0),
            first_sent_at: iso(0),
            notified: { x: true },
            offer_count: 2,
        };
        // wrong expectation: it is still null, not set
        expect(
            await store().updateDay(USER, "2026-03-12", patch, {
                topup_seq: 0,
                sentNull: false,
            }),
        ).toBe(false);
        // wrong seq
        expect(
            await store().updateDay(USER, "2026-03-12", patch, {
                topup_seq: 5,
                sentNull: true,
            }),
        ).toBe(false);
        expect(
            await store().updateDay(USER, "2026-03-12", patch, {
                topup_seq: 0,
                sentNull: true,
            }),
        ).toBe(true);
        // a second writer that read the old state loses
        expect(
            await store().updateDay(
                USER,
                "2026-03-12",
                { offer_count: 9 },
                { topup_seq: 0, sentNull: true },
            ),
        ).toBe(false);
        // the winner's view
        expect(
            await store().updateDay(
                USER,
                "2026-03-12",
                { topup_seq: 2, sent_values: { calories: 150 } },
                { topup_seq: 1, sentNull: false },
            ),
        ).toBe(true);
        const [row] = await store().getDays(USER, "2026-03-12", "2026-03-12");
        expect(row).toMatchObject({
            sent_values: { calories: 150 },
            topup_seq: 2,
            offer_count: 2,
            notified: { x: true },
            first_sent_at: iso(0),
        });
        expect(
            await store().updateDay(
                USER,
                "2026-03-99",
                { offer_count: 1 },
                { topup_seq: 0, sentNull: true },
            ),
        ).toBe(false);
    });

    test("getLinkStatus reports the latest acknowledged day as sent_through", async () => {
        await store().replaceLink(USER, link(), "tok");
        await store().insertDays([
            dayRow("2026-03-11", { sent_values: { calories: 1 } }),
            dayRow("2026-03-12", { sent_values: { calories: 2 } }),
            dayRow("2026-03-13"), // offered, never acknowledged
        ]);
        expect((await store().getLinkStatus(USER, NOW))!.sent_through).toBe(
            "2026-03-12",
        );
    });

    test("getDaysForExport returns everything oldest first", async () => {
        await store().insertDays([dayRow("2026-03-13"), dayRow("2026-03-11")]);
        expect(
            (await store().getDaysForExport(USER)).map((d) => d.date),
        ).toEqual(["2026-03-11", "2026-03-13"]);
    });

    test("deleteLink removes the link and every sent-values row together", async () => {
        await store().replaceLink(USER, link(), "tok");
        await store().insertDays([dayRow("2026-03-11")]);
        await store().deleteLink(USER);
        expect((await store().lookupLink("tok")).status).toBe("invalid");
        expect(await store().getDaysForExport(USER)).toEqual([]);
    });

    test("another owner's days are invisible and untouched", async () => {
        await store().insertDays([dayRow("2026-03-11", { user_id: OTHER })]);
        expect(await store().getDays(USER, "2026-03-01", "2026-03-31")).toEqual(
            [],
        );
        expect(
            await store().updateDay(
                USER,
                "2026-03-11",
                { offer_count: 1 },
                { topup_seq: 0, sentNull: true },
            ),
        ).toBe(false);
        await store().deleteLink(USER);
        expect(
            await store().getDays(OTHER, "2026-03-01", "2026-03-31"),
        ).toHaveLength(1);
    });
});

describe("retention sweeps", () => {
    test("deleteExpiredPending: lapsed unclaimed connects and lapsed claims go; live ones stay", async () => {
        const mk = (id: string, expires: number) =>
            store().createPending({
                kind: "health",
                connectId: id,
                deviceSecret: `d-${id}`,
                pkceVerifier: "v",
                fields: [],
                tz: null,
                backfillDays: 0,
                expiresAt: iso(expires),
            });
        await mk("unclaimed-live", 30 * MIN);
        await mk("unclaimed-lapsed", -MIN);
        await mk("claimed-live", -MIN); // connect window lapsed, but claim is still live
        await store().setPendingClaim(
            "claimed-live",
            "cc1",
            USER,
            iso(10 * MIN),
            new Date(NOW.getTime() - 2 * MIN),
        );
        await mk("claimed-lapsed", 30 * MIN);
        await store().setPendingClaim(
            "claimed-lapsed",
            "cc2",
            USER,
            iso(-MIN),
            NOW,
        );
        expect(
            await sqliteHealthSyncCleanupStore.deleteExpiredPending(
                NOW.toISOString(),
            ),
        ).toBe(2);
        const left = (
            getDb()
                .query("SELECT count(*) n FROM health_sync_pending")
                .get() as { n: number }
        ).n;
        expect(left).toBe(2);
    });

    test("deleteExpiredLinks / deleteExpiredActivityLinks / deleteDaysBefore", async () => {
        await store().replaceLink(
            USER,
            link({ expiresAt: iso(-MIN) }),
            "expired",
        );
        expect(
            await sqliteHealthSyncCleanupStore.deleteExpiredLinks(
                NOW.toISOString(),
                "2000-01-01T00:00:00.000Z",
            ),
        ).toBe(1);
        expect(await countLinks()).toBe(0);
        await createSqliteHealthActivityLinkStore().replaceActivityLink(
            USER,
            { fallbackTz: null, expiresAt: iso(-MIN) },
            "a",
        );
        expect(
            await sqliteHealthSyncCleanupStore.deleteExpiredActivityLinks(
                NOW.toISOString(),
                "2000-01-01T00:00:00.000Z",
            ),
        ).toBe(1);
        await store().insertDays([
            dayRow("2026-03-01"),
            dayRow("2026-03-10"),
            dayRow("2026-03-12"),
        ]);
        expect(
            await sqliteHealthSyncCleanupStore.deleteDaysBefore("2026-03-10"),
        ).toBe(1);
        expect(
            (await store().getDaysForExport(USER)).map((d) => d.date),
        ).toEqual(["2026-03-10", "2026-03-12"]);
    });

    test("a link created before the cap cutoff is swept even if its expiry is in the future", async () => {
        await store().replaceLink(USER, link(), "tok");
        const future = new Date(Date.now() + 2 * HEALTH_SYNC_LINK_MAX_AGE_MS);
        const cutoff = new Date(
            future.getTime() - HEALTH_SYNC_LINK_MAX_AGE_MS,
        ).toISOString();
        expect(
            await sqliteHealthSyncCleanupStore.deleteExpiredLinks(
                new Date(0).toISOString(),
                cutoff,
            ),
        ).toBe(1);
    });
});

async function countLinks() {
    return (
        getDb().query("SELECT count(*) n FROM health_sync_links").get() as {
            n: number;
        }
    ).n;
}

describe("the Activity link", () => {
    const act = () => createSqliteHealthActivityLinkStore();
    const alink = (over: object = {}) => ({
        fallbackTz: "Europe/Paris",
        expiresAt: iso(90 * DAY),
        ...over,
    });

    test("hashes the token, validates, replaces in place, and is independent of the Health link", async () => {
        await act().replaceActivityLink(USER, alink(), "nmhs_act");
        expect(
            (
                getDb()
                    .query("SELECT token_hash FROM health_activity_links")
                    .get() as { token_hash: string }
            ).token_hash,
        ).toBe(sha("nmhs_act"));
        const ok = await act().lookupActivityLink("nmhs_act", NOW);
        expect(ok.status === "valid" && ok.link).toMatchObject({
            user_id: USER,
            fallback_tz: "Europe/Paris",
            last_sync_at: null,
        });
        expect((await act().lookupActivityLink("nope", NOW)).status).toBe(
            "invalid",
        );
        // a Health token is not accepted as an Activity token, and vice versa
        await store().replaceLink(USER, link(), "nmhs_health");
        expect(
            (await act().lookupActivityLink("nmhs_health", NOW)).status,
        ).toBe("invalid");
        expect((await store().lookupLink("nmhs_act", NOW)).status).toBe(
            "invalid",
        );
        await act().replaceActivityLink(
            USER,
            alink({ fallbackTz: null }),
            "nmhs_act2",
        );
        expect((await act().lookupActivityLink("nmhs_act", NOW)).status).toBe(
            "invalid",
        );
        expect((await act().lookupActivityLink("nmhs_act2", NOW)).status).toBe(
            "valid",
        );
        expect(
            getDb().query("SELECT count(*) n FROM health_activity_links").get(),
        ).toEqual({ n: 1 });
    });

    test("touch / setActivitySynced (zone kept when null) / status / expiry / delete", async () => {
        await act().replaceActivityLink(USER, alink(), "t");
        await act().touchActivityLink(USER, iso(MIN), iso(40 * DAY));
        await act().setActivitySynced(USER, iso(2 * MIN), "Asia/Tokyo");
        await act().setActivitySynced(USER, iso(3 * MIN), null);
        const st = await act().getActivityLinkStatus(USER, NOW);
        expect(st).toMatchObject({
            fallback_tz: "Asia/Tokyo",
            last_used_at: iso(MIN),
            last_sync_at: iso(3 * MIN),
            expires_at: iso(40 * DAY),
        });
        expect(st).not.toHaveProperty("token_hash");
        expect(
            await act().getActivityLinkStatus(
                USER,
                new Date(NOW.getTime() + 41 * DAY),
            ),
        ).toBeNull();
        await act().deleteActivityLink(USER);
        expect(await act().getActivityLinkStatus(USER, NOW)).toBeNull();
    });

    test("another owner's activity link is invisible", async () => {
        await act().replaceActivityLink(OTHER, alink(), "theirs");
        expect(await act().getActivityLinkStatus(USER, NOW)).toBeNull();
        await act().deleteActivityLink(USER);
        expect(await act().getActivityLinkStatus(OTHER, NOW)).not.toBeNull();
    });
});
