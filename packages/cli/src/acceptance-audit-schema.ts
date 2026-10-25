/** #686 — the read-only contract shared by the acceptance-audit engine, renderers, and CLI. */
export const ACCEPTANCE_AUDIT_SCHEMA_VERSION = 1 as const;

export const ACCEPTANCE_AUDIT_ASSETS = [
  "requirements",
  "persona",
  "source-journey",
  "approved-hash",
  "verify-fix",
  "strict-review",
  "suite-sidecar",
  "negative-control",
  "partition",
  "exact-revision",
] as const;
export type AcceptanceAuditAsset = (typeof ACCEPTANCE_AUDIT_ASSETS)[number];

export type AcceptanceAuditState = "complete" | "missing" | "stale" | "inconclusive";
export type AcceptanceAuditExitCode = 0 | 1 | 64;

/** All input paths are local files; the audit neither invokes a model nor mutates project state. */
export interface AcceptanceAuditRequest {
  readonly requirementsFile: string;
  readonly suiteFile: string;
  readonly strict?: boolean;
}

/** One independently inspectable asset result; `reason` is mandatory whenever it does not pass. */
export interface AcceptanceAuditFinding {
  readonly asset: AcceptanceAuditAsset;
  readonly state: AcceptanceAuditState;
  readonly path?: string;
  readonly reason?: string;
}

/**
 * A deterministic audit result. `exitCode` is semantic: 0 means every required asset is complete,
 * 1 means an audit finding exists, and 64 means the request itself was invalid. No result grants
 * approval, promotion, credential, network, or execution authority.
 */
export interface AcceptanceAuditResult {
  readonly schemaVersion: typeof ACCEPTANCE_AUDIT_SCHEMA_VERSION;
  readonly request: AcceptanceAuditRequest;
  readonly findings: readonly AcceptanceAuditFinding[];
  readonly passed: boolean;
  readonly exitCode: AcceptanceAuditExitCode;
}

export function acceptanceAuditResult(request: AcceptanceAuditRequest, findings: readonly AcceptanceAuditFinding[]): AcceptanceAuditResult {
  const passed = findings.every((finding) => finding.state === "complete");
  return { schemaVersion: ACCEPTANCE_AUDIT_SCHEMA_VERSION, request, findings, passed, exitCode: passed ? 0 : 1 };
}
