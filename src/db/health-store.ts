/**
 * Persistence for Apple Health sync on SQLite: the sync lease and clocks
 * (health_sync_state) and the "sent so far" ledger (health_sync_days +
 * health_sync_sent). Nothing here is a secret: the shortcut authenticates with
 * one static key checked in the HTTP layer.
 */
import { getDb } from "./conn.js";
import { ts, tx, type Row } from "./util.js";
import type { HealthSyncField } from "../health-sync.js";
import type {
    HealthSyncDayRow,
    HealthSyncStateRow,
    HealthSyncStore,
} from "./types.js";

const nowIso = (now?: Date) => (now ?? new Date()).toISOString();

const STATE_EMPTY: HealthSyncStateRow = {
    lease_until: null,
    last_sync_at: null,
    last_ack_at: null,
    last_activity_at: null,
};

/** Ensures the owner's state row exists. */
function ensureState(userId: string): void {
    getDb()
        .query(
            "INSERT INTO health_sync_state (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING",
        )
        .run(userId);
}

export function createSqliteHealthSyncStore(): HealthSyncStore {
    return {
        async acquireLease(userId, until, now) {
            ensureState(userId);
            // Free or lapsed, in one conditional UPDATE, so two concurrent
            // syncs cannot both win.
            const res = getDb()
                .query(
                    `UPDATE health_sync_state SET lease_until = ?
                     WHERE user_id = ? AND (lease_until IS NULL OR lease_until < ?)`,
                )
                .run(ts(until), userId, nowIso(now));
            return res.changes > 0;
        },

        async releaseLease(userId, heldUntil) {
            if (heldUntil === undefined) {
                getDb()
                    .query(
                        "UPDATE health_sync_state SET lease_until = NULL WHERE user_id = ?",
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
                    "UPDATE health_sync_state SET lease_until = NULL WHERE user_id = ? AND lease_until = ?",
                )
                .run(userId, held);
        },

        async touchSync(userId, at) {
            ensureState(userId);
            getDb()
                .query(
                    "UPDATE health_sync_state SET last_sync_at = ? WHERE user_id = ?",
                )
                .run(ts(at), userId);
        },

        async getDays(userId, from, to) {
            const db = getDb();
            const days = db
                .query(
                    `SELECT date, timezone, rounds, first_sent_at, last_sent_at
                     FROM health_sync_days WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
                )
                .all(userId, from, to) as Row[];
            if (days.length === 0) return [];
            const sent = db
                .query(
                    `SELECT date, field, sent FROM health_sync_sent
                     WHERE user_id = ? AND date >= ? AND date <= ?`,
                )
                .all(userId, from, to) as {
                date: string;
                field: HealthSyncField;
                sent: number;
            }[];
            const byDate = new Map<
                string,
                Partial<Record<HealthSyncField, number>>
            >();
            for (const s of sent) {
                const m = byDate.get(s.date) ?? {};
                m[s.field] = s.sent;
                byDate.set(s.date, m);
            }
            return days.map((d) => ({
                ...(d as unknown as Omit<HealthSyncDayRow, "sent">),
                sent: byDate.get(String(d.date)) ?? {},
            }));
        },

        async commitDay(userId, expectedRounds, row, at) {
            return tx((db) => {
                const cur = db
                    .query<{ rounds: number }, [string, string]>(
                        "SELECT rounds FROM health_sync_days WHERE user_id = ? AND date = ?",
                    )
                    .get(userId, row.date);
                if ((cur?.rounds ?? 0) !== expectedRounds) return false;
                db.query(
                    `INSERT INTO health_sync_days (user_id, date, timezone, rounds, first_sent_at, last_sent_at)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT (user_id, date) DO UPDATE SET
                       timezone = excluded.timezone, rounds = excluded.rounds,
                       first_sent_at = excluded.first_sent_at, last_sent_at = excluded.last_sent_at`,
                ).run(
                    userId,
                    row.date,
                    row.timezone,
                    row.rounds,
                    row.first_sent_at ? ts(row.first_sent_at) : null,
                    row.last_sent_at ? ts(row.last_sent_at) : null,
                );
                const put = db.query(
                    `INSERT INTO health_sync_sent (user_id, date, field, sent) VALUES (?, ?, ?, ?)
                     ON CONFLICT (user_id, date, field) DO UPDATE SET sent = excluded.sent`,
                );
                for (const [field, sent] of Object.entries(row.sent)) {
                    put.run(userId, row.date, field, sent as number);
                }
                db.query(
                    `INSERT INTO health_sync_state (user_id, last_ack_at) VALUES (?, ?)
                     ON CONFLICT (user_id) DO UPDATE SET last_ack_at = excluded.last_ack_at`,
                ).run(userId, ts(at));
                return true;
            });
        },

        async getState(userId) {
            const row = getDb()
                .query(
                    "SELECT lease_until, last_sync_at, last_ack_at, last_activity_at FROM health_sync_state WHERE user_id = ?",
                )
                .get(userId) as HealthSyncStateRow | null;
            return row ?? { ...STATE_EMPTY };
        },

        async setActivitySynced(userId, at) {
            ensureState(userId);
            getDb()
                .query(
                    "UPDATE health_sync_state SET last_activity_at = ? WHERE user_id = ?",
                )
                .run(ts(at), userId);
        },

        async deleteDaysBefore(userId, beforeDate) {
            return getDb()
                .query(
                    "DELETE FROM health_sync_days WHERE user_id = ? AND date < ?",
                )
                .run(userId, beforeDate).changes;
        },

        async reset(userId) {
            tx((db) => {
                db.query("DELETE FROM health_sync_days WHERE user_id = ?").run(
                    userId,
                ); // health_sync_sent cascades
                db.query("DELETE FROM health_sync_state WHERE user_id = ?").run(
                    userId,
                );
            });
        },
    };
}
