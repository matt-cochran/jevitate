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
  sequence: number;         // autoincrement
  aggregate: string;
  type: string;
  payload: string;          // JSON
  occurred_at: string;
  correlation_id: string;
}

export interface Database {
  command: CommandTable;
  event: EventTable;
}
