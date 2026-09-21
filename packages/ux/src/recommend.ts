// recommend.ts — the generative remediation step (spec constraint #2/#4: BOTH
// model calls redacted; the recommendation is generated FROM the judgment +
// citation + already-redacted evidence refs, never free-form over raw copy).
//
// Signature accepts ONLY `RedactedEvidence` (branded) — raw evidence physically
// cannot reach the generation model. A generation error propagates so the
// analyzer surfaces `failed`, never a silent empty recommendation.
import { assertNoSecretInPayload, type GenerationPort } from "@jevitate/ai-core";
import type { UxFinding } from "./types.js";
import type { RedactedEvidence } from "./redact.js";

/** Summary of ONLY the redacted evidence the finding actually references. */
function evidenceSummaryFor(finding: UxFinding, evidence: RedactedEvidence): string {
  const parts: string[] = [];
  for (const ref of finding.evidenceRefs) {
    if (ref.id.startsWith("control:")) {
      const idx = Number(ref.id.slice("control:".length));
      const c = evidence.controls.find((ctrl) => ctrl.index === idx);
      if (c) parts.push(c.summary);
    } else if (ref.id === "visibleText") {
      parts.push(evidence.visibleText);
    }
  }
  return parts.join(" | ").slice(0, 4000);
}

/**
 * Turns a finding into a concrete, cited remediation. Reuses ai-core's
 * `GenerationPort` with the `ux.recommendation` task. The returned text always
 * carries the citation, independent of the model output.
 */
export async function recommend(
  gen: GenerationPort,
  finding: UxFinding,
  evidence: RedactedEvidence,
  secrets: readonly string[] = [],
): Promise<string> {
  const input = {
    principle: finding.rubricItemId,
    citationSource: finding.citation.source,
    citationRef: finding.citation.ref,
    judgmentSummary: finding.recommendation,
    evidenceSummary: evidenceSummaryFor(finding, evidence),
    appClass: evidence.appContext.appClass,
  };

  // Belt-and-suspenders: prove the outbound payload is secret-free before it goes.
  assertNoSecretInPayload(input, secrets);

  const result = await gen.generate("ux.recommendation", input);
  const body = result.output.recommendation.trim();
  return `${body} (${finding.citation.source}: ${finding.citation.ref})`;
}
