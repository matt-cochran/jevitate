import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import { up as initial } from "./migrations/2026-09-16-initial.js";

const MIGRATIONS = [initial];

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  for (const migrate of MIGRATIONS) {
    await migrate(db as unknown as Kysely<unknown>);
  }
}
