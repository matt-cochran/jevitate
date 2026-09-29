import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database } from "./schema.js";

export function openDatabase(file: string): Kysely<Database> {
  const sqlite = new SQLite(file);
  sqlite.pragma("journal_mode = WAL");
  // Durable by default (FULL: every commit is flushed). `JEVITATE_DURABLE_WRITES=off` is for the test
  // suite only (vitest.config.ts): the tests check schema and queries, not the flush, and the flush
  // makes their duration depend on the host's disk writeback (seconds under memory pressure).
  sqlite.pragma(process.env.JEVITATE_DURABLE_WRITES === "off" ? "synchronous = OFF" : "synchronous = FULL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}
