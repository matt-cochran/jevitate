import type { Kysely } from "kysely";
import type { Clock, CommandRepository, CommandRecord, NewCommand } from "@jevitate/application";
import type { CommandState } from "@jevitate/domain";
import { newCommandId, canTransition, IllegalTransitionError } from "@jevitate/domain";
import type { CommandTable, Database } from "./schema.js";

function toRecord(row: CommandTable): CommandRecord {
  return {
    id: row.id, site: row.site, account: row.account_id, actionId: row.action_id,
    actionVersion: row.action_version, payload: JSON.parse(row.payload),
    idempotencyKey: row.idempotency_key, risk: row.risk as CommandRecord["risk"],
    notBefore: row.not_before ?? undefined, state: row.state as CommandState,
    attempt: row.attempt, leaseExpiresAt: row.lease_expires_at,
  };
}

export class SqliteCommandRepository implements CommandRepository {
  constructor(private readonly db: Kysely<Database>, private readonly clock: Clock) {}

  async enqueue(cmd: NewCommand): Promise<CommandRecord> {
    const now = this.clock.nowIso();
    const id = newCommandId();
    try {
      await this.db.insertInto("command").values({
        id, site: cmd.site, account_id: cmd.account, action_id: cmd.actionId,
        action_version: cmd.actionVersion, payload: JSON.stringify(cmd.payload ?? {}),
        idempotency_key: cmd.idempotencyKey, risk: cmd.risk, not_before: cmd.notBefore ?? null,
        state: "queued", attempt: 0, lease_expires_at: null, created_at: now, updated_at: now,
      }).execute();
      return (await this.get(id))!;
    } catch (err) {
      const existing = await this.db.selectFrom("command").selectAll()
        .where("site", "=", cmd.site).where("account_id", "=", cmd.account)
        .where("idempotency_key", "=", cmd.idempotencyKey).executeTakeFirst();
      if (existing) return toRecord(existing);
      throw err;
    }
  }

  async get(id: string): Promise<CommandRecord | null> {
    const row = await this.db.selectFrom("command").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async leaseNextReady(leaseMs: number): Promise<CommandRecord | null> {
    // Controller ruling F3: lease_expires_at is compared against clock.nowIso()
    // (wall clock) in recoverExpiredLeases, so it MUST be derived from wall-clock
    // now rather than the process-relative monotonicMs() counter.
    const now = this.clock.nowIso();
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    return this.db.transaction().execute(async (tx) => {
      const candidate = await tx.selectFrom("command").selectAll()
        .where("state", "=", "ready")
        .where((eb) => eb.or([eb("not_before", "is", null), eb("not_before", "<=", now)]))
        .orderBy("created_at", "asc").limit(1).executeTakeFirst();
      if (!candidate) return null;
      const updated = await tx.updateTable("command")
        .set({ state: "leased", lease_expires_at: leaseUntil, updated_at: now })
        .where("id", "=", candidate.id).where("state", "=", "ready")
        .executeTakeFirst();
      if (!updated || updated.numUpdatedRows === 0n) return null;
      return toRecord({ ...candidate, state: "leased", lease_expires_at: leaseUntil });
    });
  }

  async setState(id: string, to: CommandState): Promise<void> {
    const current = await this.get(id);
    if (!current) throw new Error(`command not found: ${id}`);
    if (!canTransition(current.state, to)) throw new IllegalTransitionError(current.state, to);
    await this.db.updateTable("command").set({ state: to, updated_at: this.clock.nowIso() })
      .where("id", "=", id).execute();
  }

  async recoverExpiredLeases(): Promise<number> {
    const now = this.clock.nowIso();
    const result = await this.db.updateTable("command")
      .set({ state: "ready", lease_expires_at: null, updated_at: now })
      .where("state", "=", "leased").where("lease_expires_at", "<=", now).executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
