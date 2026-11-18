import { expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteActivityRepository } from "./activity-repository.js";

test("lastAt on unstamped site/account/class returns null", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteActivityRepository(db);

  const result = await repo.lastAt("example-network", "primary", "default");

  expect(result).toBeNull();
});

test("stamp then lastAt returns the stamped timestamp", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteActivityRepository(db);

  await repo.stamp("example-network", "primary", "default", "2026-09-17T12:00:00.000Z");
  const result = await repo.lastAt("example-network", "primary", "default");

  expect(result).toBe("2026-09-17T12:00:00.000Z");
});

test("stamp upserts (second stamp overwrites first)", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteActivityRepository(db);

  await repo.stamp("example-network", "primary", "default", "2026-09-17T12:00:00.000Z");
  await repo.stamp("example-network", "primary", "default", "2026-09-17T13:30:00.000Z");
  const result = await repo.lastAt("example-network", "primary", "default");

  expect(result).toBe("2026-09-17T13:30:00.000Z");
});

test("#854: claim records the first activity, and refuses while the last one is newer than notBefore", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteActivityRepository(db);
  expect(await repo.claim("s", "a", "write", "2026-09-17T12:00:00.000Z", "2026-09-17T11:59:00.000Z")).toBe(true);
  // 30 s later with a 60 s interval: the last activity (12:00:00) is after notBefore (11:59:30).
  expect(await repo.claim("s", "a", "write", "2026-09-17T12:00:30.000Z", "2026-09-17T11:59:30.000Z")).toBe(false);
  expect(await repo.lastAt("s", "a", "write")).toBe("2026-09-17T12:00:00.000Z");
  // 60 s later: claimed, and the activity moves.
  expect(await repo.claim("s", "a", "write", "2026-09-17T12:01:00.000Z", "2026-09-17T12:00:00.000Z")).toBe(true);
  expect(await repo.lastAt("s", "a", "write")).toBe("2026-09-17T12:01:00.000Z");
  // notBefore null always claims.
  expect(await repo.claim("s", "a", "write", "2026-09-17T12:01:01.000Z", null)).toBe(true);
});

test("#854: concurrent claims on one scope: exactly one wins", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteActivityRepository(db);
  await repo.stamp("s", "a", "write", "2026-09-17T11:00:00.000Z");
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => repo.claim("s", "a", "write", `2026-09-17T12:00:0${i}.000Z`, "2026-09-17T11:59:00.000Z")),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});
