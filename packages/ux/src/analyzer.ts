// analyzer.ts — the single UxAnalyzer (spec Milestone 3 / constraints #3/#4/#5/#7).
//
// - appContext REQUIRED (throws without it, #5).
// - each screen's evidence is redacted before any model call (#4).
// - independent rubric judgments (+ one applicability judgment per item) batch into ONE Jev
//   request per screen (#7); entries failing their deterministic applicability gate are never
//   judged (coverage.notApplicable).
// - flagged items get ONE structured-output specifics call per screen; independent code
//   (adjudicate.ts) verifies every cited control/quote exists on that screen — ungrounded or
//   fabricated specifics are suppressed (counted), never findings.
// - occurrences of the same item × route × implicated controls/text are deduplicated into ONE
//   finding with an occurrence count; confidence per confidence.ts.
// - a model error becomes `{kind:"failed"}`, NEVER `analyzed` with [] (#3).
// - items missing requiredEvidence are Skipped(reason); budget exhaustion records
//   budgetTruncated — never a hollow finding or a silent drop (#4, coverage-first).
import type { Answer, GenerationPort, JudgmentPort } from "@jevitate/ai-core";
import { APPLIES_QUESTION_ID, judgeScreen, questionKey } from "./judge.js";
import { redactEvidence, type RedactedEvidence, type Redactor } from "./redact.js";
import { makeFinding } from "./finding.js";
import { generateSpecifics, type UxSpecificsItem } from "./specifics.js";
import { adjudicate, controlKey, normalizeText } from "./adjudicate.js";
import { clamp01, combineConfidence } from "./confidence.js";
import { routeOf } from "./route.js";
import { gradeCandidates, type QualityGrade } from "./grade.js";
import type { MakeFindingInput } from "./finding.js";
import type {
  AnalysisOutcome,
  AppContext,
  Coverage,
  EvidenceRef,
  FlagRule,
  RubricEntry,
  SkippedItem,
  SuppressedItem,
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
  /** Structured-output specifics for flagged items (observation / controls / quotes / fix). */
  readonly gen: GenerationPort;
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

/**
 * Does one answer trip its flag rule, and how likely is the principle VIOLATED? Oriented per
 * rule: a noul's `probability` is P(true), so for `noul-false` the violation probability is
 * 1 − P(true) (the old code reported P(true) — i.e. the confidence the screen was FINE).
 */
export function evaluateFlag(flag: FlagRule, answer: Answer): { triggered: boolean; violation: number } {
  switch (flag.when) {
    case "noul-true":
      return answer.kind === "noul" && answer.value === true
        ? { triggered: true, violation: clamp01(answer.probability) }
        : { triggered: false, violation: 0 };
    case "noul-false":
      return answer.kind === "noul" && answer.value === false
        ? { triggered: true, violation: clamp01(1 - answer.probability) }
        : { triggered: false, violation: 0 };
    case "score-below":
      return answer.kind === "score" && answer.value < flag.threshold
        ? { triggered: true, violation: flag.threshold > 0 ? clamp01((flag.threshold - answer.value) / flag.threshold) : 0 }
        : { triggered: false, violation: 0 };
    case "score-above":
      return answer.kind === "score" && answer.value > flag.threshold
        ? { triggered: true, violation: flag.threshold < 1 ? clamp01((answer.value - flag.threshold) / (1 - flag.threshold)) : 0 }
        : { triggered: false, violation: 0 };
    case "choice-in":
      return answer.kind === "choice" && flag.options.includes(answer.value)
        ? { triggered: true, violation: clamp01(answer.confidence) }
        : { triggered: false, violation: 0 };
  }
}

/** What one judged screen-state showed, for the agreement denominator. */
interface JudgedScreen {
  readonly controlKeys: ReadonlySet<string>;
  readonly text: string;
}

/** A flagged entry on one screen, before specifics. */
interface Flagged {
  readonly entry: RubricEntry;
  readonly severity: UxFinding["severity"];
  readonly violation: number;
  readonly applicability: number;
}

/** One adjudicated, grounded occurrence on one screen-state (pre-dedupe). */
interface Occurrence {
  readonly entry: RubricEntry;
  readonly screenId: string;
  readonly route: string;
  readonly refs: ReadonlySet<string>;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly controls: readonly string[];
  readonly dedupeKey: string;
  readonly controlKeys: readonly string[];
  readonly quotes: readonly string[];
  readonly observation: string;
  readonly userImpact: string;
  readonly recommendation: string;
  readonly severity: UxFinding["severity"];
  readonly violation: number;
  readonly applicability: number;
  readonly grounding: number;
}

const ATTENTION_NOTE = "Inferred from semantic/visual hierarchy — not eye-tracking or gaze data.";

export class UxAnalyzer {
  constructor(private readonly deps: UxAnalyzerDeps) {}

  async analyze(request: AnalysisRequest): Promise<AnalysisOutcome> {
    if (!request.appContext || request.appContext.appClass.trim().length === 0) {
      throw new MissingAppContextError();
    }
    const entries = [...request.rubric.values()];
    const jevEntries = entries.filter((e) => e.tier !== "objective-a11y");
    const a11yEntries = entries.filter((e) => e.tier === "objective-a11y");

    const occurrences: Occurrence[] = [];
    /** Redacted evidence per screen-state (the grader re-reads a finding's representative screen). */
    const redactedById = new Map<string, RedactedEvidence>();
    const a11yFindings: { finding: UxFinding; refs: ReadonlySet<string> }[] = [];
    const suppressed: SuppressedItem[] = [];
    const skipped: SkippedItem[] = [];
    const notApplicable: SkippedItem[] = [];
    const budgetTruncated: string[] = [];
    /**
     * `${entryId}|${route}` → what each screen-state judged for that entry on that route showed
     * (its control identities and normalized text) — the agreement denominator.
     */
    const judgedOnRoute = new Map<string, JudgedScreen[]>();
    let evaluated = 0;
    let totalItems = 0;
    let modelCalls = 0;
    let rawOccurrences = 0;

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
      const route = routeOf(redacted.url);
      redactedById.set(screen.screenId, redacted);

      // Partition Jev entries into applicable vs Skipped(reason) vs notApplicable(reason).
      const applicable: RubricEntry[] = [];
      for (const entry of jevEntries) {
        totalItems++;
        const missing = entry.requiredEvidence.filter((k) => !evidencePresent(screen, k));
        if (missing.length > 0) {
          skipped.push({ rubricItemId: entry.id, screenId: screen.screenId, reason: `missing required evidence: ${missing.join(", ")}` });
          continue;
        }
        const minControls = entry.applicability?.minControls;
        if (minControls !== undefined && screen.controls.length < minControls) {
          evaluated++;
          notApplicable.push({
            rubricItemId: entry.id,
            screenId: screen.screenId,
            reason: `not applicable: ${screen.controls.length} control(s) < ${minControls} required for "${entry.principle}"`,
          });
          continue;
        }
        applicable.push(entry);
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
        const judgedView: JudgedScreen = {
          controlKeys: new Set(redacted.controls.map((c) => controlKey(c))),
          text: normalizeText(`${redacted.visibleText} ${redacted.controls.map((c) => c.name).join(" ")}`),
        };
        const flagged: Flagged[] = [];
        for (const entry of applicable) {
          evaluated++;
          const key = `${entry.id}|${route}`;
          const list = judgedOnRoute.get(key) ?? [];
          list.push(judgedView);
          judgedOnRoute.set(key, list);
          const f = flagEntry(entry, answers);
          if (f) flagged.push(f);
        }
        rawOccurrences += flagged.length;

        // One structured-output specifics call for everything flagged on this screen.
        if (flagged.length > 0) {
          let items: readonly UxSpecificsItem[];
          try {
            items = (await generateSpecifics(this.deps.gen, redacted, flagged.map((f) => f.entry), request.secrets ?? [])).items;
          } catch (cause) {
            return {
              kind: "failed",
              reason: `finding specifics failed: ${message(cause)}`,
              screenId: screen.screenId,
              rubricItemId: flagged[0]?.entry.id,
            };
          }
          const byId = new Map<string, UxSpecificsItem>();
          for (const it of items) if (!byId.has(it.rubricItemId)) byId.set(it.rubricItemId, it);
          for (const f of flagged) {
            const item = byId.get(f.entry.id);
            if (!item) {
              suppressed.push({ rubricItemId: f.entry.id, route, screenId: screen.screenId, reason: "ungrounded", detail: "specifics step returned nothing for this item" });
              continue;
            }
            const verdict = adjudicate(item, redacted);
            if (verdict.kind === "suppressed") {
              suppressed.push({ rubricItemId: f.entry.id, route, screenId: screen.screenId, reason: verdict.reason, detail: verdict.detail });
              continue;
            }
            const identity = verdict.controlKeys.length > 0 ? verdict.controlKeys.join("+") : `text:${verdict.quotes.map((q) => q.toLowerCase()).sort().join("+")}`;
            occurrences.push({
              entry: f.entry,
              screenId: screen.screenId,
              route,
              refs: redacted.refs,
              evidenceRefs: verdict.evidenceRefs,
              controls: verdict.controls,
              dedupeKey: `${f.entry.id}|${route}|${identity}`,
              controlKeys: verdict.controlKeys,
              quotes: verdict.quotes,
              observation: verdict.observation,
              userImpact: verdict.userImpact,
              recommendation: verdict.recommendation,
              severity: f.severity,
              violation: f.violation,
              applicability: f.applicability,
              grounding: verdict.grounding,
            });
          }
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
            rawOccurrences += res.findings.length;
            for (const finding of res.findings) a11yFindings.push({ finding, refs: redacted.refs });
          }
        }
      }
    }

    // Dedupe, then the independent quality pass: one grader request per representative screen.
    const drafts = dedupeSemantic(occurrences, judgedOnRoute);
    const byScreen = new Map<string, Draft[]>();
    for (const d of drafts) {
      const list = byScreen.get(d.screenId) ?? [];
      list.push(d);
      byScreen.set(d.screenId, list);
    }
    const grades = new Map<string, QualityGrade>();
    for (const [screenId, list] of [...byScreen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const evidence = redactedById.get(screenId);
      if (!evidence) continue;
      try {
        const g = await gradeCandidates(
          this.deps.judge,
          evidence,
          list.map((d) => ({
            key: d.key,
            principle: d.principle,
            observation: d.input.observation,
            userImpact: d.input.userImpact,
            recommendation: d.input.recommendation,
            controls: d.input.controls ?? [],
            quotes: d.input.quotes ?? [],
          })),
        );
        for (const [k, v] of g) grades.set(k, v);
      } catch (cause) {
        return { kind: "failed", reason: `quality grading failed: ${message(cause)}`, screenId, rubricItemId: list[0]?.input.rubricItemId };
      }
    }
    const findings = [
      ...drafts.map((d) => {
        const quality = grades.get(d.key);
        return makeFinding({ ...d.input, ...(quality ? { quality } : {}) }, request.rubric, { screenId: d.screenId, refs: d.refs });
      }),
      ...dedupeObjective(a11yFindings, request.rubric),
    ];
    const coverage: Coverage = { totalItems, evaluated, skipped, budgetTruncated, notApplicable };
    return { kind: "analyzed", findings, coverage, suppressed, rawOccurrences };
  }
}

/** Which of an entry's questions tripped, with severity, violation and applicability. */
function flagEntry(entry: RubricEntry, answers: Record<string, Answer>): Flagged | undefined {
  let severityRank = -1;
  let severity: UxFinding["severity"] = "info";
  let violation = 0;
  let triggered = false;
  for (const q of entry.questions) {
    const answer = answers[questionKey(entry.id, q.id)];
    if (!answer) continue;
    const r = evaluateFlag(q.flag, answer);
    if (!r.triggered) continue;
    triggered = true;
    if (SEVERITY_RANK[q.severity] > severityRank) {
      severityRank = SEVERITY_RANK[q.severity];
      severity = q.severity;
    }
    if (r.violation > violation) violation = r.violation;
  }
  if (!triggered) return undefined;
  const applies = answers[questionKey(entry.id, APPLIES_QUESTION_ID)];
  // An unanswered applicability question is NOT assumed applicable — it contributes 0.
  const applicability = applies && applies.kind === "noul" ? clamp01(applies.probability) : 0;
  return { entry, severity, violation, applicability };
}

/** A deduplicated semantic finding before grading + construction. */
interface Draft {
  readonly key: string;
  readonly principle: string;
  readonly screenId: string;
  readonly refs: ReadonlySet<string>;
  readonly input: MakeFindingInput;
}

/** Same item × route × implicated controls/text → ONE draft with an occurrence count (deterministic order). */
function dedupeSemantic(occurrences: readonly Occurrence[], judgedOnRoute: ReadonlyMap<string, readonly JudgedScreen[]>): Draft[] {
  const groups = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const g = groups.get(o.dedupeKey);
    if (g) g.push(o);
    else groups.set(o.dedupeKey, [o]);
  }
  const out: Draft[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = group[0];
    if (!first) continue;
    // Agreement denominator: judged screen-states on this route where the SAME evidence was
    // present (the implicated controls, or the quoted text) — so an issue on a control that
    // only appears in some states is not diluted by states that never showed it.
    const judged = (judgedOnRoute.get(`${first.entry.id}|${first.route}`) ?? []).filter((j) =>
      first.controlKeys.length > 0
        ? first.controlKeys.every((k) => j.controlKeys.has(k))
        : first.quotes.every((q) => j.text.includes(normalizeText(q))),
    ).length;
    const { confidence, basis } = combineConfidence(group, judged);
    // Representative = the best-grounded, most-confident occurrence (ties: first observed).
    const rep = [...group].sort((a, b) => b.grounding * b.violation - a.grounding * a.violation)[0] ?? first;
    const severity = group.reduce<UxFinding["severity"]>((s, o) => (SEVERITY_RANK[o.severity] > SEVERITY_RANK[s] ? o.severity : s), "info");
    out.push({
      key,
      principle: rep.entry.principle,
      screenId: rep.screenId,
      refs: rep.refs,
      input: {
        rubricItemId: rep.entry.id,
        evidenceRefs: rep.evidenceRefs,
        severity,
        confidence,
        observation: rep.observation,
        userImpact: rep.userImpact,
        recommendation: rep.recommendation,
        tier: rep.entry.tier,
        route: rep.route,
        controls: rep.controls,
        quotes: rep.quotes,
        occurrences: group.length,
        screenIds: [...new Set(group.map((o) => o.screenId))],
        confidenceBasis: basis,
        ...(rep.entry.attentionProvenance ? { predictedAttention: { label: rep.entry.attentionProvenance, note: ATTENTION_NOTE } } : {}),
      },
    });
  }
  return out;
}

/** Objective (deterministic) findings: dedupe identical item × route × controls; confidence stays computed. */
function dedupeObjective(
  items: readonly { finding: UxFinding; refs: ReadonlySet<string> }[],
  rubric: ReadonlyMap<string, RubricEntry>,
): UxFinding[] {
  const groups = new Map<string, { finding: UxFinding; refs: ReadonlySet<string> }[]>();
  for (const it of items) {
    const f = it.finding;
    const key = `${f.rubricItemId}|${f.route}|${f.controls.join("+") || f.evidenceRefs.map((r) => r.id).join("+")}`;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  const out: UxFinding[] = [];
  for (const group of groups.values()) {
    const rep = group[0];
    if (!rep) continue;
    const f = rep.finding;
    out.push(
      makeFinding(
        {
          rubricItemId: f.rubricItemId,
          evidenceRefs: f.evidenceRefs,
          severity: f.severity,
          confidence: f.confidence,
          observation: f.observation,
          userImpact: f.userImpact,
          recommendation: f.recommendation,
          tier: f.tier,
          route: f.route,
          controls: f.controls,
          quotes: f.quotes,
          occurrences: group.length,
          screenIds: [...new Set(group.map((g) => g.finding.screenId))],
          ...(f.predictedAttention ? { predictedAttention: f.predictedAttention } : {}),
        },
        rubric,
        { screenId: f.screenId, refs: rep.refs },
      ),
    );
  }
  return out;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
