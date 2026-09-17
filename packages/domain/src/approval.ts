import { createHash } from "node:crypto";
import type { IsoTimestamp } from "./primitives.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface ApprovalBinding {
  commandId: string;
  recipientHash: string;
  contentHash: string;
  actionId: string;
  actionVersion: string;
  artifactHash: string;
  settingsRevision: string;
  expiresAt: IsoTimestamp;
}

export function bindingMatches(a: ApprovalBinding, b: ApprovalBinding): boolean {
  return contentHash(a) === contentHash(b);
}

export function isExpired(a: ApprovalBinding, now: IsoTimestamp): boolean {
  return new Date(now).getTime() > new Date(a.expiresAt).getTime();
}
