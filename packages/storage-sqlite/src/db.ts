import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database } from "./schema.js";

export function openDatabase(file: string): Kysely<Database> {
  const sqlite = new SQLite(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}
