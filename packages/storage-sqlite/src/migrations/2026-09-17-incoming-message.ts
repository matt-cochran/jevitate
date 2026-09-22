import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS incoming_message (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      received_at TEXT NOT NULL,
      text TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      processing_status TEXT NOT NULL,
      UNIQUE (site, account_id, source_message_id)
    )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_incoming_thread
    ON incoming_message (site, account_id, source_thread_id)`.execute(db);
}
