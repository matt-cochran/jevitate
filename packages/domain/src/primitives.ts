import { z } from "zod";
import { nanoid } from "nanoid";

export type RiskClass = "read" | "external_write";
export type IsoTimestamp = string;

export const RiskClassSchema = z.enum(["read", "external_write"]);
export const IdempotencyKeySchema = z.string().min(1).max(200);
export const SiteIdSchema = z.string().min(1);
export const AccountIdSchema = z.string().min(1);

export function newCommandId(): string {
  return `cmd_${nanoid()}`;
}
