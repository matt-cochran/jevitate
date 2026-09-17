import type { RiskClass } from "./primitives.js";

export type ApprovalMode = "none" | "writes" | "all";

export interface PolicyContext {
  risk: RiskClass;
  isNewContact: boolean;
  approvalMode: ApprovalMode;
  newContactsEnabled: boolean;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "require_approval" }
  | { kind: "deny"; reason: string };

export function decide(ctx: PolicyContext): Decision {
  if (ctx.isNewContact && !ctx.newContactsEnabled) {
    return { kind: "deny", reason: "new outbound contacts are disabled" };
  }
  if (ctx.approvalMode === "all") return { kind: "require_approval" };
  if (ctx.risk === "external_write" && ctx.approvalMode === "writes") {
    return { kind: "require_approval" };
  }
  return { kind: "allow" };
}
