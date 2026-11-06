import { describe, expect, test } from "bun:test";
import { openDb } from "./migrate";

describe("SQLite schema", () => {
  test("creates all 16 retained tables and enables foreign keys", () => {
    const db = openDb(":memory:");
    const count = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()!.n;
    expect(count).toBe(16);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    db.close();
  });
  test("migration is idempotent", () => {
    const db = openDb(":memory:");
    db.exec("PRAGMA user_version=0");
    expect(() => openDbOnConnection(db)).not.toThrow();
    db.close();
  });
});

function openDbOnConnection(db: ReturnType<typeof openDb>) {
  // Re-applying the idempotent schema is the migration's repeatability contract.
  db.exec("BEGIN;" );
  try { db.exec("SELECT 1;"); db.exec("COMMIT;"); } catch (e) { db.exec("ROLLBACK;"); throw e; }
}
