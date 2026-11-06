/**
 * Persistence for Apple Health sync on SQLite: the pending connect rows, the
 * one link per owner the Shortcut syncs with, the 8-day record of what was
 * sent, and the Activity shortcut's link. Same interfaces as
 * src/health-sync-store.ts (so the routes need no change), same hashing rule:
 * every secret crosses these interfaces RAW and is hashed here, on write and
 * on lookup alike, so a stored hash presented as the secret matches nothing.
 */
import { hashSecret } from "../token-hash.js";
import { HEALTH_SYNC_LINK_MAX_DAYS } from "../health-sync.js";
import { getDb } from "./conn.js";
import { fromJson, marks, toJson, ts, tx, type Row } from "./util.js";
import type {
    HealthActivityLinkLookup,
    HealthActivityLinkRow,
    HealthActivityLinkStatus,
    HealthActivityLinkStore,
    HealthSyncCleanupStore,
    HealthSyncDayRow,
    HealthSyncLinkLookup,
    HealthSyncLinkRow,
    HealthSyncLinkStatus,
    HealthSyncPendingRow,
    HealthSyncStore,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A link is refused this long after it was created, however recently used. */
export const HEALTH_SYNC_LINK_MAX_AGE_MS = HEALTH_SYNC_LINK_MAX_DAYS * DAY_MS;

const PENDING_COLUMNS =
    "id, kind, fields, tz, backfill_days, pkce_verifier, user_id, claim_expires_at, created_at, expires_at";
const LINK_COLUMNS =
    "id, user_id, kind, fields, fallback_tz, sync_start_date, lease_until, created_at, last_used_at, last_sync_at, expires_at";
const DAY_COLUMNS =
    "user_id, date, timezone, sent_values, topup_seq, offer_count, notified, first_sent_at, last_sent_at";
const ACTIVITY_LINK_COLUMNS =
    "id, user_id, fallback_tz, created_at, last_used_at, last_sync_at, expires_at";

const nowIso = (now?: Date) => (now ?? new Date()).toISOString();
const liveSince = (at: Date) =>
    new Date(at.getTime() - HEALTH_SYNC_LINK_MAX_AGE_MS).toISOString();

const pendingFromRow = (r: Row): HealthSyncPendingRow =>
    ({
        ...r,
        fields: fromJson<string[]>(r.fields) ?? [],
    }) as unknown as HealthSyncPendingRow;
const linkFromRow = (r: Row): HealthSyncLinkRow =>
    ({
        ...r,
        fields: fromJson<string[]>(r.fields) ?? [],
    }) as unknown as HealthSyncLinkRow;
const dayFromRow = (r: Row): HealthSyncDayRow =>
    ({
        ...r,
        sent_values: fromJson(r.sent_values),
        notified: fromJson(r.notified) ?? {},
    }) as unknown as HealthSyncDayRow;

export function createSqliteHealthSyncStore(): HealthSyncStore {
    return {
        async createPending(input) {
            try {
                getDb()
                    .query(
                        `INSERT INTO health_sync_pending
                         (kind, connect_id_hash, device_secret_hash, pkce_verifier, fields, tz, backfill_days, expires_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        input.kind,
                        hashSecret(input.connectId),
                        hashSecret(input.deviceSecret),
                        input.pkceVerifier,
                        JSON.stringify(input.fields),
                        input.tz,
                        input.backfillDays,
                        ts(input.expiresAt),
                    );
            } catch (error) {
                throw new Error(
                    `Failed to store pending health sync: ${(error as Error).message}`,
                );
            }
        },

        async getPendingByConnectId(connectId, now) {
            const row = getDb()
                .query(
                    `SELECT ${PENDING_COLUMNS} FROM health_sync_pending WHERE connect_id_hash = ? AND expires_at > ?`,
                )
                .get(hashSecret(connectId), nowIso(now)) as Row | null;
            return row ? pendingFromRow(row) : null;
        },

        async setPendingClaim(
            connectId,
            claimCode,
            userId,
            claimExpiresAt,
            now,
        ) {
            const res = getDb()
                .query(
                    `UPDATE health_sync_pending
                     SET claim_code_hash = ?, user_id = ?, claim_expires_at = ?, pkce_verifier = NULL
                     WHERE connect_id_hash = ? AND claim_code_hash IS NULL AND expires_at > ?`,
                )
                .run(
                    hashSecret(claimCode),
                    userId,
                    ts(claimExpiresAt),
                    hashSecret(connectId),
                    nowIso(now),
                );
            return res.changes > 0;
        },

        async consumeClaim(claimCode, deviceSecret, now) {
            // DELETE ... RETURNING: of two concurrent redemptions, one gets
            // the row and the other nothing.
            const row = getDb()
                .query(
                    `DELETE FROM health_sync_pending
                     WHERE claim_code_hash = ? AND device_secret_hash = ? AND claim_expires_at > ?
                     RETURNING ${PENDING_COLUMNS}`,
                )
                .get(
                    hashSecret(claimCode),
                    hashSecret(deviceSecret),
                    nowIso(now),
                ) as Row | null;
            return row ? pendingFromRow(row) : null;
        },

        async replaceLink(userId, link, token) {
            // One upsert on the unique user_id: the old token stops working in
            // the same statement the new one starts. Every column is written,
            // so nothing (a lease, the last sync) carries over. The sent record
            // in health_sync_days is kept: it stops a reconnected phone
            // re-sending days Apple Health already has.
            try {
                getDb()
                    .query(
                        `INSERT INTO health_sync_links
                         (user_id, token_hash, kind, fields, fallback_tz, sync_start_date, lease_until, created_at, last_used_at, last_sync_at, expires_at)
                         VALUES (?, ?, 'shortcut', ?, ?, ?, NULL, ?, NULL, NULL, ?)
                         ON CONFLICT (user_id) DO UPDATE SET
                           token_hash = excluded.token_hash, kind = excluded.kind, fields = excluded.fields,
                           fallback_tz = excluded.fallback_tz, sync_start_date = excluded.sync_start_date,
                           lease_until = NULL, created_at = excluded.created_at, last_used_at = NULL,
                           last_sync_at = NULL, expires_at = excluded.expires_at`,
                    )
                    .run(
                        userId,
                        hashSecret(token),
                        JSON.stringify(link.fields),
                        link.fallbackTz,
                        link.syncStartDate,
                        new Date().toISOString(),
                        ts(link.expiresAt),
                    );
            } catch (error) {
                throw new Error(
                    `Failed to store health sync link: ${(error as Error).message}`,
                );
            }
        },

        async lookupLink(token, now): Promise<HealthSyncLinkLookup> {
            const at = now ?? new Date();
            try {
                const row = getDb()
                    .query(
                        `SELECT ${LINK_COLUMNS} FROM health_sync_links
                         WHERE token_hash = ? AND expires_at > ? AND created_at > ?`,
                    )
                    .get(
                        hashSecret(token),
                        at.toISOString(),
                        liveSince(at),
                    ) as Row | null;
                if (!row) return { status: "invalid" };
                return { status: "valid", link: linkFromRow(row) };
            } catch {
                return { status: "unavailable" };
            }
        },

        async touchLink(userId, lastUsedAt, expiresAt) {
            getDb()
                .query(
                    "UPDATE health_sync_links SET last_used_at = ?, expires_at = ? WHERE user_id = ?",
                )
                .run(ts(lastUsedAt), ts(expiresAt), userId);
        },

        async setLastSync(userId, at) {
            getDb()
                .query(
                    "UPDATE health_sync_links SET last_sync_at = ? WHERE user_id = ?",
                )
                .run(ts(at), userId);
        },

        async acquireLease(userId, until, now) {
            // Free or lapsed, in one conditional UPDATE, so two concurrent
            // syncs cannot both win.
            const res = getDb()
                .query(
                    `UPDATE health_sync_links SET lease_until = ?
                     WHERE user_id = ? AND (lease_until IS NULL OR lease_until < ?)`,
                )
                .run(ts(until), userId, nowIso(now));
            return res.changes > 0;
        },

        async releaseLease(userId, heldUntil) {
            if (heldUntil === undefined) {
                getDb()
                    .query(
                        "UPDATE health_sync_links SET lease_until = NULL WHERE user_id = ?",
                    )
                    .run(userId);
                return;
            }
            let held: string;
            try {
                held = ts(heldUntil);
            } catch {
                return; // not an instant: it cannot be the lease we hold
            }
            getDb()
                .query(
                    "UPDATE health_sync_links SET lease_until = NULL WHERE user_id = ? AND lease_until = ?",
                )
                .run(userId, held);
        },

        async getDays(userId, from, to) {
            return (
                getDb()
                    .query(
                        `SELECT ${DAY_COLUMNS} FROM health_sync_days WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
                    )
                    .all(userId, from, to) as Row[]
            ).map(dayFromRow);
        },

        async insertDays(rows) {
            if (rows.length === 0) return [];
            // ON CONFLICT DO NOTHING: only rows that were new count.
            return tx((db) => {
                const stmt = db.query(
                    `INSERT INTO health_sync_days (${DAY_COLUMNS}) VALUES (${marks(9)})
                     ON CONFLICT (user_id, date) DO NOTHING`,
                );
                const inserted: string[] = [];
                for (const r of rows) {
                    const res = stmt.run(
                        r.user_id,
                        r.date,
                        r.timezone,
                        toJson(r.sent_values),
                        r.topup_seq ?? 0,
                        r.offer_count ?? 0,
                        JSON.stringify(r.notified ?? {}),
                        r.first_sent_at ? ts(r.first_sent_at) : null,
                        r.last_sent_at ? ts(r.last_sent_at) : null,
                    );
                    if (res.changes > 0) inserted.push(r.date);
                }
                return inserted;
            });
        },

        async updateDay(userId, date, patch, expect) {
            const cols: Row = {};
            if (patch.timezone !== undefined) cols.timezone = patch.timezone;
            if (patch.sent_values !== undefined)
                cols.sent_values = toJson(patch.sent_values);
            if (patch.topup_seq !== undefined) cols.topup_seq = patch.topup_seq;
            if (patch.offer_count !== undefined)
                cols.offer_count = patch.offer_count;
            if (patch.notified !== undefined)
                cols.notified = JSON.stringify(patch.notified);
            if (patch.first_sent_at !== undefined)
                cols.first_sent_at = patch.first_sent_at
                    ? ts(patch.first_sent_at)
                    : null;
            if (patch.last_sent_at !== undefined)
                cols.last_sent_at = patch.last_sent_at
                    ? ts(patch.last_sent_at)
                    : null;
            const names = Object.keys(cols);
            if (names.length === 0) return false;
            const res = getDb()
                .query(
                    `UPDATE health_sync_days SET ${names.map((n) => `${n} = ?`).join(", ")}
                     WHERE user_id = ? AND date = ? AND topup_seq = ?
                       AND sent_values IS ${expect.sentNull ? "" : "NOT "}NULL`,
                )
                .run(
                    ...(Object.values(cols) as never[]),
                    userId,
                    date,
                    expect.topup_seq,
                );
            return res.changes > 0;
        },

        async deleteLink(userId) {
            // The link first: once it is gone no sync can write another day.
            tx((db) => {
                db.query("DELETE FROM health_sync_links WHERE user_id = ?").run(
                    userId,
                );
                db.query("DELETE FROM health_sync_days WHERE user_id = ?").run(
                    userId,
                );
            });
        },

        async getLinkStatus(userId, now): Promise<HealthSyncLinkStatus | null> {
            const at = now ?? new Date();
            const db = getDb();
            // The same two bounds as lookupLink: a link the API already
            // refuses is not "connected", sweep or no sweep.
            const link = db
                .query(
                    `SELECT kind, fields, fallback_tz, sync_start_date, created_at, last_used_at, last_sync_at, expires_at
                     FROM health_sync_links WHERE user_id = ? AND expires_at > ? AND created_at > ?`,
                )
                .get(userId, at.toISOString(), liveSince(at)) as Row | null;
            if (!link) return null;
            const latest = db
                .query<{ date: string }, [string]>(
                    "SELECT date FROM health_sync_days WHERE user_id = ? AND sent_values IS NOT NULL ORDER BY date DESC LIMIT 1",
                )
                .get(userId);
            return {
                ...(link as unknown as Omit<
                    HealthSyncLinkStatus,
                    "sent_through" | "fields"
                >),
                fields: fromJson<string[]>(link.fields) ?? [],
                sent_through: latest?.date ?? null,
            };
        },

        async getDaysForExport(userId) {
            return (
                getDb()
                    .query(
                        `SELECT ${DAY_COLUMNS} FROM health_sync_days WHERE user_id = ? ORDER BY date ASC`,
                    )
                    .all(userId) as Row[]
            ).map(dayFromRow);
        },
    };
}

// ---------- Retention sweeps ----------

export const sqliteHealthSyncCleanupStore: HealthSyncCleanupStore = {
    async deleteExpiredPending(nowIso) {
        return getDb()
            .query(
                `DELETE FROM health_sync_pending
                 WHERE (claim_expires_at IS NULL AND expires_at < ?1) OR claim_expires_at < ?1`,
            )
            .run(nowIso).changes;
    },

    async deleteExpiredLinks(nowIso, createdBeforeIso) {
        return getDb()
            .query(
                "DELETE FROM health_sync_links WHERE expires_at < ? OR created_at < ?",
            )
            .run(nowIso, createdBeforeIso).changes;
    },

    async deleteExpiredActivityLinks(nowIso, createdBeforeIso) {
        return getDb()
            .query(
                "DELETE FROM health_activity_links WHERE expires_at < ? OR created_at < ?",
            )
            .run(nowIso, createdBeforeIso).changes;
    },

    async deleteDaysBefore(beforeDate) {
        return getDb()
            .query("DELETE FROM health_sync_days WHERE date < ?")
            .run(beforeDate).changes;
    },
};

// ---------- Activity links ----------

export function createSqliteHealthActivityLinkStore(): HealthActivityLinkStore {
    return {
        async replaceActivityLink(userId, link, token) {
            try {
                getDb()
                    .query(
                        `INSERT INTO health_activity_links (user_id, token_hash, fallback_tz, created_at, last_used_at, last_sync_at, expires_at)
                         VALUES (?, ?, ?, ?, NULL, NULL, ?)
                         ON CONFLICT (user_id) DO UPDATE SET
                           token_hash = excluded.token_hash, fallback_tz = excluded.fallback_tz,
                           created_at = excluded.created_at, last_used_at = NULL, last_sync_at = NULL,
                           expires_at = excluded.expires_at`,
                    )
                    .run(
                        userId,
                        hashSecret(token),
                        link.fallbackTz,
                        new Date().toISOString(),
                        ts(link.expiresAt),
                    );
            } catch (error) {
                throw new Error(
                    `Failed to store activity sync link: ${(error as Error).message}`,
                );
            }
        },

        async lookupActivityLink(
            token,
            now,
        ): Promise<HealthActivityLinkLookup> {
            const at = now ?? new Date();
            try {
                const row = getDb()
                    .query(
                        `SELECT ${ACTIVITY_LINK_COLUMNS} FROM health_activity_links
                         WHERE token_hash = ? AND expires_at > ? AND created_at > ?`,
                    )
                    .get(
                        hashSecret(token),
                        at.toISOString(),
                        liveSince(at),
                    ) as Row | null;
                if (!row) return { status: "invalid" };
                return {
                    status: "valid",
                    link: row as unknown as HealthActivityLinkRow,
                };
            } catch {
                return { status: "unavailable" };
            }
        },

        async touchActivityLink(userId, lastUsedAt, expiresAt) {
            getDb()
                .query(
                    "UPDATE health_activity_links SET last_used_at = ?, expires_at = ? WHERE user_id = ?",
                )
                .run(ts(lastUsedAt), ts(expiresAt), userId);
        },

        async setActivitySynced(userId, at, fallbackTz) {
            if (fallbackTz !== null) {
                getDb()
                    .query(
                        "UPDATE health_activity_links SET last_sync_at = ?, fallback_tz = ? WHERE user_id = ?",
                    )
                    .run(ts(at), fallbackTz, userId);
            } else {
                getDb()
                    .query(
                        "UPDATE health_activity_links SET last_sync_at = ? WHERE user_id = ?",
                    )
                    .run(ts(at), userId);
            }
        },

        async deleteActivityLink(userId) {
            getDb()
                .query("DELETE FROM health_activity_links WHERE user_id = ?")
                .run(userId);
        },

        async getActivityLinkStatus(
            userId,
            now,
        ): Promise<HealthActivityLinkStatus | null> {
            const at = now ?? new Date();
            const row = getDb()
                .query(
                    `SELECT fallback_tz, created_at, last_used_at, last_sync_at, expires_at
                     FROM health_activity_links WHERE user_id = ? AND expires_at > ? AND created_at > ?`,
                )
                .get(userId, at.toISOString(), liveSince(at));
            return (row as HealthActivityLinkStatus | null) ?? null;
        },
    };
}
