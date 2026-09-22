import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS command (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      account_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      action_version TEXT NOT NULL,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      risk TEXT NOT NULL,
      not_before TEXT,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (site, account_id, idempotency_key)
    )`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS event (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      correlation_id TEXT NOT NULL
    )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_command_state ON command (state, not_before)`.execute(db);
}
