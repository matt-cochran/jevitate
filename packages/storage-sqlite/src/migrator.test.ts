import { expect, test } from "vitest";
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

test("incoming_message dedups on (site, account_id, source_message_id)", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const now = new Date().toISOString();
  const row = { id: "im_1", site: "s", account_id: "a", source_thread_id: "t1", source_message_id: "m1",
    sender: "jane", received_at: now, text: "hi", first_seen_at: now, processing_status: "new" };
  await db.insertInto("incoming_message").values(row).execute();
  await expect(
    db.insertInto("incoming_message").values({ ...row, id: "im_2" }).execute(),
  ).rejects.toThrow();
  await db.destroy();
});

test("budget_counter dedups on (site, account_id, throttle_class, window_kind, window_start)", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const row = { site: "s", account_id: "a", throttle_class: "default", window_kind: "day",
    window_start: "2026-09-17", used: 1 };
  await db.insertInto("budget_counter").values(row).execute();
  await expect(
    db.insertInto("budget_counter").values({ ...row, used: 2 }).execute(),
  ).rejects.toThrow();
  await db.destroy();
});
