import { sql, type Kysely, type Transaction } from "kysely";
import type { BudgetLimits, BudgetRepository } from "@jevitate/application";
import type { Database } from "./schema.js";

/** Sentinel error thrown inside the reserve transaction to trigger a full rollback
 * when any applicable window (hour/day) is already at its limit. Caught outside
 * the transaction and translated into `{ allowed: false }`. Never leaks out. */
class AtLimitError extends Error {}

function hourBucket(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).toISOString();
}

function dayBucket(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

async function reserveWindow(
  tx: Transaction<Database>,
  site: string,
  account: string,
  cls: string,
  windowKind: string,
  windowStart: string,
  limit: number
): Promise<void> {
  // A limit of 0 (or negative) means "block entirely." The ON CONFLICT ... WHERE
  // guard below only protects the update path for an existing row; the initial
  // INSERT of a brand-new row/window is otherwise unconditional and would let
  // exactly one action through per fresh window. Guard explicitly, up front.
  if (limit <= 0) {
    throw new AtLimitError();
  }
  const result = await tx
    .insertInto("budget_counter")
    .values({ site, account_id: account, throttle_class: cls, window_kind: windowKind, window_start: windowStart, used: 1 })
    .onConflict((oc) =>
      oc
        .columns(["site", "account_id", "throttle_class", "window_kind", "window_start"])
        .doUpdateSet({ used: sql`used + 1` })
        .where("used", "<", limit)
    )
    .executeTakeFirst();
  if (!result.numInsertedOrUpdatedRows || result.numInsertedOrUpdatedRows === 0n) {
    throw new AtLimitError();
  }
}

export class SqliteBudgetRepository implements BudgetRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async reserve(site: string, account: string, cls: string, limits: BudgetLimits, nowIso: string): Promise<{ allowed: boolean }> {
    try {
      await this.db.transaction().execute(async (tx) => {
        if (limits.hourlyLimit !== undefined) {
          await reserveWindow(tx, site, account, cls, "hour", hourBucket(nowIso), limits.hourlyLimit);
        }
        if (limits.dailyLimit !== undefined) {
          await reserveWindow(tx, site, account, cls, "day", dayBucket(nowIso), limits.dailyLimit);
        }
      });
      return { allowed: true };
    } catch (err) {
      if (err instanceof AtLimitError) return { allowed: false };
      throw err;
    }
  }
}
