import { z } from "zod";
import type { IsoTimestamp } from "./primitives.js";

export interface DomainEvent {
  sequence: number;
  aggregate: string;
  type: string;
  payload: unknown;
  occurredAt: IsoTimestamp;
  correlationId: string;
}

export type DomainEventInput = Omit<DomainEvent, "sequence">;

export const DomainEventInputSchema = z.object({
  aggregate: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string().min(1),
  correlationId: z.string().min(1),
});
