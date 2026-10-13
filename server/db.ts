import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  failed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_key ON login_attempts (key, failed_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Columns added to tables that older databases already have. Each is added once, with a default. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["push_subscriptions", "session_hash", "TEXT"],
  ["push_subscriptions", "muted", "INTEGER NOT NULL DEFAULT 0"],
  ["push_subscriptions", "on_agent_waiting", "INTEGER NOT NULL DEFAULT 1"],
  ["push_subscriptions", "on_agent_done", "INTEGER NOT NULL DEFAULT 1"],
  ["push_subscriptions", "on_command_done", "INTEGER NOT NULL DEFAULT 1"],
];

function migrate(db: DatabaseSync): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => row.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS push_subscriptions_session ON push_subscriptions (session_hash)",
  );
}

/** Opens the database at `file`, or an in-memory one when `file` is ":memory:". */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
