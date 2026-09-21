import { expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteSitePolicyRepository } from "./site-policy-repository.js";
import type { SitePolicy } from "@jevitate/domain";

const clock = { nowIso: () => "2026-09-17T12:00:00.000Z", monotonicMs: () => 0 };

const policy: SitePolicy = {
  version: "1",
  interaction: {
    typing: { charsPerSecond: 5, perKeyJitter: 0.2 },
  },
  throttles: {
    default: { minIntervalSeconds: 30, hourlyLimit: 10, dailyLimit: 100 },
  },
};

test("set then get round-trips a policy", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteSitePolicyRepository(db, clock);

  await repo.set("example-network", "primary", policy);
  const result = await repo.get("example-network", "primary");

  expect(result).toEqual(policy);
});

test("get on unset site+account returns null", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteSitePolicyRepository(db, clock);

  const result = await repo.get("example-network", "primary");

  expect(result).toBeNull();
});

test("set upserts (second set overwrites first)", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteSitePolicyRepository(db, clock);

  await repo.set("example-network", "primary", policy);
  const updated: SitePolicy = { ...policy, version: "2" };
  await repo.set("example-network", "primary", updated);

  const result = await repo.get("example-network", "primary");
  expect(result).toEqual(updated);
});
