import { describe, expect, it } from "vitest";
import { ACCEPTANCE_AUDIT_ASSETS, acceptanceAuditResult } from "./acceptance-audit-schema.js";

describe("#686 acceptance audit contract", () => {
  it("names every mandatory acceptance asset", () => {
    expect(ACCEPTANCE_AUDIT_ASSETS).toEqual([
      "requirements", "persona", "source-journey", "approved-hash", "verify-fix", "strict-review", "suite-sidecar", "negative-control", "partition", "exact-revision",
    ]);
  });

  it("uses a semantic nonzero result for missing or stale local evidence", () => {
    const result = acceptanceAuditResult(
      { requirementsFile: "requirements.md", suiteFile: "suite.json", strict: true },
      [{ asset: "approved-hash", state: "stale", path: "journey.json", reason: "approved hash differs" }],
    );
    expect(result).toMatchObject({ schemaVersion: 1, passed: false, exitCode: 1 });
  });

  it("passes only when every required finding is complete", () => {
    const result = acceptanceAuditResult(
      { requirementsFile: "requirements.md", suiteFile: "suite.json" },
      ACCEPTANCE_AUDIT_ASSETS.map((asset) => ({ asset, state: "complete" as const })),
    );
    expect(result).toMatchObject({ passed: true, exitCode: 0 });
  });
});
