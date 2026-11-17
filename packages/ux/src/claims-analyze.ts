// claims-analyze.ts — the extracted phases of the claim pipeline (claims.ts `analyzeClaims`).
//
// Each helper owns exactly one phase: redact the screens, collect the candidates (guard probes,
// product facts, friction), categorize friction with Jev, verify every candidate by code, template
// the prose, grade and de-duplicate with Jev, build the findings, and collect the objective a11y
// tier. `analyzeClaims` (claims.ts) is the orchestrator that calls them in order; this module never
// imports claims.ts.
import { MAX_CHOICE_OPTIONS, type Answer, type GenerationPort, type JudgmentPort, type Question } from "@jevitate/ai-core";
import { controlKey, normalizeText } from "./adjudicate.js";
import { CLAIM_PROMPTS, FRICTION_CLAIM_CHOICES, fillClaimTemplate, type ClaimPrompts, type ClaimType, type FrictionClaimChoice, type TemplateKey } from "./claim-prompts.js";
import type { A11yChecker } from "./analyzer.js";
import { makeFinding } from "./finding.js";
import { IMPACT_RANK, type FrictionPoint } from "./friction.js";
import { buildState } from "./judge.js";
import { factsPageFor, findFactConflicts, journeysFor, namesStep, type FactConflict, type ProductFacts } from "./product-facts.js";
import type { QualityLabel } from "./prompts.js";
import { recommend } from "./recommend.js";
import { redactEvidence, type RedactedControl, type RedactedEvidence, type Redactor } from "./redact.js";
import { routeOf } from "./route.js";
import type { SignalStep } from "./signals.js";
import type { AnalysisOutcome, ContributingFinding, JobImpact, RubricEntry, SkippedItem, SuppressedItem, UxEvidence, UxFinding } from "./types.js";

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
  /**
   * `probed`, or why it was not: `skipped` (probing is opt-in, `--probe-guards`), not found again on
   * a fresh load, `refused` (`--deny`, or a channel the probe cannot block: an open WebSocket /
   * EventSource, a controlling service worker), or the probe failed. Every non-`probed` status makes
   * the guard claim unverifiable — reported in coverage, never asserted.
   */
  readonly status: "probed" | "skipped" | "not-found" | "refused" | "failed";
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

export interface Screen {
  readonly raw: UxEvidence;
  readonly red: RedactedEvidence;
  readonly route: string;
}

export interface Candidate {
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

export interface Verdict {
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

export interface Draft {
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

export interface VerifyContext {
  readonly screens: readonly Screen[];
  readonly onRoute: (route: string) => Screen[];
  readonly friction: readonly FrictionPoint[];
  readonly steps: readonly SignalStep[];
  readonly probes: readonly GuardProbe[];
  /** Were guard probes run at all (an empty list = no destructive control was found)? */
  readonly probesKnown: boolean;
  readonly facts?: ProductFacts;
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

/** Code's check of one claim — the only thing that decides whether it becomes a finding. */
export function verify(c: Candidate, type: ClaimType, ctx: VerifyContext): Verdict {
  switch (type) {
    case "destructive-unguarded":
      return verifyDestructive(c, ctx);
    case "fact-conflict":
      return verifyFactConflict(c);
    case "next-step-unclear":
      return verifyNextStep(c, ctx);
    case "no-feedback":
    case "blocked-action":
    case "error-unrecoverable":
      return verifyFriction(c, type, ctx);
  }
}

function verifyDestructive(c: Candidate, ctx: VerifyContext): Verdict {
  const route = c.screen.route;
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
  if (probe.status !== "probed") return { status: "unverifiable", reason: probe.status === "skipped" ? probe.detail : `guard probe ${probe.status}: ${probe.detail}` };
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

function verifyFactConflict(c: Candidate): Verdict {
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

function verifyNextStep(c: Candidate, ctx: VerifyContext): Verdict {
  const route = c.screen.route;
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

function verifyFriction(c: Candidate, type: "no-feedback" | "blocked-action" | "error-unrecoverable", ctx: VerifyContext): Verdict {
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

// ---------- phases (called by claims.ts `analyzeClaims`, in this order) ----------

/** A phase that can end `analyzeClaims` early returns the failed outcome for the orchestrator to return. */
export type PhaseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly outcome: AnalysisOutcome };

/** Phase 1 — the redaction door: every screen, before anything reaches a model. */
export function redactScreens(request: ClaimAnalysisRequest, deps: ClaimAnalyzerDeps): PhaseResult<Screen[]> {
  const secrets = request.secrets ?? [];
  const screens: Screen[] = [];
  for (const raw of request.screens) {
    try {
      const red = redactEvidence(raw, secrets, deps.redactor);
      screens.push({ raw, red, route: routeOf(red.url) });
    } catch (cause) {
      return { ok: false, outcome: { kind: "failed", reason: `redaction failed: ${message(cause)}`, screenId: raw.screenId } };
    }
  }
  return { ok: true, value: screens };
}

/** Phase 2 — gather the candidates: guard probes, product facts, and un-explained friction. */
export function collectCandidates(request: ClaimAnalysisRequest, screens: readonly Screen[], onRoute: (route: string) => Screen[]): { candidates: Candidate[]; records: ClaimRecord[] } {
  const byId = new Map(screens.map((s) => [s.raw.screenId, s]));
  const probes = request.probes ?? [];
  const friction = request.friction ?? [];
  const records: ClaimRecord[] = [];
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
  return { candidates, records };
}

/** Phase 3 — Jev categorization: ONE batched request per screen with friction candidates. */
export async function classifyFrictionCandidates(
  candidates: readonly Candidate[],
  request: ClaimAnalysisRequest,
  deps: ClaimAnalyzerDeps,
  prompts: ClaimPrompts,
  steps: readonly SignalStep[],
  callsStart: number,
): Promise<PhaseResult<{ calls: number; budgetTruncated: readonly string[] }>> {
  const budgetTruncated: string[] = [];
  let calls = callsStart;
  const toClassify = candidates.filter((c) => c.source === "friction");
  for (const [screenId, group] of groupBy(toClassify, (c) => c.screen.raw.screenId)) {
    if (calls >= request.judgmentBudget) {
      budgetTruncated.push(screenId);
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
      return { ok: false, outcome: { kind: "failed", reason: `claim categorization failed: ${message(cause)}`, screenId } };
    }
    calls++;
    for (const c of group) {
      const t = answers[`claim::${c.id}::type`];
      if (!t || t.kind !== "choice" || !(FRICTION_CLAIM_CHOICES as readonly string[]).includes(t.value)) {
        return { ok: false, outcome: { kind: "failed", reason: `claim categorization returned no valid claim type for friction '${c.friction!.id}'`, screenId } };
      }
      c.type = t.value as FrictionClaimChoice;
      const g = answers[`claim::${c.id}::target`];
      const allowed = options.get(c.id) ?? [];
      if (!g || g.kind !== "choice" || (g.value !== NONE_TARGET && !allowed.some((x) => `control:${x.index}` === g.value))) {
        return { ok: false, outcome: { kind: "failed", reason: `claim categorization returned no valid target for friction '${c.friction!.id}'`, screenId } };
      }
      if (g.value !== NONE_TARGET) c.target = allowed.find((x) => `control:${x.index}` === g.value);
    }
  }
  return { ok: true, value: { calls, budgetTruncated } };
}

/** Phase 4 — verification (code): every candidate becomes a draft, is recorded refuted/unverifiable, or is dropped. */
export function verifyCandidates(
  candidates: readonly Candidate[],
  request: ClaimAnalysisRequest,
  screens: readonly Screen[],
  onRoute: (route: string) => Screen[],
): { drafts: Draft[]; records: ClaimRecord[]; skipped: SkippedItem[]; suppressed: SuppressedItem[] } {
  const friction = request.friction ?? [];
  const steps = request.steps ?? [];
  const probes = request.probes ?? [];
  const records: ClaimRecord[] = [];
  const suppressed: SuppressedItem[] = [];
  const skipped: SkippedItem[] = [];
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
  return { drafts, records, skipped, suppressed };
}

export interface TemplateProse {
  readonly observation: string;
  readonly userImpact: string;
  readonly recommendation: string;
}

/** Phase 5 — template prose (code) for each verified draft. */
export function buildTemplateProse(drafts: readonly Draft[], request: ClaimAnalysisRequest, prompts: ClaimPrompts): { persona: string; prose: TemplateProse[] } {
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
  return { persona, prose };
}

function featureOf(d: Draft, request: ClaimAnalysisRequest): string {
  return journeysFor(request.facts, d.screen.route)[0] ?? request.appContext.job ?? d.screen.raw.job ?? "the task under review";
}

/** Phase 6a — one screen's grade/duplicate questions (and the earlier-draft options). */
export function buildGradingQuestions(
  group: readonly Draft[],
  drafts: readonly Draft[],
  prose: readonly TemplateProse[],
  prompts: ClaimPrompts,
  request: ClaimAnalysisRequest,
  persona: string,
  indexOf: ReadonlyMap<Draft, number>,
): { questions: Record<string, Question>; dupOptions: Map<number, number[]> } {
  const questions: Record<string, Question> = {};
  const dupOptions = new Map<number, number[]>();
  for (const d of group) {
    const i = indexOf.get(d)!;
    const finding = describeDraft(d, prose[i]!);
    questions[`grade::${i}::need`] = { kind: "noul", instructions: prompts.grade.need.replace("{finding}", finding).replace("{persona}", persona) };
    questions[`grade::${i}::ship`] = { kind: "noul", instructions: prompts.grade.ship.replace("{finding}", finding).replace("{feature}", featureOf(d, request)) };
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
  return { questions, dupOptions };
}

/** Phase 6b — parse one screen's answers into grades and duplicate merges (throws on an invalid answer). */
export function applyGradeAnswers(
  group: readonly Draft[],
  answers: Record<string, Answer>,
  dupOptions: ReadonlyMap<number, readonly number[]>,
  indexOf: ReadonlyMap<Draft, number>,
  grades: Map<number, { need: number; ship: number }>,
  mergedInto: Map<number, number>,
): void {
  for (const d of group) {
    const i = indexOf.get(d)!;
    grades.set(i, { need: noulP(answers[`grade::${i}::need`], `grade::${i}::need`), ship: noulP(answers[`grade::${i}::ship`], `grade::${i}::ship`) });
    const opts = dupOptions.get(i);
    if (opts === undefined) continue;
    const a = answers[`dup::${i}`];
    if (!a || a.kind !== "choice" || !(a.value === "new" || opts.some((j) => a.value === `same:${j}`))) throw new Error(`claim duplicate check returned no valid choice for 'dup::${i}'`);
    if (a.value !== "new") mergedInto.set(i, Number(a.value.slice("same:".length)));
  }
}

export interface GradeResult {
  readonly calls: number;
  readonly grades: Map<number, { need: number; ship: number }>;
  readonly mergedInto: Map<number, number>;
  readonly budgetTruncated: readonly string[];
}

/** Phase 6 — Jev duplicates + two-question grade: ONE batched request per screen. */
export async function gradeDrafts(
  drafts: readonly Draft[],
  request: ClaimAnalysisRequest,
  deps: ClaimAnalyzerDeps,
  prompts: ClaimPrompts,
  prose: readonly TemplateProse[],
  persona: string,
  callsStart: number,
): Promise<PhaseResult<GradeResult>> {
  const grades = new Map<number, { need: number; ship: number }>();
  const mergedInto = new Map<number, number>();
  const budgetTruncated: string[] = [];
  const indexOf = new Map(drafts.map((d, i) => [d, i]));
  let calls = callsStart;
  for (const [screenId, group] of groupBy(drafts, (d) => d.screen.raw.screenId)) {
    if (calls >= request.judgmentBudget) {
      budgetTruncated.push(screenId);
      continue;
    }
    const { questions, dupOptions } = buildGradingQuestions(group, drafts, prose, prompts, request, persona, indexOf);
    let answers: Record<string, Answer>;
    try {
      answers = await deps.judge.systemOne({ state: buildState(group[0]!.screen.red), questions });
    } catch (cause) {
      return { ok: false, outcome: { kind: "failed", reason: `claim grading failed: ${message(cause)}`, screenId } };
    }
    calls++;
    try {
      applyGradeAnswers(group, answers, dupOptions, indexOf, grades, mergedInto);
    } catch (cause) {
      return { ok: false, outcome: { kind: "failed", reason: message(cause), screenId } };
    }
  }
  return { ok: true, value: { calls, grades, mergedInto, budgetTruncated } };
}

export interface BuildFindingsInput {
  readonly drafts: readonly Draft[];
  readonly prose: readonly TemplateProse[];
  readonly grades: ReadonlyMap<number, { need: number; ship: number }>;
  readonly mergedInto: ReadonlyMap<number, number>;
  readonly request: ClaimAnalysisRequest;
  readonly deps: ClaimAnalyzerDeps;
  readonly prompts: ClaimPrompts;
}

/** Mark the records of drafts Jev judged the same problem as an earlier finding. */
function markJevMergedRecords(mergedInto: ReadonlyMap<number, number>, drafts: readonly Draft[], records: ClaimRecord[]): void {
  for (const [i] of mergedInto) {
    const d = drafts[i]!;
    const at = records.findIndex((r) => r.status === "verified" && r.type === d.type && r.screenId === d.screen.raw.screenId && r.route === d.screen.route && (d.target === undefined || r.target === label(d.target)));
    if (at !== -1) records[at] = { ...records[at]!, status: "merged", reason: `${records[at]!.reason}; Jev judged it the same problem as an earlier finding` };
  }
}

/** Phase 7 — build the findings (merges resolved to their root, in index order) and mark Jev-merged records. */
export async function buildClaimFindings(input: BuildFindingsInput, records: ClaimRecord[]): Promise<PhaseResult<UxFinding[]>> {
  const { drafts, prose, grades, mergedInto, request, deps, prompts } = input;
  const secrets = request.secrets ?? [];
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
      return { ok: false, outcome: { kind: "failed", reason: `claim finding failed: ${message(cause)}`, screenId: d.screen.raw.screenId, rubricItemId } };
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
  markJevMergedRecords(mergedInto, drafts, records);
  return { ok: true, value: findings };
}

export interface A11yPhase {
  readonly found: { finding: UxFinding; refs: ReadonlySet<string> }[];
  readonly total: number;
  readonly evaluated: number;
  readonly skipped: SkippedItem[];
}

/** Phase 8 — the objective a11y tier (deterministic, no model). */
export function collectA11yFindings(request: ClaimAnalysisRequest, deps: ClaimAnalyzerDeps, screens: readonly Screen[]): A11yPhase {
  const a11yEntries = [...request.rubric.values()].filter((e) => e.tier === "objective-a11y");
  const found: { finding: UxFinding; refs: ReadonlySet<string> }[] = [];
  const skipped: SkippedItem[] = [];
  let total = 0;
  let evaluated = 0;
  if (deps.a11yChecker !== undefined && a11yEntries.length > 0) {
    for (const s of screens) {
      total += a11yEntries.length;
      const ok = a11yEntries.filter((e) => e.requiredEvidence.every((k) => present(s.raw, k)));
      for (const e of a11yEntries.filter((x) => !ok.includes(x))) skipped.push({ rubricItemId: e.id, screenId: s.raw.screenId, reason: "missing required evidence" });
      if (ok.length === 0) continue;
      evaluated += ok.length;
      for (const finding of deps.a11yChecker(s.red, request.rubric).findings) found.push({ finding, refs: s.red.refs });
    }
  }
  return { found, total, evaluated, skipped };
}
