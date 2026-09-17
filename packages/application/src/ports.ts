import type { CommandState, RiskClass, DomainEvent, DomainEventInput, NormalizedMessage, SitePolicy } from "@doit/domain";

export interface Clock {
  nowIso(): string;
  monotonicMs(): number;
}

export interface NewCommand {
  site: string;
  account: string;
  actionId: string;
  actionVersion: string;
  payload: unknown;
  idempotencyKey: string;
  risk: RiskClass;
  notBefore?: string;
}

export interface CommandRecord extends NewCommand {
  id: string;
  state: CommandState;
  attempt: number;
  leaseExpiresAt: string | null;
}

export interface CommandRepository {
  enqueue(cmd: NewCommand): Promise<CommandRecord>;
  get(id: string): Promise<CommandRecord | null>;
  leaseNextReady(leaseMs: number): Promise<CommandRecord | null>;
  setState(id: string, to: CommandState): Promise<void>;
  recoverExpiredLeases(): Promise<number>;
}

export interface EventLog {
  append(e: DomainEventInput): Promise<number>;
  since(seq: number): Promise<DomainEvent[]>;
}

export interface IncomingMessageRecord extends NormalizedMessage {
  id: string;
  site: string;
  account: string;
  firstSeenAt: string;
  processingStatus: string;
}

export interface IncomingMessageRepository {
  upsert(site: string, account: string, msg: NormalizedMessage): Promise<{ inserted: boolean; id: string }>;
  listBySite(site: string, account: string): Promise<IncomingMessageRecord[]>;
}

export interface SitePolicyRepository {
  get(site: string, account: string): Promise<SitePolicy | null>;
  set(site: string, account: string, policy: SitePolicy): Promise<void>;
}
