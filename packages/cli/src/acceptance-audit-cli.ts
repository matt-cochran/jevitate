import { readFile, mkdir, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { auditCoreAcceptanceAssets } from "./acceptance-audit.js";
import { acceptanceAuditResult } from "./acceptance-audit-schema.js";
import { auditSuiteIntegrity, type AcceptanceSuiteEntry } from "./acceptance-audit-suite.js";
import { renderAcceptanceAuditJunit, renderAcceptanceAuditMarkdown, renderAcceptanceAuditSarif } from "./acceptance-audit-render.js";
import { emitEnvelope } from "./cli-output.js";
import { ok, fail } from "./envelope.js";

export function registerAcceptanceAuditCommands(program: Command): void {
  const acceptance = program.command("acceptance").description("read-only acceptance evidence tools");
  acceptance.command("audit").description("audit release acceptance evidence and emit CI artifacts")
    .requiredOption("--requirements <file>")
    .requiredOption("--suite <file>")
    .option("--persona <file>").option("--journey <file>").option("--approval <file>").option("--verify <file>").option("--review <file>")
    .option("--out <dir>").option("--json")
    .action(async function (this: Command) {
      const o = this.opts<{ requirements: string; suite: string; persona?: string; journey?: string; approval?: string; verify?: string; review?: string; out?: string; json?: boolean }>();
      try {
        const core = await auditCoreAcceptanceAssets({ requirements: o.requirements, persona: o.persona, sourceJourney: o.journey, approvedHash: o.approval, verifyFix: o.verify, strictReview: o.review });
        const entries = JSON.parse(await readFile(o.suite, "utf8")) as AcceptanceSuiteEntry[];
        if (!Array.isArray(entries)) throw new Error("suite must be a JSON array of acceptance entries");
        const result = acceptanceAuditResult({ requirementsFile: o.requirements, suiteFile: o.suite, strict: true }, [...core, ...auditSuiteIntegrity(entries)]);
        if (o.out !== undefined) { await mkdir(o.out, { recursive: true }); await Promise.all([writeFile(`${o.out}/acceptance-audit.md`, renderAcceptanceAuditMarkdown(result)), writeFile(`${o.out}/acceptance-audit.junit.xml`, renderAcceptanceAuditJunit(result)), writeFile(`${o.out}/acceptance-audit.sarif`, renderAcceptanceAuditSarif(result)), writeFile(`${o.out}/acceptance-audit.json`, `${JSON.stringify(result, null, 2)}\n`)]); }
        emitEnvelope(program, ok(result), { json: o.json === true, exitCode: result.exitCode, command: "acceptance audit", human: (r) => renderAcceptanceAuditMarkdown(r) });
      } catch (err) { emitEnvelope(program, fail("E_ACCEPTANCE_AUDIT", err instanceof Error ? err.message : String(err)), { json: o.json === true, command: "acceptance audit" }); }
    });
}
