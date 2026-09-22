// analyzer.ts — the single UxAnalyzer (spec Milestone 3 / constraints #3/#4/#5/#7).
//
// - appContext REQUIRED (throws without it, #5).
// - each screen's evidence is redacted before any model call (#4).
// - independent rubric judgments batch into ONE Jev request per screen (#7).
// - a model error becomes `{kind:"failed"}`, NEVER `analyzed` with [] (#3).
// - items missing requiredEvidence are Skipped(reason); budget exhaustion records
//   budgetTruncated — never a hollow finding or a silent drop (#4, coverage-first).
import type { Answer, JudgmentPort } from "@jevitate/ai-core";
import { judgeScreen, questionKey } from "./judge.js";
import { redactEvidence, type RedactedEvidence, type Redactor } from "./redact.js";
import { makeFinding } from "./finding.js";
import type {
  AnalysisOutcome,
  AppContext,
  Coverage,
  EvidenceRef,
  FlagRule,
  RubricEntry,
  SkippedItem,
  UxEvidence,
  UxEvidenceKey,
  UxFinding,
} from "./types.js";

export class MissingAppContextError extends Error {
  readonly code = "E_UX_NO_APP_CONTEXT" as const;
  constructor() {
    super("appContext (appClass) is required — the analyzer refuses to run without it (constraint #5)");
    this.name = "MissingAppContextError";
  }
}

/** Deterministic a11y checker (Task 8). Returns findings that cite a11y rubric ids. */
export interface A11yChecker {
  (evidence: RedactedEvidence, rubric: ReadonlyMap<string, RubricEntry>): {
    readonly checked: readonly string[];
    readonly notChecked: readonly string[];
    readonly findings: readonly UxFinding[];
  };
}

export interface UxAnalyzerDeps {
  readonly judge: JudgmentPort;
  readonly redactor?: Redactor;
  readonly a11yChecker?: A11yChecker;
}

export interface AnalysisRequest {
  readonly screens: readonly UxEvidence[];
  readonly rubric: ReadonlyMap<string, RubricEntry>;
  readonly appContext: AppContext;
  readonly secrets?: readonly string[];
  /** Hard cap on Jev `systemOne` calls for the whole run (checked per screen). */
  readonly judgmentBudget: number;
}

/** Is a required evidence field actually populated on this screen? */
function evidencePresent(evidence: UxEvidence, key: UxEvidenceKey): boolean {
  switch (key) {
    case "controls":
      return evidence.controls.length > 0;
    case "visibleText":
      return evidence.visibleText.trim().length > 0;
    case "history":
      return evidence.history.length > 0;
    case "a11yFacts":
      return evidence.a11yFacts.controls.length > 0;
    case "job":
      return evidence.job !== undefined && evidence.job.trim().length > 0;
    case "appContext":
      return evidence.appContext.appClass.trim().length > 0;
    case "behavior":
    case "url":
    case "screenId":
      return true;
    default:
      return false;
  }
}

const SEVERITY_RANK = { info: 0, minor: 1, major: 2 } as const;

/** Does one answer trip its flag rule, and with what confidence? */
function evaluateFlag(flag: FlagRule, answer: Answer): { triggered: boolean; confidence: number } {
  switch (flag.when) {
    case "noul-true":
      return answer.kind === "noul" && answer.value === true
        ? { triggered: true, confidence: answer.probability }
        : { triggered: false, confidence: 0 };
    case "noul-false":
      return answer.kind === "noul" && answer.value === false
        ? { triggered: true, confidence: answer.probability }
        : { triggered: false, confidence: 0 };
    case "score-below":
      return answer.kind === "score" && answer.value < flag.threshold
        ? { triggered: true, confidence: clamp01(1 - answer.value) }
        : { triggered: false, confidence: 0 };
    case "score-above":
      return answer.kind === "score" && answer.value > flag.threshold
        ? { triggered: true, confidence: clamp01(answer.value) }
        : { triggered: false, confidence: 0 };
    case "choice-in":
      return answer.kind === "choice" && flag.options.includes(answer.value)
        ? { triggered: true, confidence: answer.confidence }
        : { triggered: false, confidence: 0 };
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** The concrete evidence refs a finding for this entry points at (≥1, all resolvable). */
function evidenceRefsFor(entry: RubricEntry, redacted: RedactedEvidence): EvidenceRef[] {
  const tokens = new Set<string>();
  for (const key of entry.requiredEvidence) {
    if (key === "controls") for (const c of redacted.controls) tokens.add(`control:${c.index}`);
    else if (key === "visibleText") tokens.add("visibleText");
    else if (key === "history") tokens.add("history");
    else if (key === "a11yFacts") tokens.add("a11y");
    else if (key === "behavior") tokens.add("behavior");
    else if (key === "url") tokens.add("url");
  }
  const refs = [...tokens].filter((t) => redacted.refs.has(t)).map((id) => ({ id }));
  // Always at least one resolvable ref (url/behavior are always present).
  return refs.length > 0 ? refs : [{ id: "url" }];
}

/** Default recommendation text — composed FROM the judgment + principle + citation. */
function defaultRecommendation(entry: RubricEntry, triggeredQuestionIds: readonly string[]): string {
  return `Address "${entry.principle}" on this screen (flagged: ${triggeredQuestionIds.join(", ")}). See ${entry.citation.source}: ${entry.citation.ref}.`;
}

export class UxAnalyzer {
  constructor(private readonly deps: UxAnalyzerDeps) {}

  async analyze(request: AnalysisRequest): Promise<AnalysisOutcome> {
    if (!request.appContext || request.appContext.appClass.trim().length === 0) {
      throw new MissingAppContextError();
    }
    const entries = [...request.rubric.values()];
    const jevEntries = entries.filter((e) => e.tier !== "objective-a11y");
    const a11yEntries = entries.filter((e) => e.tier === "objective-a11y");

    const findings: UxFinding[] = [];
    const skipped: SkippedItem[] = [];
    const budgetTruncated: string[] = [];
    let evaluated = 0;
    let totalItems = 0;
    let modelCalls = 0;

    for (const screen of request.screens) {
      // Budget gate at screen granularity — never truncate a screen mid-batch.
      if (modelCalls >= request.judgmentBudget) {
        budgetTruncated.push(screen.screenId);
        continue;
      }

      let redacted: RedactedEvidence;
      try {
        redacted = redactEvidence(screen, request.secrets ?? [], this.deps.redactor);
      } catch (cause) {
        return { kind: "failed", reason: `redaction failed: ${message(cause)}`, screenId: screen.screenId };
      }

      // Partition Jev entries into applicable vs Skipped(reason).
      const applicable: RubricEntry[] = [];
      for (const entry of jevEntries) {
        totalItems++;
        const missing = entry.requiredEvidence.filter((k) => !evidencePresent(screen, k));
        if (missing.length > 0) {
          skipped.push({ rubricItemId: entry.id, screenId: screen.screenId, reason: `missing required evidence: ${missing.join(", ")}` });
        } else {
          applicable.push(entry);
        }
      }

      // One batched Jev request for this screen-state.
      if (applicable.length > 0) {
        let answers: Record<string, Answer>;
        try {
          answers = await judgeScreen(this.deps.judge, redacted, applicable);
        } catch (cause) {
          return {
            kind: "failed",
            reason: `judgment failed: ${message(cause)}`,
            screenId: screen.screenId,
            rubricItemId: applicable[0]?.id,
          };
        }
        modelCalls++;
        for (const entry of applicable) {
          evaluated++;
          const finding = this.buildFinding(entry, answers, redacted, request.rubric);
          if (finding) findings.push(finding);
        }
      }

      // Objective a11y tier — deterministic, no model budget.
      if (a11yEntries.length > 0) {
        for (const entry of a11yEntries) {
          totalItems++;
          const missing = entry.requiredEvidence.filter((k) => !evidencePresent(screen, k));
          if (missing.length > 0) {
            skipped.push({ rubricItemId: entry.id, screenId: screen.screenId, reason: `missing required evidence: ${missing.join(", ")}` });
          }
        }
        if (this.deps.a11yChecker) {
          const anyApplicable = a11yEntries.some((e) => e.requiredEvidence.every((k) => evidencePresent(screen, k)));
          if (anyApplicable) {
            const res = this.deps.a11yChecker(redacted, request.rubric);
            evaluated += a11yEntries.filter((e) => e.requiredEvidence.every((k) => evidencePresent(screen, k))).length;
            findings.push(...res.findings);
          }
        }
      }
    }

    const coverage: Coverage = { totalItems, evaluated, skipped, budgetTruncated };
    return { kind: "analyzed", findings, coverage };
  }

  private buildFinding(
    entry: RubricEntry,
    answers: Record<string, Answer>,
    redacted: RedactedEvidence,
    rubric: ReadonlyMap<string, RubricEntry>,
  ): UxFinding | undefined {
    const triggeredIds: string[] = [];
    let severityRank = -1;
    let severity: UxFinding["severity"] = "info";
    let confidence = 0;
    for (const q of entry.questions) {
      const answer = answers[questionKey(entry.id, q.id)];
      if (!answer) continue;
      const { triggered, confidence: c } = evaluateFlag(q.flag, answer);
      if (!triggered) continue;
      triggeredIds.push(q.id);
      if (SEVERITY_RANK[q.severity] > severityRank) {
        severityRank = SEVERITY_RANK[q.severity];
        severity = q.severity;
      }
      if (c > confidence) confidence = c;
    }
    if (triggeredIds.length === 0) return undefined;
    return makeFinding(
      {
        rubricItemId: entry.id,
        evidenceRefs: evidenceRefsFor(entry, redacted),
        severity,
        confidence,
        recommendation: defaultRecommendation(entry, triggeredIds),
        tier: entry.tier,
        ...(entry.attentionProvenance
          ? { predictedAttention: { label: entry.attentionProvenance, note: "Inferred from semantic/visual hierarchy — not eye-tracking or gaze data." } }
          : {}),
      },
      rubric,
      redacted,
    );
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
