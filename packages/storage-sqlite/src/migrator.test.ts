import { expect, test } from "vitest";
import { sql } from "kysely";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";

test("migration creates command table with idempotency uniqueness", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const now = new Date().toISOString();
  const row = { site: "s", account_id: "a", action_id: "inbox.list", action_version: "1.0.0",
    payload: "{}", idempotency_key: "k", risk: "read", not_before: null, state: "queued",
    attempt: 0, lease_expires_at: null, created_at: now, updated_at: now };
  await db.insertInto("command").values({ id: "cmd_1", ...row }).execute();
  await expect(
    db.insertInto("command").values({ id: "cmd_2", ...row }).execute(),
  ).rejects.toThrow(); // UNIQUE(site, account_id, idempotency_key)
  await db.destroy();
});
