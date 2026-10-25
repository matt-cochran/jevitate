import { describe, expect, it } from "vitest";
import { renderHashBoundApprovalScript } from "./acceptance-audit-approval-script.js";

describe("#686 hash-bound approval proposal", () => {
  it("is dry-run by default and rechecks every input before any human approval boundary", () => {
    const script = renderHashBoundApprovalScript([{ path: "journey.json", content: "{}" }]);
    expect(script).toContain('"${1:-}" != "--apply"');
    expect(script).toContain("sha256sum 'journey.json'");
    expect(script).toContain("hash mismatch: journey.json");
    expect(script).not.toMatch(/npm publish|gh pr merge|secret|curl|fetch/);
  });
});
