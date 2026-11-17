import type { Kysely } from "kysely";
import type { ActivityRepository } from "@jevitate/application";
import type { Database } from "./schema.js";

export class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async lastAt(site: string, account: string, cls: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("action_activity")
      .select("last_at")
      .where("site", "=", site)
      .where("account_id", "=", account)
      .where("throttle_class", "=", cls)
      .executeTakeFirst();
    return row ? row.last_at : null;
  }

  async claim(site: string, account: string, cls: string, nowIso: string, notBeforeIso: string | null): Promise<boolean> {
    // One conditional upsert, so the read-compare-write is a single statement: concurrent claims
    // serialize in SQLite and only one can move `last_at` past the other's view.
    const result = await this.db
      .insertInto("action_activity")
      .values({ site, account_id: account, throttle_class: cls, last_at: nowIso })
      .onConflict((oc) => {
        const update = oc.columns(["site", "account_id", "throttle_class"]).doUpdateSet({ last_at: nowIso });
        return notBeforeIso === null ? update : update.where("action_activity.last_at", "<=", notBeforeIso);
      })
      .executeTakeFirst();
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async stamp(site: string, account: string, cls: string, nowIso: string): Promise<void> {
    await this.db
      .insertInto("action_activity")
      .values({ site, account_id: account, throttle_class: cls, last_at: nowIso })
      .onConflict((oc) => oc.columns(["site", "account_id", "throttle_class"]).doUpdateSet({ last_at: nowIso }))
      .execute();
  }
}
