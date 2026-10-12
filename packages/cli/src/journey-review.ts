import { contentHash } from "@jevitate/domain";
import type { JourneyProposal, JourneyReviewProposal } from "@jevitate/journey";
import {
  SECRET_PARAM_NAME_RE,
  describeStep,
  flatJourneySteps,
  isNoClaimExpect,
  isOwnTargetVisible,
  journeyAssertions,
  journeyEndState,
  journeyRunParams,
  journeyWriteSteps,
  lintJourney,
  secretParamNames,
  type Journey,
  type JourneyReview,
  type JourneyReviewChange,
  type JourneyReviewRiskyControl,
  type JourneyReviewStep,
  type JourneyReviewVerify,
  type JourneyReviewWriteRequest,
  type JourneyCatalogLinks,
  type Finding,
  type ApprovalProvenance,
  type AnchorLintIssue,
  type CatalogRefIssue,
  type JourneyReviewAnchorWarning,
  type JourneyReviewLocatorHealth,
  type JourneyReviewAttention,
} from "@jevitate/journey";
import type { LocatorHealthDetail } from "./locator-health.js";
import { SafetyPolicy, describeCheck, explainCheck, type SafetyConfig } from "@jevitate/explore";
import { navigateUrlParams, writeClassifier, type Step, type TargetDescriptor, type ValueOrVar } from "@jevitate/recording";
import {
  createSheetWriter,
  finishSheet,
  plural,
  renderApprove,
  renderAttention,
  renderClear,
  renderFullDetail,
  renderHeader,
  renderInputs,
  renderProposal,
  renderProvesAtTheEnd,
  renderSteps,
  renderWhatItDoes,
  renderWrites,
  stepRanges,
  type Style,
} from "./journey-review/render.js";

export { humanTime, stepRanges } from "./journey-review/render.js";

/**
 * #432 — `jevitate journey review <id>`: one human-readable review sheet for promotion sign-off.
 * `buildJourneyReview` is PURE (no I/O, no clock): the CLI loads what it needs (the targets.json
 * safety config, the approved snapshot, the last mutation-proof verdict) into the context.
 *
 * Secrets: the sheet is built from the Journey alone, which never carries a secret parameter's value
 * (values only arrive as `--param`). Defense in depth: a literal typed into a field whose name reads
 * as a credential is shown «redacted», and a secret reference is listed by field and manager only.
 */

/** The approval bookkeeping a review hash leaves out: promoting writes them, so they cannot be part of what was reviewed. */
const BOOKKEEPING = ["promoted", "approval", "acceptedWeak"] as const;

/**
 * #432: the content hash a review sheet shows and an approval binds to — `contentHash` (the same
 * function annotation drafts are bound with) of the Journey WITHOUT its approval bookkeeping
 * (`promoted`, `approval`, `acceptedWeak`), so promoting does not itself change what was approved.
 */
export function journeyReviewHash(journey: Journey): string {
  const metadata: Record<string, unknown> = { ...journey.metadata };
  for (const k of BOOKKEEPING) delete metadata[k];
  return contentHash({ metadata, recording: journey.recording });
}

/** #432: the last `journey verify --mutate` verdict, as recorded beside the Journey. */
export interface JourneyVerifyRecord {
  readonly journeyId: string;
  /** `journeyReviewHash` of the Journey the proof ran on. */
  readonly contentHash: string;
  readonly verdict: string;
  readonly reason?: string;
  readonly summary: Readonly<Record<string, number>>;
  readonly at: string;
}

export interface JourneyReviewContext {
  /** The site's safety config (targets.json `safety` for the Journey's origin): `deny` / `paid` / `allowControl`. */
  readonly safety?: Pick<SafetyConfig, "deny" | "paid" | "allowControl">;
  /** The Journey as last approved (`.approved/<id>.json`), or null when there is none. */
  readonly approvedSnapshot?: Journey | null;
  /** The last recorded mutation-proof verdict, or null when there is none. */
  readonly lastVerify?: JourneyVerifyRecord | null;
  /** #433: the Journey's catalog links and its pre-approval findings (the CLI loads the catalog). */
  readonly catalog?: { readonly links: JourneyCatalogLinks; readonly findings: readonly Finding[] };
  /** #453: the pending self-heal proposal, with whether it is stale and why it cannot be accepted. */
  readonly proposal?: { readonly proposal: JourneyProposal; readonly stale: boolean; readonly problem?: string };
  /** #466: the anchor-rule problems (`journeyAnchorIssues`), computed by the caller (journey-anchor-gate imports this file). */
  readonly anchorIssues?: { readonly anchorIssues: readonly AnchorLintIssue[]; readonly refIssues: readonly CatalogRefIssue[] };
  /** #470: the Journey's locator health (`journeyLocatorHealth`), advisory. */
  readonly locatorHealth?: LocatorHealthDetail;
  /** #467: the approval is stale and the only change is minted step ids (`isStepIdOnlyChange`), computed by the caller. */
  readonly stepIdOnly?: boolean;
}

function targetOf(step: Step): TargetDescriptor | undefined {
  if (step.kind === "forEach") return step.items;
  return "target" in step ? step.target : undefined;
}

function controlName(t: TargetDescriptor): string {
  return (t.name ?? t.label ?? t.text ?? "").replace(/\s+/g, " ").trim();
}

function reviewTarget(t: TargetDescriptor | undefined): JourneyReviewStep["target"] {
  if (t === undefined) return undefined;
  const name = controlName(t);
  const out = { ...(t.role === undefined ? {} : { role: t.role }), ...(name === "" ? {} : { name }) };
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Does the field read as a credential (its name, label or test id)? Its literal value is then never shown. */
function secretLooking(t: TargetDescriptor): boolean {
  return [t.name, t.label, t.testId, t.text, t.display?.name].some((s) => s !== undefined && SECRET_PARAM_NAME_RE.test(s));
}

function hideValue(v: ValueOrVar): ValueOrVar {
  return "var" in v || v.redacted ? v : { redacted: true, length: 0 };
}

/** The step with any credential-looking literal value hidden — what `describeStep` may show. */
function sanitized(step: Step): Step {
  if ((step.kind === "fill" || step.kind === "select") && secretLooking(step.target)) return { ...step, value: hideValue(step.value) };
  if (step.kind === "editText" && step.value !== undefined && secretLooking(step.target)) return { ...step, value: hideValue(step.value) };
  return step;
}

function varName(v: ValueOrVar | undefined): string[] {
  return v !== undefined && "var" in v ? [v.var] : [];
}

/** The parameters (by name) a step uses, its `forEach` children included. */
function paramsOf(step: Step): string[] {
  switch (step.kind) {
    case "navigate":
      return navigateUrlParams(step.url);
    case "fill":
    case "select":
      return varName(step.value);
    case "editText":
      return varName(step.value);
    case "upload":
      return varName(step.file);
    case "forEach":
      return step.steps.flatMap(paramsOf);
    default:
      return [];
  }
}

function ownAssertion(step: Step): string | undefined {
  if (step.kind === "assert") return describeCheck({ kind: "page", assertion: step.check });
  if (step.kind === "handback") return describeCheck({ kind: "page", assertion: step.resume });
  return "expect" in step ? describeCheck({ kind: "page", assertion: step.expect }) : undefined;
}

function evidenceLine(e: { kind: string; before?: string | undefined; after?: string | undefined; file?: string | undefined; line?: number | undefined }): string {
  const change = e.before !== undefined || e.after !== undefined ? ` '${e.before ?? ""}' → '${e.after ?? ""}'` : "";
  const where = e.file === undefined ? "" : ` (${e.file}${e.line === undefined ? "" : `:${e.line}`})`;
  return `${e.kind}${change}${where}`;
}

/** A target's exact locator, e.g. `data-testid=publish-now` or `role=button name="Save"`. */
function locatorSpec(t: TargetDescriptor): string {
  if (t.testId !== undefined) return `${t.testIdAttr ?? "data-testid"}=${t.testId}`;
  const parts = [
    t.role === undefined ? null : `role=${t.role}`,
    t.name === undefined ? null : `name="${t.name}"`,
    t.label === undefined ? null : `label="${t.label}"`,
    t.text === undefined ? null : `text="${t.text}"`,
    t.css === undefined ? null : `css=${t.css}`,
  ].filter((x): x is string => x !== null);
  return parts.join(" ");
}

/**
 * #497: a self-heal proposal changes a step's LOCATOR, which a recorded display label hides
 * (`click "Import"` before and after) — so a proposal's step shows its exact locator too.
 */
function withLocator(step: Step): string {
  const target = targetOf(step);
  const spec = target === undefined ? "" : locatorSpec(target);
  return spec === "" ? describeStep(sanitized(step)) : `${describeStep(sanitized(step))} · locator ${spec}`;
}

function buildProposal(ctx: NonNullable<JourneyReviewContext["proposal"]>, journeyId: string): JourneyReviewProposal {
  const p = ctx.proposal;
  return {
    proposalId: p.proposalId,
    baseHash: p.baseHash,
    proposedHash: p.proposedHash,
    createdAt: p.createdAt,
    stale: ctx.stale,
    ...(ctx.problem === undefined ? {} : { problem: ctx.problem }),
    changes: { ...(p.changes.range === undefined ? {} : { range: p.changes.range }), ...(p.changes.baseSha === undefined ? {} : { baseSha: p.changes.baseSha }), ...(p.changes.headSha === undefined ? {} : { headSha: p.changes.headSha }), notes: [...p.changes.notes] },
    steps: p.steps.map((s) => ({
      number: s.index + 1,
      before: withLocator(s.before),
      after: withLocator(s.after),
      hypothesis: s.justification.hypothesis + (s.justification.anchorNotInChange === true ? " (the new anchor is not named by any change evidence)" : ""),
      evidence: s.justification.evidence.map(evidenceLine),
      screenshots: [...(s.screenshots ?? [])],
    })),
    attempts: { total: p.attempts.length, rejected: p.attempts.filter((a) => a.result === "rejected").length },
    acceptCommand: `jevitate journey promote ${journeyId} --proposal ${p.proposalId} --reviewed-hash ${p.proposedHash}`,
  };
}

/**
 * 0.12.0 review M4: the short exact locator shown beside a step's recorded display label — the
 * test id when there is one, else role and name (else the full `locatorSpec`). A display label is
 * free text a shared Journey can set (`{testId: "delete-account", display: {name: "Cancel"}}`), so
 * the approver sees what the step really acts on. Undefined when the target has no display label.
 */
function displayedLocator(t: TargetDescriptor | undefined): string | undefined {
  if (t === undefined || t.display === undefined) return undefined;
  const short: TargetDescriptor =
    t.testId !== undefined
      ? { testId: t.testId, ...(t.testIdAttr === undefined ? {} : { testIdAttr: t.testIdAttr }) }
      : t.role !== undefined || t.name !== undefined
        ? { ...(t.role === undefined ? {} : { role: t.role }), ...(t.name === undefined ? {} : { name: t.name }) }
        : t;
  const spec = locatorSpec(short);
  return spec === "" ? undefined : spec;
}

function buildSteps(journey: Journey): JourneyReviewStep[] {
  return flatJourneySteps(journey).map(({ index, recorded }) => {
    const step = recorded.step;
    const target = reviewTarget(targetOf(step));
    const assertion = ownAssertion(step);
    const locator = displayedLocator(targetOf(step));
    return {
      number: index + 1,
      kind: step.kind,
      action: describeStep(sanitized(step)),
      ...(locator === undefined ? {} : { locator }),
      ...(target === undefined ? {} : { target }),
      ...(recorded.objective === undefined || recorded.objective.trim() === "" ? {} : { objective: recorded.objective }),
      ...(recorded.expectedResult === undefined || recorded.expectedResult.trim() === "" ? {} : { expectedResult: recorded.expectedResult }),
      ...(assertion === undefined ? {} : { assertion }),
      params: [...new Set(paramsOf(step))],
    };
  });
}

const REQUEST_LINE = /^(\S+)\s+(\S+)/;

function buildWriteRequests(journey: Journey): JourneyReviewWriteRequest[] {
  const classify = writeClassifier();
  const out: JourneyReviewWriteRequest[] = [];
  const seen = new Set<string>();
  const add = (w: JourneyReviewWriteRequest): void => {
    const key = `${w.source}|${w.step ?? ""}|${w.method.toUpperCase()}|${w.endpoint}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };
  for (const w of journeyWriteSteps(journey)) {
    for (const line of w.requests) {
      const m = REQUEST_LINE.exec(line.trim());
      if (m !== null) add({ method: m[1]!.toUpperCase(), endpoint: m[2]!, source: "recorded", step: w.step });
    }
  }
  flatJourneySteps(journey).forEach(({ index, recorded }) => {
    for (const check of recorded.expectRequests ?? []) {
      if (classify({ method: check.method, path: check.pathGlob })) add({ method: check.method.toUpperCase(), endpoint: check.pathGlob, source: "expect-request", step: index + 1 });
    }
  });
  for (const check of journeyEndState(journey)) {
    if (check.kind !== "requestMade" && check.kind !== "responseStatus") continue;
    if (classify({ method: check.method, path: check.pathGlob })) add({ method: check.method.toUpperCase(), endpoint: check.pathGlob, source: "end-state" });
  }
  return out;
}

/** Every click (a `forEach` child's too, under its parent's number) whose control a safety rule matches. */
function buildRiskyControls(journey: Journey, safety: JourneyReviewContext["safety"]): JourneyReviewRiskyControl[] {
  const policy = new SafetyPolicy({
    ...(safety?.deny === undefined ? {} : { deny: safety.deny }),
    ...(safety?.paid === undefined ? {} : { paid: safety.paid }),
    ...(safety?.allowControl === undefined ? {} : { allowControl: safety.allowControl }),
  });
  const out: JourneyReviewRiskyControl[] = [];
  const visit = (step: Step, number: number): void => {
    if (step.kind === "forEach") {
      for (const child of step.steps) visit(child, number);
      return;
    }
    if (step.kind !== "click") return;
    const name = controlName(step.target);
    // A nameless control cannot be matched against a name rule: the sheet lists only named ones.
    if (name === "") return;
    const control = { name, role: step.target.role ?? "", descriptor: step.target };
    const role = step.target.role === undefined ? {} : { role: step.target.role };
    const refused = policy.refuses(control);
    if (refused !== null) {
      out.push({ step: number, control: name, ...role, risk: refused.risk, ruleId: refused.refusal.ruleId });
      return;
    }
    const waiver = policy.waiver(control);
    if (waiver !== null) out.push({ step: number, control: name, ...role, risk: policy.riskOf(control) ?? "paid", ruleId: waiver.ruleId, waivedBy: waiver.regex });
  };
  for (const { index, recorded } of flatJourneySteps(journey)) visit(recorded.step, index + 1);
  return out;
}

function originOf(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

function buildOrigins(journey: Journey): string[] {
  const site = journey.recording.site;
  const origins = new Set<string>();
  const add = (url: string): void => {
    const o = originOf(url, site);
    if (o !== null) origins.add(o);
  };
  add(site);
  for (const page of journey.recording.pages) {
    add(page.url);
    for (const { step, delta } of page.steps) {
      if (step.kind === "navigate") add(step.url);
      for (const line of delta?.requests ?? []) {
        const m = REQUEST_LINE.exec(line.trim());
        if (m !== null && /^https?:\/\//i.test(m[2]!)) add(m[2]!);
      }
    }
  }
  return [...origins];
}

function buildChange(journey: Journey, hash: string, snapshot: Journey | null | undefined, stepIdOnly: boolean): JourneyReviewChange {
  const approval = journey.metadata.approval;
  const idOnly = stepIdOnly ? { stepIdOnly: true as const } : {};
  if (snapshot === null || snapshot === undefined) {
    if (approval !== undefined) {
      return { kind: "snapshot-missing", approvedHash: approval.contentHash, approvedAt: approval.at, changed: approval.contentHash !== hash, ...idOnly };
    }
    return journey.metadata.promoted ? { kind: "no-record" } : { kind: "first-approval" };
  }
  const approvedHash = journeyReviewHash(snapshot);
  const approvedAt = approval?.at ?? snapshot.metadata.approval?.at;
  return {
    kind: "diff",
    approvedHash,
    ...(approvedAt === undefined ? {} : { approvedAt }),
    changed: approvedHash !== hash,
    ...idOnly,
    steps: multisetDiff(stepLines(snapshot), stepLines(journey)),
    assertions: multisetDiff(assertionLines(snapshot), assertionLines(journey)),
    sideEffects: multisetDiff(sideEffectLines(snapshot), sideEffectLines(journey)),
  };
}

/** Step lines for a diff: the action and its check, without the number (an inserted step shifts every number). */
function stepLines(j: Journey): string[] {
  return buildSteps(j).map((s) => `${s.action}${s.assertion === undefined ? "" : ` — expect ${s.assertion}`}`);
}

function assertionLines(j: Journey): string[] {
  return [
    ...journeyEndState(j).map((c) => `end state: ${describeCheck(c)}`),
    ...journeyAssertions(j)
      .filter((s) => s.where === "step-request")
      .map((s) => `step request: ${describeCheck(s.check)}`),
  ];
}

function sideEffectLines(j: Journey): string[] {
  return [
    ...[...new Set(buildWriteRequests(j).map((w) => `write ${w.method} ${w.endpoint}`))],
    ...buildRiskyControls(j, undefined).map((c) => `control "${c.control}" [${c.ruleId}]`),
    ...buildOrigins(j).map((o) => `origin ${o}`),
  ];
}

function multisetDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const left = new Map<string, number>();
  for (const l of before) left.set(l, (left.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const l of before) {
    const n = left.get(l) ?? 0;
    if (n > 0) {
      removed.push(l);
      left.set(l, n - 1);
    }
  }
  return { added, removed };
}

function buildVerify(journey: Journey, hash: string, rec: JourneyVerifyRecord | null | undefined): JourneyReviewVerify {
  if (rec === null || rec === undefined) {
    return { status: "not-verified", hint: `run \`jevitate journey verify ${journey.metadata.id} --mutate\` to prove each assertion can fail` };
  }
  return {
    status: "recorded",
    verdict: rec.verdict,
    at: rec.at,
    stale: rec.contentHash !== hash,
    ...(rec.reason === undefined ? {} : { reason: rec.reason }),
    summary: { ...rec.summary },
  };
}

/** #432: the review sheet of one Journey — pure. */
export function buildJourneyReview(journey: Journey, ctx: JourneyReviewContext = {}): JourneyReview {
  const m = journey.metadata;
  const hash = journeyReviewHash(journey);
  const steps = buildSteps(journey);
  const flat = flatJourneySteps(journey);

  const missingIntent: string[] = [];
  const annotate = `draft it with \`jevitate journey annotate ${m.id}\``;
  if ((m.goal ?? "").trim() === "") missingIntent.push(`no goal — ${annotate}`);
  if ((m.successCriteria ?? []).length === 0) missingIntent.push(`no success criteria — ${annotate}`);
  const withoutObjective = steps.filter((s) => s.objective === undefined).length;
  if (withoutObjective > 0) missingIntent.push(`${withoutObjective} of ${steps.length} step(s) have no objective — ${annotate}`);

  const secret = new Set(secretParamNames(journey));
  const described = new Map((m.parameters ?? []).map((p) => [p.name, p.description]));
  const paramNames = [...new Set([...journeyRunParams(journey), ...(m.parameters ?? []).map((p) => p.name)])];

  const findings = lintJourney(journey);
  const stepAssertions = journeyAssertions(journey).flatMap((site) => {
    if (site.where === "end-state") return [];
    const explained = explainCheck(site.check);
    if (site.where === "step-request") return [{ step: site.step, check: describeCheck(site.check), weak: explained.weak, text: explained.text }];
    const step = flat[site.step - 1]?.recorded.step;
    const weak =
      explained.weak || site.check.assertion.kind === "visible" || (site.field === "expect" && step !== undefined && (isOwnTargetVisible(step) || isNoClaimExpect(step)));
    return [{ step: site.step, check: describeCheck(site.check), weak, text: explained.text }];
  });
  const endStateChecks = journeyEndState(journey);
  const endStateExplained = endStateChecks.map(explainCheck);
  const anchors = (m.anchors ?? []).map((a) => ({ name: a.name, step: a.step }));
  const writeRequests = buildWriteRequests(journey);
  const enriched = steps.map((st) => {
    const checks = stepAssertions.filter((a) => a.step === st.number).map((a) => ({ text: a.text, weak: a.weak }));
    const mine = anchors.filter((a) => a.step === st.number).map((a) => a.name);
    const rec = flat[st.number - 1]?.recorded.step;
    const file = rec !== undefined && rec.kind === "upload" ? describeFile(sanitized(rec) as Extract<Step, { kind: "upload" }>) : undefined;
    return { ...st, ...(checks.length === 0 ? {} : { checks }), ...(mine.length === 0 ? {} : { anchors: mine }), ...(file === undefined ? {} : { file }) };
  });

  const review: Omit<JourneyReview, "attention"> = {
    id: m.id,
    name: m.name,
    promoted: m.promoted,
    summary: {
      ...(m.description === undefined ? {} : { description: m.description }),
      ...(m.goal === undefined ? {} : { goal: m.goal }),
      ...(m.persona === undefined ? {} : { persona: m.persona }),
      ...(m.role === undefined ? {} : { role: m.role }),
      ...((journey.recording.intent ?? "").trim() === "" ? {} : { intent: journey.recording.intent!.trim() }),
      requiresAuth: m.requiresAuth === true,
      preconditions: (m.preconditions ?? []).map((p) => p.description),
      successCriteria: (m.successCriteria ?? []).map((c) => ({
        description: c.description,
        ...(c.check === undefined ? {} : { check: describeCheck({ kind: "page", assertion: c.check }) }),
      })),
      missingIntent,
    },
    steps: enriched,
    sideEffects: { writeRequests, riskyControls: buildRiskyControls(journey, ctx.safety), origins: buildOrigins(journey) },
    inputs: {
      params: paramNames.map((name) => {
        const description = described.get(name);
        return { name, ...(description === undefined ? {} : { description }), secret: secret.has(name) };
      }),
      secrets: (m.secretRefs ?? []).map((r) => ({ field: r.field, manager: r.manager, origin: r.origin })),
    },
    proof: {
      endState: endStateChecks.map(describeCheck),
      endStateText: endStateExplained.map((e) => e.text),
      stepAssertions,
      lint: {
        errors: findings.filter((f) => f.level === "error").length,
        warnings: findings.filter((f) => f.level === "warning").length,
        findings: findings.map((f) => ({ rule: f.rule, level: f.level, ...(f.step === undefined ? {} : { step: f.step }), message: f.message })),
      },
      ...(m.acceptedWeak === undefined ? {} : { acceptedWeak: { reason: m.acceptedWeak.reason, rules: [...m.acceptedWeak.rules] } }),
      verify: buildVerify(journey, hash, ctx.lastVerify),
    },
    changeSinceApproval: buildChange(journey, hash, ctx.approvedSnapshot, ctx.stepIdOnly === true),
    ...(m.approval === undefined
      ? {}
      : {
          approval: {
            contentHash: m.approval.contentHash,
            at: m.approval.at,
            ...(m.approval.provenance === undefined ? {} : { provenance: copyProvenance(m.approval.provenance) }),
            ...(m.approval.acceptedWeak === undefined
              ? {}
              : { acceptedWeak: { reason: m.approval.acceptedWeak.reason, rules: [...m.approval.acceptedWeak.rules], ...provenanceField(m.approval.acceptedWeak.provenance) } }),
            ...(m.approval.waivers === undefined ? {} : { waivers: m.approval.waivers.map((w) => ({ kind: w.kind, reason: w.reason, items: [...w.items], ...provenanceField(w.provenance) })) }),
            ...(m.approval.acceptedFindings === undefined
              ? {}
              : { acceptedFindings: { reason: m.approval.acceptedFindings.reason, findings: [...m.approval.acceptedFindings.findings], ...provenanceField(m.approval.acceptedFindings.provenance) } }),
          },
        }),
    ...(ctx.catalog === undefined ? {} : { catalog: ctx.catalog.links, findings: [...ctx.catalog.findings] }),
    ...(ctx.anchorIssues === undefined ? {} : { anchorWarnings: anchorWarningsOf(ctx.anchorIssues) }),
    ...(ctx.locatorHealth === undefined ? {} : { locatorHealth: locatorHealthOf(ctx.locatorHealth) }),
    ...(ctx.proposal === undefined ? {} : { proposal: buildProposal(ctx.proposal, m.id) }),
    ...(anchors.length === 0 ? {} : { anchors }),
    contentHash: hash,
  };
  return { ...review, attention: buildAttention(review, endStateExplained.filter((e) => e.weak).map((e) => e.text), m.goal) };
}

/** An upload step's file in words: the recorded path, `{var}` or «redacted». */
function describeFile(step: Extract<Step, { kind: "upload" }>): string | undefined {
  const f = step.file as ValueOrVar | undefined;
  if (f === undefined) return undefined;
  if ("var" in f) return `{${f.var}}`;
  return f.redacted ? "«redacted»" : f.value;
}

/** Everything that needs the reviewer's decision, warnings first (stable within a severity). */
function buildAttention(r: Omit<JourneyReview, "attention">, weakEndState: readonly string[], goal: string | undefined): JourneyReviewAttention[] {
  const out: JourneyReviewAttention[] = [];
  const warn = (text: string, hint?: string): void => void out.push({ severity: "warn", text, ...(hint === undefined ? {} : { hint }) });
  const info = (text: string, hint?: string): void => void out.push({ severity: "info", text, ...(hint === undefined ? {} : { hint }) });

  const weakSteps = [...new Set(r.proof.stepAssertions.filter((a) => a.weak).map((a) => a.step))];
  if (weakSteps.length === 1) warn(`Step ${stepRanges(weakSteps)} proves nothing: its check passes even if the step fails`);
  else if (weakSteps.length > 1) warn(`Steps ${stepRanges(weakSteps)} prove nothing: their checks pass even if the step fails`);
  for (const t of weakEndState) warn(`An end-state check proves nothing: ${t}`);

  const annotate = `jevitate journey annotate ${r.id}`;
  const noGoal = (goal ?? "").trim() === "";
  const noCriteria = r.summary.successCriteria.length === 0;
  if (noGoal && noCriteria) warn("No goal or success criteria written", annotate);
  else if (noGoal) warn("No goal written", annotate);
  else if (noCriteria) warn("No success criteria written", annotate);

  for (const f of r.proof.lint.findings) {
    warn(`Lint ${f.level} ${f.rule}${f.step === undefined ? "" : ` (step ${f.step})`}: ${f.message}`);
  }
  for (const c of r.sideEffects.riskyControls) {
    const text = `Risky control at step ${c.step}: ${c.role === undefined ? "" : `${c.role} `}"${c.control}" (${c.risk})`;
    if (c.waivedBy === undefined) warn(text);
    else info(`${text}, exempted by allowControl`);
  }
  if (r.catalog !== undefined) {
    if (r.catalog.unvetted.length > 0) warn(`Unvetted catalog links: ${r.catalog.unvetted.join(", ")}`, `approve them, or promote with --accept-unvetted "<reason>"`);
    if (r.catalog.needsReReview.length > 0) warn(`Catalog links need re-review: ${r.catalog.needsReReview.join("; ")}`);
  }
  for (const f of r.findings ?? []) {
    if (f.analyzer === "catalog-analysis") continue;
    if (f.severity !== "info") warn(f.message, f.fix);
    else if (f.analyzer === "readiness" || f.analyzer === "readiness-jev") info(f.message, f.fix);
  }
  const c = r.changeSinceApproval;
  if ((c.kind === "diff" || c.kind === "snapshot-missing") && c.changed) {
    if (c.kind === "diff") {
      const bit = (sign: string, n: number, word: string, many?: string): string[] => (n === 0 ? [] : [`${sign}${plural(n, word, many)}`]);
      const parts = [
        ...bit("+", c.steps.added.length, "step"),
        ...bit("−", c.steps.removed.length, "step"),
        ...bit("+", c.assertions.added.length, "check"),
        ...bit("−", c.assertions.removed.length, "check"),
        ...bit("+", c.sideEffects.added.length, "side effect"),
        ...bit("−", c.sideEffects.removed.length, "side effect"),
      ];
      warn(`Changed since approval${parts.length === 0 ? "" : `: ${parts.join(", ")}`}${c.stepIdOnly === true ? " (step ids only)" : ""}`, "--full lists every change");
    } else {
      warn(`Changed since approval (its approved snapshot is missing, so only the hash differs)${c.stepIdOnly === true ? " (step ids only)" : ""}`);
    }
  }
  for (const w of r.anchorWarnings ?? []) warn(`Anchor ${w.severity} ${w.path}${w.step === undefined ? "" : ` (step ${w.step})`}: ${w.message}`, w.fix);
  if (r.proposal !== undefined) {
    const p = r.proposal;
    if (p.stale || p.problem !== undefined) warn(`A self-heal proposal is pending but cannot be accepted: ${p.stale ? "the Journey changed since" : p.problem}`);
    else warn(`A self-heal proposal changes ${plural(p.steps.length, "step")}`, p.acceptCommand);
  }
  const v = r.proof.verify;
  if (v.status === "not-verified") info("Not mutation-tested", `jevitate journey verify ${r.id} --mutate`);
  else if (v.stale) warn("The mutation proof is out of date: the Journey changed after it ran", `jevitate journey verify ${r.id} --mutate`);
  else if (v.verdict === "insensitive") warn("Mutation proof: some checks cannot fail", `jevitate journey verify ${r.id} --mutate`);
  if (r.proof.acceptedWeak !== undefined) info(`Weak checks were accepted: "${r.proof.acceptedWeak.reason}"`);
  if (r.locatorHealth !== undefined && r.locatorHealth.brittle > 0) info(`${plural(r.locatorHealth.brittle, "step")} on brittle locators`, "--full lists the fixes");
  return [...out.filter((a) => a.severity === "warn"), ...out.filter((a) => a.severity === "info")];
}

/** #437: a copy of an approval's provenance (the sheet never shares the Journey's objects). */
function copyProvenance(p: ApprovalProvenance): ApprovalProvenance {
  return {
    channel: p.channel,
    agentSignals: [...p.agentSignals],
    ...(p.user === undefined ? {} : { user: p.user }),
    ...(p.reason === undefined ? {} : { reason: p.reason }),
    ...(p.pr === undefined ? {} : { pr: { ...p.pr } }),
  };
}

/** #466: the anchor-rule and catalog-reference problems as sheet warnings (each with its fix). */
function anchorWarningsOf(i: NonNullable<JourneyReviewContext["anchorIssues"]>): JourneyReviewAnchorWarning[] {
  return [...i.anchorIssues, ...i.refIssues].map((x) => ({
    code: x.code,
    severity: x.severity,
    path: x.path,
    ...("step" in x && x.step !== undefined ? { step: x.step } : {}),
    message: x.message,
    ...(x.fix === undefined ? {} : { fix: x.fix }),
  }));
}

/** #470: the brittle steps of a Journey's locator health, with the fix for each. */
function locatorHealthOf(h: LocatorHealthDetail): JourneyReviewLocatorHealth {
  return {
    line: h.line,
    stable: h.stable,
    brittle: h.brittle,
    brittleSteps: h.steps
      .filter((s) => s.stability === "brittle")
      .map((s) => ({
        ...(s.stepId === undefined ? {} : { stepId: s.stepId }),
        index: s.index,
        kind: s.kind,
        rung: s.rung,
        level: s.level,
        ...(s.route === undefined ? {} : { route: s.route }),
        locator: s.locator,
        reasons: [...s.reasons],
        fix: h.suggestions.find((x) => x.key === s.suggestion)?.fix ?? "add a stable test id to this control",
      })),
  };
}

function provenanceField(p: ApprovalProvenance | undefined): { provenance?: ApprovalProvenance } {
  return p === undefined ? {} : { provenance: copyProvenance(p) };
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

/** How the sheet is drawn. `width` wraps the text sheet (default 100); `color` adds ANSI; `full` adds the detail sections. */
export interface RenderOptions {
  readonly width?: number;
  readonly color?: boolean;
  readonly full?: boolean;
}

function renderSheet(r: JourneyReview, style: Style, opts: RenderOptions = {}): string {
  const w = createSheetWriter(style, opts);
  renderHeader(r, w, opts);
  renderAttention(r, w, opts);
  renderWhatItDoes(r, w, opts);
  renderInputs(r, w, opts);
  renderSteps(r, w, opts);
  renderProvesAtTheEnd(r, w, opts);
  renderWrites(r, w, opts);
  renderClear(r, w, opts);
  renderProposal(r, w, opts);
  if (opts.full === true) renderFullDetail(r, w, opts);
  renderApprove(r, w, opts);
  return finishSheet(w);
}

/** #432: the review sheet as Markdown (`journey review --markdown`). */
export function renderReviewMarkdown(review: JourneyReview, opts: RenderOptions = {}): string {
  return renderSheet(review, "markdown", opts);
}

/** #432: the review sheet as plain text (`journey review`, and `journey promote` in human mode). */
export function renderReviewText(review: JourneyReview, opts: RenderOptions = {}): string {
  return renderSheet(review, "text", opts);
}

/** #432: a review sheet file's content hash refused (none, or two different ones). */
export class ReviewSheetError extends Error {
  readonly code = "E_JOURNEY_REVIEW_ARGS";
}

const HASH_LINE = /Content hash:\s*`?([0-9a-f]{64})`?/gi;

/**
 * #432: the content hash a review sheet file names — the `contentHash` of a JSON sheet
 * (`journey review --json --out`, its envelope or the bare sheet), or the `Content hash:` line of a
 * Markdown / text one. A sheet naming no hash, or two different ones, is refused.
 */
export function reviewSheetHash(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ReviewSheetError("the review sheet is not valid JSON");
    }
    const o = parsed as { contentHash?: unknown; data?: { contentHash?: unknown } };
    const hash = o.contentHash ?? o.data?.contentHash;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new ReviewSheetError("the review sheet names no contentHash");
    return hash;
  }
  const hashes = new Set([...text.matchAll(HASH_LINE)].map((m) => m[1]!.toLowerCase()));
  if (hashes.size === 0) throw new ReviewSheetError("the review sheet names no content hash (a `Content hash:` line)");
  if (hashes.size > 1) throw new ReviewSheetError("the review sheet names more than one content hash");
  return [...hashes][0]!;
}
