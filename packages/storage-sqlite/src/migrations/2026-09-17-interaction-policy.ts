import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS site_setting (
      site TEXT NOT NULL,
      account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (site, account_id, key)
    )`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS budget_counter (
      site TEXT NOT NULL,
      account_id TEXT NOT NULL,
      throttle_class TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_start TEXT NOT NULL,
      used INTEGER NOT NULL,
      UNIQUE (site, account_id, throttle_class, window_kind, window_start)
    )`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS action_activity (
      site TEXT NOT NULL,
      account_id TEXT NOT NULL,
      throttle_class TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (site, account_id, throttle_class)
    )`.execute(db);
}
