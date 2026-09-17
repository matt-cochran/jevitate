import type { Generated } from "kysely";

export interface CommandTable {
  id: string;
  site: string;
  account_id: string;
  action_id: string;
  action_version: string;
  payload: string;          // JSON
  idempotency_key: string;
  risk: string;
  not_before: string | null;
  state: string;
  attempt: number;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventTable {
  sequence: Generated<number>; // autoincrement
  aggregate: string;
  type: string;
  payload: string;          // JSON
  occurred_at: string;
  correlation_id: string;
}

export interface IncomingMessageTable {
  id: string;
  site: string;
  account_id: string;
  source_thread_id: string;
  source_message_id: string;
  sender: string;
  received_at: string;
  text: string;
  first_seen_at: string;
  processing_status: string;
}

export interface Database {
  command: CommandTable;
  event: EventTable;
  incoming_message: IncomingMessageTable;
}
