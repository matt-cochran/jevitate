import { describe, expect, it } from "vitest";
import { acceptanceAuditResult } from "./acceptance-audit-schema.js";
import { renderAcceptanceAuditJunit, renderAcceptanceAuditMarkdown, renderAcceptanceAuditSarif } from "./acceptance-audit-render.js";

describe("#686 acceptance-audit renderers", () => {
  const result = acceptanceAuditResult({ requirementsFile: "r", suiteFile: "s" }, [{ asset: "requirements", state: "complete" }, { asset: "persona", state: "missing", reason: "absent" }]);
  it("renders the same findings as Markdown, JUnit, and SARIF", () => {
    expect(renderAcceptanceAuditMarkdown(result)).toContain("persona");
    expect(renderAcceptanceAuditJunit(result)).toContain("failures=\"1\"");
    expect(JSON.parse(renderAcceptanceAuditSarif(result)).runs[0].results[0]).toMatchObject({ ruleId: "persona", level: "error" });
  });
});
