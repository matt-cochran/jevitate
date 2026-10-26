import { describe, expect, it } from "vitest";
import { auditSuiteIntegrity } from "./acceptance-audit-suite.js";

describe("#686 suite acceptance integrity", () => {
  it("passes independently partitioned, revision-bound evidence with a negative control", () => {
    expect(auditSuiteIntegrity([
      { id: "checkout", revision: "abc123", partition: "purchase", sidecar: true, negativeControl: false },
      { id: "checkout-invalid", revision: "abc123", partition: "purchase", sidecar: true, negativeControl: true },
    ]).map(({ asset, state }) => [asset, state])).toEqual([
      ["suite-sidecar", "complete"], ["negative-control", "complete"], ["partition", "complete"], ["exact-revision", "complete"],
    ]);
  });

  it("reports each broken invariant with a machine-readable asset and reason", () => {
    const findings = auditSuiteIntegrity([{ id: "same", revision: "", partition: "", sidecar: false, negativeControl: false }, { id: "same", revision: "rev", partition: "p", sidecar: true, negativeControl: false }]);
    expect(findings).toMatchObject([
      { asset: "suite-sidecar", state: "missing", reason: expect.stringContaining("same") },
      { asset: "negative-control", state: "missing" },
      { asset: "partition", state: "inconclusive", reason: expect.stringContaining("duplicate") },
      { asset: "exact-revision", state: "stale", reason: expect.stringContaining("same") },
    ]);
  });
});
