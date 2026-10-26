import type { AcceptanceAuditFinding } from "./acceptance-audit-schema.js";

/** Normalized suite evidence supplied by the CLI reader; this module performs no filesystem or network I/O. */
export interface AcceptanceSuiteEntry {
  readonly id: string;
  readonly revision: string;
  readonly partition: string;
  readonly sidecar: boolean;
  readonly negativeControl: boolean;
}

/**
 * #686 deterministic integrity checks. Each invariant is reported separately so consumers can
 * render a precise JUnit/SARIF finding; no entry is matched to a requirement by heuristic.
 */
export function auditSuiteIntegrity(entries: readonly AcceptanceSuiteEntry[]): AcceptanceAuditFinding[] {
  const duplicates = entries.filter((entry, index) => entries.findIndex((other) => other.id === entry.id) !== index).map((entry) => entry.id);
  const missingSidecar = entries.filter((entry) => !entry.sidecar).map((entry) => entry.id);
  const missingPartition = entries.filter((entry) => entry.partition.trim() === "").map((entry) => entry.id);
  const missingRevision = entries.filter((entry) => entry.revision.trim() === "").map((entry) => entry.id);
  const hasNegativeControl = entries.some((entry) => entry.negativeControl);
  return [
    {
      asset: "suite-sidecar",
      state: missingSidecar.length === 0 ? "complete" : "missing",
      ...(missingSidecar.length === 0 ? {} : { reason: `missing sidecar: ${missingSidecar.join(", ")}` }),
    },
    {
      asset: "negative-control",
      state: hasNegativeControl ? "complete" : "missing",
      ...(hasNegativeControl ? {} : { reason: "suite has no declared negative control" }),
    },
    {
      asset: "partition",
      state: duplicates.length === 0 && missingPartition.length === 0 ? "complete" : "inconclusive",
      ...(duplicates.length === 0 && missingPartition.length === 0 ? {} : { reason: [...(duplicates.length === 0 ? [] : [`duplicate ids: ${duplicates.join(", ")}`]), ...(missingPartition.length === 0 ? [] : [`unpartitioned: ${missingPartition.join(", ")}`])].join("; ") }),
    },
    {
      asset: "exact-revision",
      state: missingRevision.length === 0 ? "complete" : "stale",
      ...(missingRevision.length === 0 ? {} : { reason: `missing exact revision: ${missingRevision.join(", ")}` }),
    },
  ];
}
