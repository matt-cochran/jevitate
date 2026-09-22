import { z } from "zod";

export const SAFE_INBOX_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function assertSafeInboxId(id: string): void {
  if (!SAFE_INBOX_ID_RE.test(id)) throw new Error(`Invalid inbox id: ${JSON.stringify(id)}`);
}

// S-A: brand at the SCHEMA so the inferred type carries it — z.infer of a
// plain z.string() gives `string` and loses the compile-time leak guard.
export const SecretSchema = z.string().brand<"Secret">();
export type Secret = z.infer<typeof SecretSchema>;
export const asSecret = (s: string): Secret => SecretSchema.parse(s);
export const revealSecret = (s: Secret): string => s as unknown as string;

export const InboxItemKindSchema = z.enum(["handback", "approval", "review"]);
export type InboxItemKind = z.infer<typeof InboxItemKindSchema>;
export const InboxItemStatusSchema = z.enum(["pending", "approved", "rejected", "resolved", "expired"]);
export type InboxItemStatus = z.infer<typeof InboxItemStatusSchema>;

export const ThreadEntrySchema = z.object({
  author: z.enum(["agent", "human"]), text: z.string(), at: z.string(),
}).strict();
export type ThreadEntry = z.infer<typeof ThreadEntrySchema>;

export const FindingSchema = z.object({
  id: z.string(), title: z.string(), severity: z.enum(["low", "med", "high"]), evidence: z.string().optional(),
}).strict();
export type Finding = z.infer<typeof FindingSchema>;

export const InboxItemSchema = z.object({
  id: z.string().regex(SAFE_INBOX_ID_RE, "invalid id"),
  kind: InboxItemKindSchema,
  status: InboxItemStatusSchema,
  run: z.string(), journey: z.string(), step: z.string(),
  reason: z.string(), agent: z.string(),
  targetUrl: z.string().optional(),
  hasScreenshot: z.boolean(),
  findings: z.array(FindingSchema).optional(),
  thread: z.array(ThreadEntrySchema),
  humanInput: SecretSchema.optional(),     // branded Secret (compile-time leak guard); plain string on disk, brand parses fine
  secretConsumedAt: z.string().optional(),
  createdAt: z.string(), ttlSec: z.number().int().positive(),
  resolvedAt: z.string().optional(),
  resolution: z.object({
    by: z.literal("human"), decision: z.enum(["approved", "rejected", "resolved"]), at: z.string(),
  }).strict().optional(),
}).strict();
export type InboxItem = z.infer<typeof InboxItemSchema>;

export interface InboxSummary {
  id: string; kind: InboxItemKind; status: InboxItemStatus; run: string; journey: string;
  step: string; agent: string; hasScreenshot: boolean; createdAt: string; ageSec: number;
}
export function toSummary(item: InboxItem, now = Date.now()): InboxSummary {
  return {
    id: item.id, kind: item.kind, status: item.status, run: item.run, journey: item.journey,
    step: item.step, agent: item.agent, hasScreenshot: item.hasScreenshot, createdAt: item.createdAt,
    ageSec: Math.max(0, Math.floor((now - Date.parse(item.createdAt)) / 1000)),
  };
}

export type Action = "approve" | "reject" | "resume" | "input";
export function resolveTransition(kind: InboxItemKind, action: Action): InboxItemStatus | "illegal" {
  if (action === "input") return "illegal"; // input appends a thread entry; it is not a resolution
  const table: Record<InboxItemKind, Partial<Record<Action, InboxItemStatus>>> = {
    approval: { approve: "approved", reject: "rejected" },
    handback: { resume: "resolved", reject: "rejected" },
    review:   { approve: "approved", reject: "rejected" },
  };
  return table[kind][action] ?? "illegal";
}
