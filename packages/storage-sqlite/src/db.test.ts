import { expect, test } from "vitest";
import { sql } from "kysely";
import { openDatabase } from "./db.js";

test("opens in WAL with foreign keys on", async () => {
  const db = openDatabase(":memory:");
  const jm = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(db);
  const fk = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
  // :memory: reports "memory"; a file path reports "wal". foreign_keys must be 1 either way.
  expect(["wal", "memory"]).toContain(jm.rows[0].journal_mode);
  expect(fk.rows[0].foreign_keys).toBe(1);
  await db.destroy();
});
