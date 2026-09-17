import type { Kysely } from "kysely";
import type { Clock, SitePolicyRepository } from "@doit/application";
import { SitePolicySchema, type SitePolicy } from "@doit/domain";
import type { Database } from "./schema.js";

const POLICY_KEY = "policy";

export class SqliteSitePolicyRepository implements SitePolicyRepository {
  constructor(private readonly db: Kysely<Database>, private readonly clock: Clock) {}

  async get(site: string, account: string): Promise<SitePolicy | null> {
    const row = await this.db.selectFrom("site_setting").select("value_json")
      .where("site", "=", site).where("account_id", "=", account)
      .where("key", "=", POLICY_KEY).executeTakeFirst();
    if (!row) return null;
    return SitePolicySchema.parse(JSON.parse(row.value_json));
  }

  async set(site: string, account: string, policy: SitePolicy): Promise<void> {
    const now = this.clock.nowIso();
    const valueJson = JSON.stringify(policy);
    await this.db.insertInto("site_setting")
      .values({ site, account_id: account, key: POLICY_KEY, value_json: valueJson, updated_at: now })
      .onConflict((oc) => oc.columns(["site", "account_id", "key"]).doUpdateSet({ value_json: valueJson, updated_at: now }))
      .execute();
  }
}
