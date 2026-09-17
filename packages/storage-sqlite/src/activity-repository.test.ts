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
