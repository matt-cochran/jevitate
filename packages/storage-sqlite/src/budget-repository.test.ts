import { expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteBudgetRepository } from "./budget-repository.js";

const T1 = "2026-09-17T12:00:00.000Z"; // hour 12, day 17
const T1_LATER_SAME_HOUR = "2026-09-17T12:45:00.000Z";

test("dailyLimit:2 allows two reserves, denies the third", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteBudgetRepository(db);

  const r1 = await repo.reserve("example-network", "primary", "default", { dailyLimit: 2 }, T1);
  const r2 = await repo.reserve("example-network", "primary", "default", { dailyLimit: 2 }, T1);
  const r3 = await repo.reserve("example-network", "primary", "default", { dailyLimit: 2 }, T1);

  expect(r1).toEqual({ allowed: true });
  expect(r2).toEqual({ allowed: true });
  expect(r3).toEqual({ allowed: false });
});

test("only dailyLimit set does not touch the hour bucket", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteBudgetRepository(db);

  await repo.reserve("example-network", "primary", "default", { dailyLimit: 2 }, T1);

  const hourRow = await db.selectFrom("budget_counter").selectAll()
    .where("window_kind", "=", "hour").executeTakeFirst();
  const dayRow = await db.selectFrom("budget_counter").selectAll()
    .where("window_kind", "=", "day").executeTakeFirst();

  expect(hourRow).toBeUndefined();
  expect(dayRow?.used).toBe(1);
});

test("only hourlyLimit set does not touch the day bucket", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteBudgetRepository(db);

  await repo.reserve("example-network", "primary", "default", { hourlyLimit: 2 }, T1);

  const hourRow = await db.selectFrom("budget_counter").selectAll()
    .where("window_kind", "=", "hour").executeTakeFirst();
  const dayRow = await db.selectFrom("budget_counter").selectAll()
    .where("window_kind", "=", "day").executeTakeFirst();

  expect(hourRow?.used).toBe(1);
  expect(dayRow).toBeUndefined();
});

test("hour limit exhausted denies even though day limit still has room", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteBudgetRepository(db);
  const limits = { hourlyLimit: 1, dailyLimit: 100 };

  const r1 = await repo.reserve("example-network", "primary", "default", limits, T1);
  const r2 = await repo.reserve("example-network", "primary", "default", limits, T1_LATER_SAME_HOUR);

  expect(r1).toEqual({ allowed: true });
  expect(r2).toEqual({ allowed: false }); // hour bucket exhausted, despite day having plenty of room
});

test("denied reserve rolls back the WHOLE transaction: an already-incremented window is undone", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteBudgetRepository(db);
  // hourlyLimit is generous (won't block); dailyLimit is exhausted after 2 reserves.
  const limits = { hourlyLimit: 10, dailyLimit: 2 };

  const r1 = await repo.reserve("example-network", "primary", "default", limits, T1);
  const r2 = await repo.reserve("example-network", "primary", "default", limits, T1);
  // At this point: hour used=2, day used=2 (day at its limit).

  const hourBefore = await db.selectFrom("budget_counter").selectAll()
    .where("window_kind", "=", "hour").executeTakeFirstOrThrow();
  expect(hourBefore.used).toBe(2);

  // This third reserve: the hour window is NOT at its limit (2 < 10) so its increment
  // would apply-and-succeed on its own; but the day window IS at its limit, so the whole
  // transaction must roll back, undoing the hour window's increment too.
  const r3 = await repo.reserve("example-network", "primary", "default", limits, T1);

  expect(r3).toEqual({ allowed: false });

  const hourAfter = await db.selectFrom("budget_counter").selectAll()
    .where("window_kind", "=", "hour").executeTakeFirstOrThrow();
  const dayAfter = await db.selectFrom("budget_counter").selectAll()
    .where("window_kind", "=", "day").executeTakeFirstOrThrow();

  expect(hourAfter.used).toBe(2); // NOT 3 — proves the hour increment was rolled back
  expect(dayAfter.used).toBe(2); // unchanged by the denied attempt
  expect(r1).toEqual({ allowed: true });
  expect(r2).toEqual({ allowed: true });
});
