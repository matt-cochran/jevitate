import { expect, test } from "vitest";
import { openDatabase, migrateToLatest, SqliteCommandRepository, SqliteEventLog } from "@jevitate/storage-sqlite";
import { recoverOnStartup } from "./recovery.js";

const past = { nowIso: () => "2000-01-01T00:00:00Z", monotonicMs: () => 0 };

test("a lease expired before restart is returned to ready and logged", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteCommandRepository(db, { nowIso: () => new Date().toISOString(), monotonicMs: () => Date.now() });
  const log = new SqliteEventLog(db);

  const c = await repo.enqueue({ site: "s", account: "a", actionId: "inbox.list", actionVersion: "1.0.0", payload: {}, idempotencyKey: "k", risk: "read" });
  await repo.setState(c.id, "validating");
  await repo.setState(c.id, "ready");
  // Lease it into the past so the lease is already expired.
  const expiredRepo = new SqliteCommandRepository(db, past);
  await expiredRepo.leaseNextReady(1000);

  const recovered = await recoverOnStartup(repo, log, "corr_boot");
  expect(recovered).toBe(1);
  expect((await repo.get(c.id))?.state).toBe("ready");
  expect((await log.since(0)).some((e) => e.type === "lease.recovered")).toBe(true);
});
