import { expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteIncomingMessageRepository } from "./incoming-message-repository.js";

const clock = { nowIso: () => "2026-09-17T12:00:00.000Z", monotonicMs: () => 0 };
const msg = { sourceMessageId: "m1", sourceThreadId: "t1", sender: "jane", receivedAt: "2026-09-17T09:00:00.000Z", text: "hi" };

test("upsert inserts once, dedups on repeat, preserves first_seen", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteIncomingMessageRepository(db, clock);
  const first = await repo.upsert("example-network", "primary", msg);
  const second = await repo.upsert("example-network", "primary", msg);
  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(false);
  expect(second.id).toBe(first.id);
  const all = await repo.listBySite("example-network", "primary");
  expect(all).toHaveLength(1);
  expect(all[0].firstSeenAt).toBe("2026-09-17T12:00:00.000Z");
});
