import type { Kysely } from "kysely";
import type { EventLog } from "@doit/application";
import type { DomainEvent, DomainEventInput } from "@doit/domain";
import type { Database } from "./schema.js";

export class SqliteEventLog implements EventLog {
  constructor(private readonly db: Kysely<Database>) {}

  async append(e: DomainEventInput): Promise<number> {
    const result = await this.db.insertInto("event").values({
      aggregate: e.aggregate, type: e.type, payload: JSON.stringify(e.payload ?? null),
      occurred_at: e.occurredAt, correlation_id: e.correlationId,
    }).returning("sequence").executeTakeFirstOrThrow();
    return Number(result.sequence);
  }

  async since(seq: number): Promise<DomainEvent[]> {
    const rows = await this.db.selectFrom("event").selectAll()
      .where("sequence", ">", seq).orderBy("sequence", "asc").execute();
    return rows.map((r) => ({
      sequence: Number(r.sequence), aggregate: r.aggregate, type: r.type,
      payload: JSON.parse(r.payload), occurredAt: r.occurred_at, correlationId: r.correlation_id,
    }));
  }
}
