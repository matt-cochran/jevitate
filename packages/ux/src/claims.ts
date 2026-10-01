// claims.ts — the UX findings pipeline (#198): findings are CLAIMS that code verifies.
//
// Where a claim comes from (never from a rubric sprayed over every screen):
//   - code: every destructive control the live run's guard probe clicked (writes blocked) — a
//     `destructive-unguarded` claim, its target fixed by code;
//   - product facts (`.jevitate/product.json`): a price/trial on screen that contradicts the facts
//     (`fact-conflict`, found by text matching), and each page whose intended next step the facts
//     name (`next-step-unclear`);
//   - observed friction (friction.ts) no run signal already explains: Jev CATEGORIZES it — a claim
//     type from a closed list (or not-a-problem) and a target control from the page's real
//     controls, bounded below the choice cap (#192).
//
// How it becomes a finding — independent code decides, Jev is advisory:
//   1. verify: every claim is checked by code against what the run measured (the guard probe's
//      dialog/blocked-write record, the product facts, the friction's own steps and the page's
//      controls). A claim that fails is dropped — counted in the claim ledger, never shown;
//   2. merge: same type × route × target merges by code; a finding that shares a route or control
//      with an earlier one gets ONE Jev duplicate choice (merged findings stay as `contributing`);
//   3. grade: two Jev yes/no questions — "do we need this?" and "do we need this to complete and
//      ship this feature?" — mapped to actionable / relevant-minor / generic / wrong by code
//      (`CLAIM_PROMPTS.cutoffs`);
//   4. prose: built from a TEMPLATE over the verified structured fields (`assets/ux-claims.json`).
//      Generated polish is opt-in (`polish`), once per verified finding, citation kept.
//
// Evidence passes the redaction door (redact.ts) before any model call; a model error is a
// `failed` outcome, never an empty `analyzed` one.
import { MAX_CHOICE_OPTIONS, type Answer, type GenerationPort, type JudgmentPort, type Question } from "@jevitate/ai-core";
import { controlKey, normalizeText } from "./adjudicate.js";
import { CLAIM_PROMPTS, FRICTION_CLAIM_CHOICES, fillClaimTemplate, type ClaimPrompts, type ClaimType, type FrictionClaimChoice, type TemplateKey } from "./claim-prompts.js";
import { dedupeObjectiveFindings, type A11yChecker } from "./analyzer.js";
import { makeFinding } from "./finding.js";
import { IMPACT_RANK, type FrictionPoint } from "./friction.js";
import { buildState } from "./judge.js";
import { factsPageFor, findFactConflicts, journeysFor, namesStep, type FactConflict, type ProductFacts } from "./product-facts.js";
import type { QualityLabel } from "./prompts.js";
import { recommend } from "./recommend.js";
import { redactEvidence, type RedactedControl, type RedactedEvidence, type Redactor } from "./redact.js";
import { routeOf } from "./route.js";
import type { SignalStep } from "./signals.js";
import type { AnalysisOutcome, ContributingFinding, Coverage, JobImpact, RubricEntry, SkippedItem, SuppressedItem, UxEvidence, UxFinding } from "./types.js";


/** The rubric entry each claim type is cited under — the rubric EXPLAINS a verified claim. */
export const CLAIM_RUBRIC: Readonly<Record<ClaimType, string>> = {
  "destructive-unguarded": "nielsen-5",
  "fact-conflict": "nielsen-4",
  "next-step-unclear": "primary-action",
  "no-feedback": "nielsen-1",
  "blocked-action": "nielsen-9",
  "error-unrecoverable": "nielsen-9",
};

// ---------- the guard probe (code evidence, from the live run) ----------

export type GuardKind = "native-dialog" | "dom-dialog" | "navigation" | "none";

/**
 * One destructive control the live run clicked with every write request blocked (cli
 * `ux-claim-probe.ts`): did anything guard it, and did it try to write? Redacted; persisted in the
 * evidence sidecar so offline review verifies the same claims.
 */
export interface GuardProbe {
  readonly screenId: string;
  readonly route: string;
  /** `button "Delete user"`. */
  readonly control: string;
  /** adjudicate.ts `controlKey` (role + name). */
  readonly controlKey: string;
  /** `probed`, or why it was not: not found again on a fresh load, refused (`--deny`), or the probe failed. */
  readonly status: "probed" | "not-found" | "refused" | "failed";
  readonly guard?: GuardKind;
  /** The write requests the click attempted (and the probe blocked), e.g. `DELETE /api/users/:id`. */
  readonly blockedWrites?: readonly string[];
  readonly detail: string;
}

// ---------- the claim ledger (every candidate, accounted for) ----------

export type ClaimStatus = "verified" | "merged" | "refuted" | "unverifiable" | "dismissed" | "budget-truncated";
export type ClaimSource = "guard-probe" | "product-facts" | "friction";

export interface ClaimRecord {
  /** The claim type, or `not-a-problem` (Jev dismissed the friction) / `uncategorized` (never judged). */
  readonly type: ClaimType | "not-a-problem" | "uncategorized";
  readonly source: ClaimSource;
  readonly route: string;
  readonly screenId: string;
  readonly target?: string;
  readonly friction?: string;
  readonly status: ClaimStatus;
  /** Why code verified, refuted or could not check it. */
  readonly reason: string;
}

export interface ClaimLedger {
  readonly candidates: number;
  readonly verified: number;
  readonly merged: number;
  readonly refuted: number;
  readonly unverifiable: number;
  readonly dismissed: number;
  readonly budgetTruncated: number;
  readonly items: readonly ClaimRecord[];
}

/** A verified finding's claim provenance (`UxFinding.claim`). */
export interface FindingClaim {
  readonly type: ClaimType;
  readonly source: ClaimSource;
  /** What code checked, e.g. `guard-probe`, `product-facts`, `friction:retry@4-5`. */
  readonly verifiedBy: string;
  readonly verification: string;
  readonly target?: string;
}

// ---------- request ----------

export interface ClaimAnalysisRequest {
  readonly screens: readonly UxEvidence[];
  /** Citations (and the objective a11y entries) — `loadV1Rubric()`. */
  readonly rubric: ReadonlyMap<string, RubricEntry>;
  readonly appContext: UxEvidence["appContext"];
  readonly secrets?: readonly string[];
  /** Hard cap on Jev `systemOne` calls (classification + grading, one per screen each). */
  readonly judgmentBudget: number;
  readonly friction?: readonly FrictionPoint[];
  /** The run's steps (what it acted on) — next-step verification. */
  readonly steps?: readonly SignalStep[];
  /** Run-signal findings: friction they already explain is not re-claimed. */
  readonly signalFindings?: readonly UxFinding[];
  readonly facts?: ProductFacts;
  /**
   * The live guard probes (or the sidecar's copy): every control the safety policy calls destructive,
   * clicked with writes blocked. Absent offline without a sidecar — destructive claims are then
   * unverifiable (coverage, not findings). An empty list means the run found nothing destructive.
   */
  readonly probes?: readonly GuardProbe[];
}

export interface ClaimAnalyzerDeps {
  readonly judge: JudgmentPort;
  /** Only for opt-in polish. */
  readonly gen?: GenerationPort;
  /** Opt-in: polish each verified finding's recommendation with ONE generation call. */
  readonly polish?: boolean;
  readonly redactor?: Redactor;
  readonly a11yChecker?: A11yChecker;
  readonly prompts?: ClaimPrompts;
}

// ---------- internals ----------

interface Screen {
  readonly raw: UxEvidence;
  readonly red: RedactedEvidence;
  readonly route: string;
}

interface Candidate {
  readonly id: number;
  readonly source: ClaimSource;
  readonly screen: Screen;
  type?: ClaimType | "not-a-problem";
  target?: RedactedControl;
  readonly friction?: FrictionPoint;
  readonly probe?: GuardProbe;
  readonly conflict?: FactConflict;
  readonly nextStep?: string;
}

interface Verdict {
  readonly status: "verified" | "refuted" | "unverifiable";
  readonly reason: string;
  readonly verifiedBy?: string;
  readonly strength?: number;
  readonly template?: TemplateKey;
  readonly vars?: Readonly<Record<string, string>>;
  readonly impact?: JobImpact;
  readonly severity?: UxFinding["severity"];
  readonly quotes?: readonly string[];
  /** A control the finding implicates even when the claim had no Jev-chosen target. */
  readonly implicated?: RedactedControl;
}

interface Draft {
  readonly key: string;
  readonly type: ClaimType;
  readonly source: ClaimSource;
  readonly screen: Screen;
  readonly target?: RedactedControl;
  readonly verdict: Verdict;
  readonly friction?: FrictionPoint;
  occurrences: number;
  readonly screenIds: Set<string>;
}

const IMPACT_SEVERITY: Readonly<Record<JobImpact, UxFinding["severity"]>> = { blocked: "major", slowed: "minor", confused: "minor", cosmetic: "info" };
const NAV_FRICTION = new Set(["backtrack", "abandoned", "goal-not-reached", "dead-end"]);

export const NONE_TARGET = "none";

function label(c: RedactedControl): string {
  return c.name.trim().length > 0 ? `${c.role || "control"} "${c.name}"` : `${c.role || "control"} (unnamed, control:${c.index})`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Does a transcript step's target (a control summary) name this control? */
function stepNames(step: SignalStep, c: RedactedControl): boolean {
  if (step.target === null || c.name.trim().length === 0) return false;
  return normalizeText(step.target).includes(normalizeText(c.name));
}

/**
 * The target-control options, bounded below the judgment API's choice cap (#192): controls the
 * friction's own steps acted on first, then controls whose words the friction names, then the rest
 * in page order. `none` is always offered.
 */
export function boundTargetOptions(controls: readonly RedactedControl[], point: FrictionPoint, steps: readonly SignalStep[], limit = MAX_CHOICE_OPTIONS - 1): RedactedControl[] {
  if (controls.length <= limit) return [...controls];
  const acted = steps.filter((s) => point.steps.includes(s.step));
  const words = new Set(normalizeText(point.detail).split(" ").filter((w) => w.length >= 3));
  const score = (c: RedactedControl): number =>
    (acted.some((s) => stepNames(s, c)) ? 400 : 0) + (normalizeText(c.name).split(" ").some((w) => words.has(w)) ? 60 : 0) + (c.enabled ? 10 : 0);
  const keep = new Set(
    controls
      .map((c, i) => ({ c, i, s: score(c) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.c.index),
  );
  return controls.filter((c) => keep.has(c.index));
}

function frictionText(p: FrictionPoint): string {
  return `${p.kind} (steps ${p.steps.join(", ")}): ${p.detail}`.slice(0, 600);
}

function describeDraft(d: Draft, prose: { observation: string }): string {
  return `${d.type} — ${prose.observation}`.slice(0, 600);
}

/** The two-question grade → label (code). P(yes) is a noul's probability of `true`. */
export function gradeLabel(need: number, ship: number, cutoffs: ClaimPrompts["cutoffs"] = CLAIM_PROMPTS.cutoffs): { label: QualityLabel; confidence: number } {
  if (need >= cutoffs.need) {
    return ship >= cutoffs.ship ? { label: "actionable", confidence: Math.min(need, ship) } : { label: "relevant-minor", confidence: Math.min(need, 1 - ship) };
  }
  return need <= cutoffs.wrong ? { label: "wrong", confidence: 1 - need } : { label: "generic", confidence: 1 - need };
}

function noulP(a: Answer | undefined, key: string): number {
  if (!a || a.kind !== "noul" || !Number.isFinite(a.probability)) throw new Error(`claim grader returned no yes/no answer for '${key}'`);
  return Math.min(1, Math.max(0, a.probability));
}

/** Runs the claim pipeline over one run's screens (see the module header). */
export async function analyzeClaims(request: ClaimAnalysisRequest, deps: ClaimAnalyzerDeps): Promise<AnalysisOutcome> {
  const prompts = deps.prompts ?? CLAIM_PROMPTS;
  const secrets = request.secrets ?? [];
  const friction = request.friction ?? [];
  const steps = request.steps ?? [];
  const probes = request.probes ?? [];

  // Redaction door: every screen, before anything reaches a model.
  const screens: Screen[] = [];
  for (const raw of request.screens) {
    try {
      const red = redactEvidence(raw, secrets, deps.redactor);
      screens.push({ raw, red, route: routeOf(red.url) });
    } catch (cause) {
      return { kind: "failed", reason: `redaction failed: ${message(cause)}`, screenId: raw.screenId };
    }
  }
  const byId = new Map(screens.map((s) => [s.raw.screenId, s]));
  const onRoute = (route: string): Screen[] => screens.filter((s) => s.route === route);

  const records: ClaimRecord[] = [];
  const suppressed: SuppressedItem[] = [];
  const skipped: SkippedItem[] = [];
  const budgetTruncated = new Set<string>();
  let calls = 0;
  const candidates: Candidate[] = [];
  const add = (c: Omit<Candidate, "id">): void => {
    candidates.push({ ...c, id: candidates.length });
  };

  // 1. Code-sourced: guard probes (one per route × control).
  const probed = new Set<string>();
  for (const p of probes) {
    const k = `${p.route}|${p.controlKey}`;
    if (probed.has(k)) continue;
    probed.add(k);
    const screen = byId.get(p.screenId) ?? onRoute(p.route)[0];
    if (screen === undefined) {
      records.push({ type: "destructive-unguarded", source: "guard-probe", route: p.route, screenId: p.screenId, target: p.control, status: "unverifiable", reason: "the probed screen was not analyzed" });
      continue;
    }
    const target = screen.red.controls.find((c) => controlKey(c) === p.controlKey);
    add({ source: "guard-probe", screen, type: "destructive-unguarded", probe: p, ...(target === undefined ? {} : { target }) });
  }

  // 2. Product facts: fact conflicts (code text match) and intended next steps.
  const conflictSeen = new Set<string>();
  for (const s of screens) {
    for (const conflict of findFactConflicts(s.red.visibleText, request.facts)) {
      const k = `${s.route}|${conflict.kind}|${conflict.plan ?? ""}|${conflict.found}`;
      if (conflictSeen.has(k)) continue;
      conflictSeen.add(k);
      add({ source: "product-facts", screen: s, type: "fact-conflict", conflict });
    }
  }
  const routes = [...new Set(screens.map((s) => s.route))];
  for (const route of routes) {
    const page = factsPageFor(request.facts, route);
    if (page !== undefined) add({ source: "product-facts", screen: onRoute(route)[0]!, type: "next-step-unclear", nextStep: page.nextStep });
  }

  // 3. Friction no run signal explains — categorized by Jev.
  const signalSteps = new Set((request.signalFindings ?? []).flatMap((f) => [...(f.signal?.steps ?? []), ...(f.journeyEvidence?.steps ?? [])]));
  const signalScreens = new Set((request.signalFindings ?? []).flatMap((f) => f.screenIds));
  for (const point of friction) {
    if (point.steps.some((n) => signalSteps.has(n)) || point.screenIds.some((id) => signalScreens.has(id))) continue;
    const screen = point.screenIds.map((id) => byId.get(id)).find((s) => s !== undefined) ?? point.routes.map((r) => onRoute(r)[0]).find((s) => s !== undefined);
    if (screen === undefined) {
      records.push({ type: "uncategorized", source: "friction", route: point.routes[0] ?? "", screenId: point.screenIds[0] ?? "", friction: point.id, status: "unverifiable", reason: "no analyzed screen for this friction point" });
      continue;
    }
    add({ source: "friction", screen, friction: point });
  }

  // Jev categorization: ONE batched request per screen with friction candidates.
  const toClassify = candidates.filter((c) => c.source === "friction");
  for (const [screenId, group] of groupBy(toClassify, (c) => c.screen.raw.screenId)) {
    if (calls >= request.judgmentBudget) {
      budgetTruncated.add(screenId);
      continue;
    }
    const screen = group[0]!.screen;
    const questions: Record<string, Question> = {};
    const options = new Map<number, RedactedControl[]>();
    for (const c of group) {
      const point = c.friction!;
      questions[`claim::${c.id}::type`] = {
        kind: "choice",
        options: [...FRICTION_CLAIM_CHOICES],
        descriptions: { ...prompts.types },
        instructions: prompts.classify.type.replace("{friction}", frictionText(point)),
      };
      const bounded = boundTargetOptions(screen.red.controls, point, steps);
      options.set(c.id, bounded);
      questions[`claim::${c.id}::target`] = {
        kind: "choice",
        options: [NONE_TARGET, ...bounded.map((x) => `control:${x.index}`)],
        descriptions: Object.fromEntries([[NONE_TARGET, "no single control"], ...bounded.map((x) => [`control:${x.index}`, x.summary.slice(0, 200)])]),
        instructions: prompts.classify.target.replace("{friction}", frictionText(point)),
      };
    }
    let answers: Record<string, Answer>;
    try {
      answers = await deps.judge.systemOne({ state: buildState(screen.red), questions });
    } catch (cause) {
      return { kind: "failed", reason: `claim categorization failed: ${message(cause)}`, screenId };
    }
    calls++;
    for (const c of group) {
      const t = answers[`claim::${c.id}::type`];
      if (!t || t.kind !== "choice" || !(FRICTION_CLAIM_CHOICES as readonly string[]).includes(t.value)) {
        return { kind: "failed", reason: `claim categorization returned no valid claim type for friction '${c.friction!.id}'`, screenId };
      }
      c.type = t.value as FrictionClaimChoice;
      const g = answers[`claim::${c.id}::target`];
      const allowed = options.get(c.id) ?? [];
      if (!g || g.kind !== "choice" || (g.value !== NONE_TARGET && !allowed.some((x) => `control:${x.index}` === g.value))) {
        return { kind: "failed", reason: `claim categorization returned no valid target for friction '${c.friction!.id}'`, screenId };
      }
      if (g.value !== NONE_TARGET) c.target = allowed.find((x) => `control:${x.index}` === g.value);
    }
  }

  // Verification (code) — every candidate.
  const drafts: Draft[] = [];
  const draftByKey = new Map<string, Draft>();
  for (const c of candidates) {
    const base = {
      source: c.source,
      route: c.screen.route,
      screenId: c.screen.raw.screenId,
      ...(c.target === undefined ? (c.probe === undefined ? {} : { target: c.probe.control }) : { target: label(c.target) }),
      ...(c.friction === undefined ? {} : { friction: c.friction.id }),
    };
    if (c.type === undefined) {
      records.push({ ...base, type: "uncategorized", status: "budget-truncated", reason: "the judgment budget ran out before this friction was categorized" });
      skipped.push({ rubricItemId: "claim:uncategorized", screenId: c.screen.raw.screenId, reason: `judgment budget exhausted before friction ${c.friction?.id ?? ""} was categorized` });
      continue;
    }
    if (c.type === "not-a-problem") {
      records.push({ ...base, type: "not-a-problem", status: "dismissed", reason: "Jev judged the friction not a problem with the page" });
      suppressed.push({ rubricItemId: `claim:${c.friction?.kind ?? "friction"}`, route: c.screen.route, screenId: c.screen.raw.screenId, reason: "not-a-problem", detail: `friction ${frictionText(c.friction!)} — categorized not-a-problem` });
      continue;
    }
    const type = c.type;
    const v = verify(c, type, { screens, onRoute, friction, steps, probes, probesKnown: request.probes !== undefined, facts: request.facts });
    if (v.status !== "verified") {
      records.push({ ...base, type, status: v.status, reason: v.reason });
      if (v.status === "unverifiable") {
        skipped.push({ rubricItemId: `claim:${type}`, screenId: c.screen.raw.screenId, reason: `cannot verify ${type}${base.target === undefined ? "" : ` on ${base.target}`}: ${v.reason}` });
      } else if (c.source === "friction") {
        // The friction is real; Jev's explanation of it failed code's check — counted, not shown.
        suppressed.push({ rubricItemId: CLAIM_RUBRIC[type], route: c.screen.route, screenId: c.screen.raw.screenId, reason: "unverified", detail: `${type} claim on friction ${c.friction!.id} refuted by code: ${v.reason}` });
      }
      continue;
    }
    const target = c.target ?? v.implicated;
    const key = `${type}|${c.screen.route}|${target === undefined ? "" : controlKey(target)}|${c.conflict === undefined ? "" : `${c.conflict.kind}:${c.conflict.found}`}|${type === "next-step-unclear" ? (v.template ?? "") : ""}`;
    const existing = draftByKey.get(key);
    if (existing !== undefined) {
      existing.occurrences++;
      existing.screenIds.add(c.screen.raw.screenId);
      records.push({ ...base, type, status: "merged", reason: `same ${type} on the same route and target as an earlier claim` });
      continue;
    }
    records.push({ ...base, type, status: "verified", reason: v.reason });
    const d: Draft = { key, type, source: c.source, screen: c.screen, ...(target === undefined ? {} : { target }), verdict: v, ...(c.friction === undefined ? {} : { friction: c.friction }), occurrences: 1, screenIds: new Set([c.screen.raw.screenId]) };
    drafts.push(d);
    draftByKey.set(key, d);
  }
  drafts.sort((a, b) => a.screen.route.localeCompare(b.screen.route) || a.type.localeCompare(b.type) || a.key.localeCompare(b.key));

  // Template prose (code) for each verified draft.
  const persona = request.appContext.persona ?? "first-time user";
  const prose = drafts.map((d) => {
    const t = prompts.templates[d.verdict.template ?? (d.type as TemplateKey)];
    const subject = d.target === undefined ? "the page" : label(d.target);
    const vars: Record<string, string> = {
      route: d.screen.route,
      persona,
      subject,
      ...(d.target === undefined ? {} : { control: label(d.target) }),
      controlHint: d.target === undefined ? "" : ` (for example ${label(d.target)})`,
      ...(d.verdict.vars ?? {}),
    };
    return { observation: fillClaimTemplate(t.observation, vars), userImpact: fillClaimTemplate(t.userImpact, vars), recommendation: fillClaimTemplate(t.recommendation, vars) };
  });

  // Jev duplicates + two-question grade: ONE batched request per screen.
  const feature = (d: Draft): string => journeysFor(request.facts, d.screen.route)[0] ?? request.appContext.job ?? d.screen.raw.job ?? "the task under review";
  const mergedInto = new Map<number, number>();
  const grades = new Map<number, { need: number; ship: number }>();
  const indexOf = new Map(drafts.map((d, i) => [d, i]));
  for (const [screenId, group] of groupBy(drafts, (d) => d.screen.raw.screenId)) {
    if (calls >= request.judgmentBudget) {
      budgetTruncated.add(screenId);
      continue;
    }
    const questions: Record<string, Question> = {};
    const dupOptions = new Map<number, number[]>();
    for (const d of group) {
      const i = indexOf.get(d)!;
      const finding = describeDraft(d, prose[i]!);
      questions[`grade::${i}::need`] = { kind: "noul", instructions: prompts.grade.need.replace("{finding}", finding).replace("{persona}", persona) };
      questions[`grade::${i}::ship`] = { kind: "noul", instructions: prompts.grade.ship.replace("{finding}", finding).replace("{feature}", feature(d)) };
      // Earlier findings this one could duplicate: same control (any type), or same type on the same route.
      const earlier = drafts
        .slice(0, i)
        .map((e, j) => ({ e, j }))
        .filter(({ e }) => (d.target !== undefined && e.target !== undefined && controlKey(d.target) === controlKey(e.target) && e.screen.route === d.screen.route) || (e.type === d.type && e.screen.route === d.screen.route))
        .map(({ j }) => j)
        .slice(0, MAX_CHOICE_OPTIONS - 1);
      if (earlier.length > 0) {
        dupOptions.set(i, earlier);
        questions[`dup::${i}`] = {
          kind: "choice",
          options: ["new", ...earlier.map((j) => `same:${j}`)],
          descriptions: Object.fromEntries([["new", "a different problem"], ...earlier.map((j) => [`same:${j}`, describeDraft(drafts[j]!, prose[j]!)])]),
          instructions: prompts.duplicate.replace("{finding}", finding),
        };
      }
    }
    let answers: Record<string, Answer>;
    try {
      answers = await deps.judge.systemOne({ state: buildState(group[0]!.screen.red), questions });
    } catch (cause) {
      return { kind: "failed", reason: `claim grading failed: ${message(cause)}`, screenId };
    }
    calls++;
    try {
      for (const d of group) {
        const i = indexOf.get(d)!;
        grades.set(i, { need: noulP(answers[`grade::${i}::need`], `grade::${i}::need`), ship: noulP(answers[`grade::${i}::ship`], `grade::${i}::ship`) });
        const opts = dupOptions.get(i);
        if (opts === undefined) continue;
        const a = answers[`dup::${i}`];
        if (!a || a.kind !== "choice" || !(a.value === "new" || opts.some((j) => a.value === `same:${j}`))) throw new Error(`claim duplicate check returned no valid choice for 'dup::${i}'`);
        if (a.value !== "new") mergedInto.set(i, Number(a.value.slice("same:".length)));
      }
    } catch (cause) {
      return { kind: "failed", reason: message(cause), screenId };
    }
  }

  // Build findings (merges resolved to their root, in index order).
  const root = (i: number): number => {
    let r = i;
    const seen = new Set<number>();
    while (mergedInto.has(r) && !seen.has(r)) {
      seen.add(r);
      r = mergedInto.get(r)!;
    }
    return r;
  };
  const built = new Map<number, UxFinding>();
  const contributions = new Map<number, ContributingFinding[]>();
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    const p = prose[i]!;
    const grade = grades.get(i);
    const quality = grade === undefined ? undefined : gradeLabel(grade.need, grade.ship, prompts.cutoffs);
    const v = d.verdict;
    const rubricItemId = CLAIM_RUBRIC[d.type];
    const impact = d.friction?.impact ?? v.impact ?? "confused";
    const severity = v.severity ?? (d.friction === undefined ? "minor" : IMPACT_SEVERITY[d.friction.impact]);
    const evidenceRefs = d.target !== undefined ? [{ id: `control:${d.target.index}` }] : (v.quotes ?? []).length > 0 ? [{ id: "visibleText" }] : [{ id: "url" }];
    let finding: UxFinding;
    try {
      finding = makeFinding(
        {
          rubricItemId,
          evidenceRefs,
          severity,
          confidence: v.strength ?? 0.7,
          observation: p.observation,
          userImpact: p.userImpact,
          recommendation: p.recommendation,
          tier: "behavioral",
          route: d.screen.route,
          controls: d.target === undefined ? [] : [label(d.target)],
          quotes: [...(v.quotes ?? [])],
          occurrences: d.occurrences,
          screenIds: [...d.screenIds],
          ...(quality === undefined ? {} : { quality }),
        },
        request.rubric,
        { screenId: d.screen.raw.screenId, refs: d.screen.red.refs },
      );
      if (deps.polish === true) {
        if (deps.gen === undefined) throw new Error("polish requested without a generation gateway");
        const polished = await recommend(deps.gen, finding, d.screen.red, secrets);
        finding = Object.freeze({ ...finding, recommendation: polished });
      }
    } catch (cause) {
      return { kind: "failed", reason: `claim finding failed: ${message(cause)}`, screenId: d.screen.raw.screenId, rubricItemId };
    }
    const claim: FindingClaim = {
      type: d.type,
      source: d.source,
      verifiedBy: v.verifiedBy ?? d.source,
      verification: v.reason,
      ...(d.target === undefined ? {} : { target: label(d.target) }),
    };
    built.set(
      i,
      Object.freeze({
        ...finding,
        claim,
        impact,
        ...(grade === undefined ? {} : { grade }),
        ...(d.friction === undefined ? {} : { journeyEvidence: { id: d.friction.id, kind: d.friction.kind, steps: d.friction.steps, detail: d.friction.detail } }),
      }),
    );
    const r = root(i);
    if (r !== i) {
      const list = contributions.get(r) ?? [];
      list.push({ rubricItemId, observation: finding.observation, confidence: finding.confidence, occurrences: finding.occurrences, citation: finding.citation, ...(finding.quality ? { quality: finding.quality } : {}) });
      contributions.set(r, list);
    }
  }
  const findings: UxFinding[] = [];
  for (let i = 0; i < drafts.length; i++) {
    if (root(i) !== i) continue;
    const f = built.get(i)!;
    const extra = contributions.get(i);
    findings.push(extra === undefined ? f : Object.freeze({ ...f, contributing: [...(f.contributing ?? []), ...extra] }));
  }
  // Jev-merged drafts are recorded as merged (they live on as `contributing`).
  for (const [i] of mergedInto) {
    const d = drafts[i]!;
    const at = records.findIndex((r) => r.status === "verified" && r.type === d.type && r.screenId === d.screen.raw.screenId && r.route === d.screen.route && (d.target === undefined || r.target === label(d.target)));
    if (at !== -1) records[at] = { ...records[at]!, status: "merged", reason: `${records[at]!.reason}; Jev judged it the same problem as an earlier finding` };
  }

  // Objective a11y tier — deterministic, no model.
  const a11yEntries = [...request.rubric.values()].filter((e) => e.tier === "objective-a11y");
  const a11yFound: { finding: UxFinding; refs: ReadonlySet<string> }[] = [];
  let a11yTotal = 0;
  let a11yEvaluated = 0;
  if (deps.a11yChecker !== undefined && a11yEntries.length > 0) {
    for (const s of screens) {
      a11yTotal += a11yEntries.length;
      const ok = a11yEntries.filter((e) => e.requiredEvidence.every((k) => present(s.raw, k)));
      for (const e of a11yEntries.filter((x) => !ok.includes(x))) skipped.push({ rubricItemId: e.id, screenId: s.raw.screenId, reason: "missing required evidence" });
      if (ok.length === 0) continue;
      a11yEvaluated += ok.length;
      for (const finding of deps.a11yChecker(s.red, request.rubric).findings) a11yFound.push({ finding, refs: s.red.refs });
    }
  }

  const ledger = summarizeLedger(records);
  const coverage: Coverage = {
    totalItems: ledger.candidates + a11yTotal,
    evaluated: ledger.verified + ledger.merged + ledger.refuted + ledger.dismissed + a11yEvaluated,
    skipped,
    budgetTruncated: [...budgetTruncated],
  };
  const claimOccurrences = findings.reduce((n, f) => n + f.occurrences + (f.contributing ?? []).reduce((m, c) => m + (c.occurrences ?? 1), 0), 0);
  return {
    kind: "analyzed",
    findings: [...findings, ...dedupeObjectiveFindings(a11yFound, request.rubric)],
    coverage,
    suppressed,
    rawOccurrences: claimOccurrences + suppressed.length + a11yFound.length,
    claims: ledger,
  };
}

function present(e: UxEvidence, key: string): boolean {
  switch (key) {
    case "controls":
      return e.controls.length > 0;
    case "visibleText":
      return e.visibleText.trim().length > 0;
    case "a11yFacts":
      return e.a11yFacts.controls.length > 0;
    default:
      return true;
  }
}

export function summarizeLedger(items: readonly ClaimRecord[]): ClaimLedger {
  const n = (s: ClaimStatus): number => items.filter((i) => i.status === s).length;
  return {
    candidates: items.length,
    verified: n("verified"),
    merged: n("merged"),
    refuted: n("refuted"),
    unverifiable: n("unverifiable"),
    dismissed: n("dismissed"),
    budgetTruncated: n("budget-truncated"),
    items,
  };
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k) ?? [];
    list.push(it);
    m.set(k, list);
  }
  return [...m.entries()];
}

interface VerifyContext {
  readonly screens: readonly Screen[];
  readonly onRoute: (route: string) => Screen[];
  readonly friction: readonly FrictionPoint[];
  readonly steps: readonly SignalStep[];
  readonly probes: readonly GuardProbe[];
  /** Were guard probes run at all (an empty list = no destructive control was found)? */
  readonly probesKnown: boolean;
  readonly facts?: ProductFacts;
}

/** Code's check of one claim — the only thing that decides whether it becomes a finding. */
function verify(c: Candidate, type: ClaimType, ctx: VerifyContext): Verdict {
  const route = c.screen.route;
  switch (type) {
    case "destructive-unguarded": {
      const probe = c.probe ?? (c.target === undefined ? undefined : ctx.probes.find((p) => p.route === route && p.controlKey === controlKey(c.target!)));
      if (probe === undefined) {
        if (c.target === undefined) return { status: "refuted", reason: "no target control named" };
        // The live run probes EVERY control the safety policy calls destructive; with that registry
        // present, a control it never probed is not destructive. Without it (offline, no sidecar),
        // the claim cannot be checked.
        return ctx.probesKnown
          ? { status: "refuted", reason: `not a destructive control: ${label(c.target)} is not in the safety policy's destructive vocabulary, so it was never probed` }
          : { status: "unverifiable", reason: "no guard probes for this run (a live usability run probes each destructive control with writes blocked)" };
      }
      if (probe.status !== "probed") return { status: "unverifiable", reason: `guard probe ${probe.status}: ${probe.detail}` };
      if (probe.guard !== undefined && probe.guard !== "none") return { status: "refuted", reason: `guarded: clicking it opened a ${probe.guard === "navigation" ? "confirmation page" : probe.guard === "native-dialog" ? "confirm dialog" : "dialog"} first` };
      const writes = probe.blockedWrites ?? [];
      if (writes.length === 0) return { status: "refuted", reason: "clicking it sent no write request (nothing irreversible was attempted)" };
      return {
        status: "verified",
        verifiedBy: "guard-probe",
        reason: `clicking it attempted ${writes.join(", ")} with no dialog or confirmation step (the probe blocked the write)`,
        strength: 0.9,
        severity: "major",
        impact: "confused",
        vars: { requests: writes.slice(0, 3).join(", ") },
        ...(c.target === undefined ? {} : { implicated: c.target }),
      };
    }
    case "fact-conflict": {
      const k = c.conflict;
      if (k === undefined) return { status: "refuted", reason: "no conflicting fact" };
      if (!normalizeText(c.screen.red.visibleText).includes(normalizeText(k.quote))) return { status: "refuted", reason: "the quoted text is not on the screen" };
      return {
        status: "verified",
        verifiedBy: "product-facts",
        reason: `the screen shows ${k.found}${k.plan === undefined ? "" : ` for ${k.plan}`}; the product facts list ${k.expected}`,
        strength: 0.95,
        severity: "major",
        impact: "confused",
        template: k.kind === "price" ? "fact-conflict.price" : "fact-conflict.trial",
        vars: { found: k.found, expected: k.expected, quote: k.quote.slice(0, 160), plan: k.plan ?? "the plan" },
        quotes: [k.quote],
      };
    }
    case "next-step-unclear": {
      const page = factsPageFor(ctx.facts, route);
      const screens = ctx.onRoute(route);
      const frictionHere = ctx.friction.filter((p) => p.routes.includes(route) && NAV_FRICTION.has(p.kind));
      if (page === undefined) {
        // From friction alone (no product facts for this page): the friction must be navigational.
        if (c.friction === undefined || !NAV_FRICTION.has(c.friction.kind)) return { status: "refuted", reason: "no navigational friction (backtrack, abandoned step, dead end, unfinished job) and no intended next step in the product facts" };
        return { status: "verified", verifiedBy: `friction:${c.friction.id}`, reason: `observed ${c.friction.kind}: ${c.friction.detail}`, strength: 0.6, template: "next-step-unclear.observed", vars: { detail: c.friction.detail } };
      }
      const step = page.nextStep;
      const matches = screens.flatMap((s) => s.red.controls.filter((x) => namesStep(x.name, step)));
      if (matches.length === 0) {
        return { status: "verified", verifiedBy: "product-facts", reason: `no control on ${route} names the intended next step "${step}"`, strength: 0.85, severity: "major", impact: "slowed", template: "next-step-unclear.absent", vars: { nextStep: step } };
      }
      if (matches.every((x) => !x.enabled)) {
        return { status: "verified", verifiedBy: "product-facts", reason: `the intended next step "${step}" is disabled on every screen of ${route}`, strength: 0.85, severity: "major", impact: "slowed", template: "next-step-unclear.disabled", vars: { nextStep: step }, implicated: matches[0]! };
      }
      const acted = ctx.steps.some((s) => s.actOk && matches.some((x) => stepNames(s, x)));
      if (frictionHere.length > 0 && !acted) {
        const p = frictionHere[0]!;
        return {
          status: "verified",
          verifiedBy: `friction:${p.id}`,
          reason: `"${step}" is on the page, but the run never took it and hit ${p.kind} there`,
          strength: 0.7,
          template: "next-step-unclear.friction",
          vars: { nextStep: step, detail: p.detail },
        };
      }
      return { status: "refuted", reason: `the intended next step "${step}" is on the page and enabled${acted ? ", and the run took it" : ", with no navigational friction observed there"}` };
    }
    case "no-feedback":
    case "blocked-action":
    case "error-unrecoverable": {
      const p = c.friction;
      if (p === undefined) return { status: "refuted", reason: "no observed friction" };
      const kinds: Record<typeof type, readonly string[]> = { "no-feedback": ["retry", "long-wait"], "blocked-action": ["dead-end"], "error-unrecoverable": ["error"] };
      if (!kinds[type].includes(p.kind)) return { status: "refuted", reason: `a ${type} claim needs ${kinds[type].join(" or ")} friction; observed ${p.kind}` };
      if (c.target !== undefined) {
        const acted = ctx.steps.filter((s) => p.steps.includes(s.step));
        const named = acted.some((s) => stepNames(s, c.target!));
        const blockedHere = type === "blocked-action" && !c.target.enabled;
        if (!named && !blockedHere && type !== "error-unrecoverable") {
          return { status: "refuted", reason: `the friction's steps (${p.steps.join(", ")}) did not act on ${label(c.target)}` };
        }
      }
      return {
        status: "verified",
        verifiedBy: `friction:${p.id}`,
        reason: `observed ${p.kind} at steps ${p.steps.join(", ")}: ${p.detail}`,
        strength: 0.7 + 0.05 * Math.min(2, IMPACT_RANK[p.impact] - 1),
        vars: { detail: p.detail },
      };
    }
  }
}

/**
 * #198: what the claim pipeline's numbers are NOT yet backed by. Code verification is real; Jev's
 * categorization (claim type, target control, duplicate) and the two-question grade cutoffs are
 * tuned on deterministic edge-case fixtures only — a real-model calibration pass is pending.
 */
export function claimsCaveat(prompts: ClaimPrompts = CLAIM_PROMPTS): string {
  return `claims (${prompts.version}): every shown claim was verified by code, but Jev's friction categorization and the two-question grade cutoffs (need ≥ ${prompts.cutoffs.need}, ship ≥ ${prompts.cutoffs.ship}, wrong ≤ ${prompts.cutoffs.wrong}) are tuned on deterministic fixtures only — real-model calibration pending (#198)`;
}
