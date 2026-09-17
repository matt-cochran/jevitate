import type { CommandState, RiskClass, DomainEvent, DomainEventInput } from "@doit/domain";

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
