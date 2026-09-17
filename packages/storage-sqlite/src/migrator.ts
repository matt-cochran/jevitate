import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import { up as initial } from "./migrations/2026-09-16-initial.js";
import { up as incomingMessage } from "./migrations/2026-09-17-incoming-message.js";
import { up as interactionPolicy } from "./migrations/2026-09-17-interaction-policy.js";

const MIGRATIONS = [initial, incomingMessage, interactionPolicy];

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  for (const migrate of MIGRATIONS) {
    await migrate(db as unknown as Kysely<unknown>);
  }
}
