import { registerPreApprovalAnalyzer } from "./pre-approval.js";
import { jevReadinessAnalyzer, readinessAnalyzer } from "./readiness.js";

let registered = false;

/**
 * #434: registers the built-in pre-approval analyzers — readiness (deterministic checks + GtWR
 * rules) and the advisory Jev readiness questions — once per process. Called by the program wiring (`buildProgram`), so every approval path and every
 * review sheet, on the CLI and over MCP (which runs the CLI in process), runs them.
 */
export function registerBuiltinAnalyzers(): void {
  if (registered) return;
  registered = true;
  registerPreApprovalAnalyzer(readinessAnalyzer);
  registerPreApprovalAnalyzer(jevReadinessAnalyzer);
}
