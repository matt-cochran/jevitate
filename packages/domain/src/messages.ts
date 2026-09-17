import { z } from "zod";
import type { IsoTimestamp } from "./primitives.js";

export interface NormalizedMessage {
  sourceMessageId: string;
  sourceThreadId: string;
  sender: string;
  receivedAt: IsoTimestamp;
  text: string;
}

export interface NormalizedThread {
  sourceThreadId: string;
  subject: string;
  messages: NormalizedMessage[];
}

export const NormalizedMessageSchema = z.object({
  sourceMessageId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  sender: z.string().min(1),
  receivedAt: z.string().min(1),
  text: z.string(),
});

export const NormalizedThreadSchema = z.object({
  sourceThreadId: z.string().min(1),
  subject: z.string(),
  messages: z.array(NormalizedMessageSchema),
});
