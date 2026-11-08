/**
 * The adjudicator (docs/design/0.30.0-evidence-and-trust.md §4.1): one pure function from a
 * `RunEvidence` record to a `Verdict`. No I/O, no clock, no model. Advisory judgments in the record
 * are never read, so removing them never moves a verdict.
 */
import type { RunEvidence } from "./evidence.js";
import { judgeV1 } from "./rules-v1.js";
import type { MovedField, Rejudgement, RulesVersion, Verdict } from "./verdict.js";

const RULES: Record<RulesVersion, (evidence: RunEvidence) => Verdict> = { v1: judgeV1 };

export function adjudicate(evidence: RunEvidence, rules: RulesVersion = "v1"): Verdict {
  return RULES[rules](evidence);
}

/** Re-judge a stored record under another rule set and say which verdicts would move. */
export function rejudge(evidence: RunEvidence, from: RulesVersion, to: RulesVersion): Rejudgement {
  const before = adjudicate(evidence, from);
  const after = adjudicate(evidence, to);
  const moved: { field: MovedField; from: string; to: string }[] = [];
  const diff = (field: MovedField, a: string, b: string): void => {
    if (a !== b) moved.push({ field, from: a, to: b });
  };
  diff("job.attainment", before.job.attainment, after.job.attainment);
  diff("checks.verdict", before.checks?.verdict ?? "absent", after.checks?.verdict ?? "absent");
  const sites = [...new Set([...(before.checks?.assertions ?? []), ...(after.checks?.assertions ?? [])].map((a) => a.site))];
  for (const site of sites) {
    const a = before.checks?.assertions.find((x) => x.site === site)?.verdict ?? "absent";
    const b = after.checks?.assertions.find((x) => x.site === site)?.verdict ?? "absent";
    diff(`assertion:${site}`, a, b);
  }
  return { before, after, moved };
}
