import { expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteEventLog } from "./event-log.js";

test("append assigns increasing sequences and since() filters", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const log = new SqliteEventLog(db);
  const s1 = await log.append({ aggregate: "cmd_1", type: "created", payload: {}, occurredAt: "t1", correlationId: "c" });
  const s2 = await log.append({ aggregate: "cmd_1", type: "state.changed", payload: { to: "ready" }, occurredAt: "t2", correlationId: "c" });
  expect(s2).toBeGreaterThan(s1);
  const rest = await log.since(s1);
  expect(rest.map((e) => e.type)).toEqual(["state.changed"]);
});
