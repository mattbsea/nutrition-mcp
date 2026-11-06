import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA } from "./schema";

export function openDb(path = join(process.env.DATA_DIR || "./data", "nutrition.db")): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const version = Number(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
  if (version < 1) {
    db.exec("BEGIN IMMEDIATE;");
    try { db.exec(SCHEMA); db.exec("PRAGMA user_version = 1;"); db.exec("COMMIT;"); }
    catch (error) { db.exec("ROLLBACK;"); db.close(); throw error; }
  }
  return db;
}
