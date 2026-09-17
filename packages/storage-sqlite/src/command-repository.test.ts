import { beforeEach, expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteCommandRepository } from "./command-repository.js";
import type { NewCommand } from "@doit/application";

const clock = { nowIso: () => new Date().toISOString(), monotonicMs: () => Date.now() };
const cmd: NewCommand = { site: "s", account: "a", actionId: "inbox.list", actionVersion: "1.0.0",
  payload: {}, idempotencyKey: "k1", risk: "read" };

async function repo() {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  return new SqliteCommandRepository(db, clock);
}

test("enqueue is idempotent by (site, account, idempotency key)", async () => {
  const r = await repo();
  const a = await r.enqueue(cmd);
  const b = await r.enqueue(cmd);
  expect(b.id).toBe(a.id);
});

test("leaseNextReady moves a ready command to leased exactly once", async () => {
  const r = await repo();
  const c = await r.enqueue(cmd);
  await r.setState(c.id, "validating");
  await r.setState(c.id, "ready");
  const leased = await r.leaseNextReady(1000);
  expect(leased?.id).toBe(c.id);
  expect(leased?.state).toBe("leased");
  expect(await r.leaseNextReady(1000)).toBeNull();
});

test("setState rejects an illegal transition", async () => {
  const r = await repo();
  const c = await r.enqueue(cmd);
  await expect(r.setState(c.id, "succeeded")).rejects.toThrow();
});
