import { nanoid } from "nanoid";
import type { Kysely } from "kysely";
import type { Clock, IncomingMessageRecord, IncomingMessageRepository } from "@doit/application";
import type { NormalizedMessage } from "@doit/domain";
import type { Database, IncomingMessageTable } from "./schema.js";

function toRecord(row: IncomingMessageTable): IncomingMessageRecord {
  return {
    id: row.id, site: row.site, account: row.account_id,
    sourceThreadId: row.source_thread_id, sourceMessageId: row.source_message_id,
    sender: row.sender, receivedAt: row.received_at, text: row.text,
    firstSeenAt: row.first_seen_at, processingStatus: row.processing_status,
  };
}

export class SqliteIncomingMessageRepository implements IncomingMessageRepository {
  constructor(private readonly db: Kysely<Database>, private readonly clock: Clock) {}

  async upsert(site: string, account: string, msg: NormalizedMessage): Promise<{ inserted: boolean; id: string }> {
    const now = this.clock.nowIso();
    const id = `im_${nanoid()}`;
    try {
      await this.db.insertInto("incoming_message").values({
        id, site, account_id: account, source_thread_id: msg.sourceThreadId,
        source_message_id: msg.sourceMessageId, sender: msg.sender, received_at: msg.receivedAt,
        text: msg.text, first_seen_at: now, processing_status: "new",
      }).execute();
      return { inserted: true, id };
    } catch (err) {
      const existing = await this.db.selectFrom("incoming_message").select("id")
        .where("site", "=", site).where("account_id", "=", account)
        .where("source_message_id", "=", msg.sourceMessageId).executeTakeFirst();
      if (existing) return { inserted: false, id: existing.id };
      throw err;
    }
  }

  async listBySite(site: string, account: string): Promise<IncomingMessageRecord[]> {
    const rows = await this.db.selectFrom("incoming_message").selectAll()
      .where("site", "=", site).where("account_id", "=", account)
      .orderBy("received_at", "asc").execute();
    return rows.map(toRecord);
  }
}
