import type { AcceptanceAuditResult } from "./acceptance-audit-schema.js";

const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function renderAcceptanceAuditMarkdown(result: AcceptanceAuditResult): string {
  return `# Acceptance audit\n\n${result.passed ? "Passed" : "Failed"} (exit ${result.exitCode}).\n\n| asset | state | reason |\n| --- | --- | --- |\n${result.findings.map((f) => `| ${f.asset} | ${f.state} | ${f.reason ?? ""} |`).join("\n")}\n`;
}

export function renderAcceptanceAuditJunit(result: AcceptanceAuditResult): string {
  const failures = result.findings.filter((f) => f.state !== "complete");
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="jevitate.acceptance-audit" tests="${result.findings.length}" failures="${failures.length}">${result.findings.map((f) => `<testcase name="${xml(f.asset)}">${f.state === "complete" ? "" : `<failure message="${xml(f.state)}">${xml(f.reason ?? "")}</failure>`}</testcase>`).join("")}</testsuite>\n`;
}

export function renderAcceptanceAuditSarif(result: AcceptanceAuditResult): string {
  return `${JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "jevitate acceptance audit", rules: result.findings.map((f) => ({ id: f.asset })) } }, results: result.findings.filter((f) => f.state !== "complete").map((f) => ({ ruleId: f.asset, level: "error", message: { text: f.reason ?? f.state } })) }] }, null, 2)}\n`;
}
