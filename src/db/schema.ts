/** SQLite database shape for the local, single-owner nutrition service. */
export const OWNER_ID = "local-owner";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meals (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, logged_at TEXT NOT NULL, description TEXT NOT NULL,
 calories REAL, protein REAL, carbohydrates REAL, fat REAL, fiber REAL, sugar REAL, added_sugar REAL,
 sodium REAL, saturated_fat REAL, trans_fat REAL, caffeine REAL, alcohol_grams REAL, drink_count REAL,
 source TEXT, notes TEXT, idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS meals_user_idempotency_idx ON meals(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS meals_user_logged_at_idx ON meals(user_id,logged_at);
CREATE TABLE IF NOT EXISTS meal_items (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
 description TEXT NOT NULL, quantity REAL, unit TEXT, calories REAL, protein REAL, carbohydrates REAL, fat REAL,
 fiber REAL, sugar REAL, added_sugar REAL, sodium REAL, saturated_fat REAL, trans_fat REAL, caffeine REAL,
 source TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS saved_meals (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT,calories REAL,protein REAL,carbohydrates REAL,
 fat REAL,fiber REAL,sugar REAL,added_sugar REAL,sodium REAL,saturated_fat REAL,trans_fat REAL,caffeine REAL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS saved_meal_items (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,saved_meal_id TEXT NOT NULL REFERENCES saved_meals(id) ON DELETE CASCADE,
 description TEXT NOT NULL,quantity REAL,unit TEXT,calories REAL,protein REAL,carbohydrates REAL,fat REAL,
 fiber REAL,sugar REAL,added_sugar REAL,sodium REAL,saturated_fat REAL,trans_fat REAL,caffeine REAL,source TEXT
);
CREATE TABLE IF NOT EXISTS nutrition_goals (user_id TEXT PRIMARY KEY, goals TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS nutrition_goals_history (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,effective_at TEXT NOT NULL,goals TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS water_log (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,logged_at TEXT NOT NULL,amount_ml REAL NOT NULL,notes TEXT,idempotency_key TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS water_user_idempotency_idx ON water_log(user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS active_calories_log (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,date TEXT NOT NULL,calories REAL NOT NULL,source TEXT NOT NULL DEFAULT 'manual',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS weight_log (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,logged_at TEXT NOT NULL,weight REAL NOT NULL,unit TEXT NOT NULL,notes TEXT);
CREATE TABLE IF NOT EXISTS body_measurement_log (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,logged_at TEXT NOT NULL,measurement_type TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL,notes TEXT,idempotency_key TEXT);
CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY,timezone TEXT,locale TEXT,weight_unit TEXT,length_unit TEXT,drink_unit TEXT,widgets_enabled INTEGER NOT NULL DEFAULT 1,alcohol_tracking_enabled INTEGER NOT NULL DEFAULT 0,activity_credit_pct REAL NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS food_cache (id TEXT PRIMARY KEY,provider TEXT NOT NULL,food_id TEXT NOT NULL,data TEXT NOT NULL,expires_at TEXT NOT NULL,UNIQUE(provider,food_id));
CREATE TABLE IF NOT EXISTS health_sync_pending (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,secret_hash TEXT NOT NULL,expires_at TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS health_sync_links (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,token_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS health_sync_days (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,date TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS health_activity_links (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,token_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}');
`;
