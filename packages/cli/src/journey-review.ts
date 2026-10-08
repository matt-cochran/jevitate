import { contentHash } from "@jevitate/domain";
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
} from "@jevitate/journey";
import { renderFindings } from "./catalog-review.js";
import { SafetyPolicy, describeCheck, type SafetyConfig } from "@jevitate/explore";
import { navigateUrlParams, writeClassifier, type Step, type TargetDescriptor, type ValueOrVar } from "@jevitate/recording";

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
  return [t.name, t.label, t.testId, t.text].some((s) => s !== undefined && SECRET_PARAM_NAME_RE.test(s));
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

function buildSteps(journey: Journey): JourneyReviewStep[] {
  return flatJourneySteps(journey).map(({ index, recorded }) => {
    const step = recorded.step;
    const target = reviewTarget(targetOf(step));
    const assertion = ownAssertion(step);
    return {
      number: index + 1,
      kind: step.kind,
      action: describeStep(sanitized(step)),
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

function buildChange(journey: Journey, hash: string, snapshot: Journey | null | undefined): JourneyReviewChange {
  const approval = journey.metadata.approval;
  if (snapshot === null || snapshot === undefined) {
    if (approval !== undefined) {
      return { kind: "snapshot-missing", approvedHash: approval.contentHash, approvedAt: approval.at, changed: approval.contentHash !== hash };
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
    if (site.where === "step-request") return [{ step: site.step, check: describeCheck(site.check), weak: false }];
    const step = flat[site.step - 1]?.recorded.step;
    const weak =
      site.check.assertion.kind === "visible" || (site.field === "expect" && step !== undefined && (isOwnTargetVisible(step) || isNoClaimExpect(step)));
    return [{ step: site.step, check: describeCheck(site.check), weak }];
  });

  return {
    id: m.id,
    name: m.name,
    promoted: m.promoted,
    summary: {
      ...(m.description === undefined ? {} : { description: m.description }),
      ...(m.goal === undefined ? {} : { goal: m.goal }),
      ...(m.persona === undefined ? {} : { persona: m.persona }),
      ...(m.role === undefined ? {} : { role: m.role }),
      requiresAuth: m.requiresAuth === true,
      preconditions: (m.preconditions ?? []).map((p) => p.description),
      successCriteria: (m.successCriteria ?? []).map((c) => ({
        description: c.description,
        ...(c.check === undefined ? {} : { check: describeCheck({ kind: "page", assertion: c.check }) }),
      })),
      missingIntent,
    },
    steps,
    sideEffects: { writeRequests: buildWriteRequests(journey), riskyControls: buildRiskyControls(journey, ctx.safety), origins: buildOrigins(journey) },
    inputs: {
      params: paramNames.map((name) => {
        const description = described.get(name);
        return { name, ...(description === undefined ? {} : { description }), secret: secret.has(name) };
      }),
      secrets: (m.secretRefs ?? []).map((r) => ({ field: r.field, manager: r.manager, origin: r.origin })),
    },
    proof: {
      endState: journeyEndState(journey).map(describeCheck),
      stepAssertions,
      lint: {
        errors: findings.filter((f) => f.level === "error").length,
        warnings: findings.filter((f) => f.level === "warning").length,
        findings: findings.map((f) => ({ rule: f.rule, level: f.level, ...(f.step === undefined ? {} : { step: f.step }), message: f.message })),
      },
      ...(m.acceptedWeak === undefined ? {} : { acceptedWeak: { reason: m.acceptedWeak.reason, rules: [...m.acceptedWeak.rules] } }),
      verify: buildVerify(journey, hash, ctx.lastVerify),
    },
    changeSinceApproval: buildChange(journey, hash, ctx.approvedSnapshot),
    ...(m.approval === undefined
      ? {}
      : {
          approval: {
            contentHash: m.approval.contentHash,
            at: m.approval.at,
            ...(m.approval.acceptedWeak === undefined ? {} : { acceptedWeak: { reason: m.approval.acceptedWeak.reason, rules: [...m.approval.acceptedWeak.rules] } }),
            ...(m.approval.waivers === undefined ? {} : { waivers: m.approval.waivers.map((w) => ({ kind: w.kind, reason: w.reason, items: [...w.items] })) }),
            ...(m.approval.acceptedFindings === undefined ? {} : { acceptedFindings: { reason: m.approval.acceptedFindings.reason, findings: [...m.approval.acceptedFindings.findings] } }),
          },
        }),
    ...(ctx.catalog === undefined ? {} : { catalog: ctx.catalog.links, findings: [...ctx.catalog.findings] }),
    contentHash: hash,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

type Style = "markdown" | "text";

function renderSheet(r: JourneyReview, style: Style): string {
  const md = style === "markdown";
  const code = (s: string): string => (md ? `\`${s.replace(/`/g, "'")}\`` : s);
  const h1 = (s: string): string => (md ? `# ${s}` : `${s}\n${"=".repeat(Math.min(s.length, 80))}`);
  const h2 = (s: string): string => (md ? `## ${s}` : `${s.toUpperCase()}`);
  const h3 = (s: string): string => (md ? `### ${s}` : `${s}:`);
  const em = (s: string): string => (md ? `_${s}_` : s);
  const li = (s: string, depth = 0): string => `${"  ".repeat(md ? depth : depth + 1)}- ${s}`;
  const out: string[] = [];
  const section = (...lines: string[]): void => {
    out.push(...lines, "");
  };
  const list = (items: readonly string[], none: string): string[] => (items.length === 0 ? [li(em(none))] : items.map((i) => li(i)));

  section(
    h1(`Journey review: ${r.name} (${r.id})`),
    "",
    `Content hash: ${code(r.contentHash)}`,
    `Status: ${r.promoted ? "promoted" : "not promoted"}${r.approval === undefined ? "" : ` · last approved ${r.approval.at}`}`,
  );

  const s = r.summary;
  section(
    h2("Summary"),
    "",
    ...(s.description === undefined ? [] : [li(`Description: ${s.description}`)]),
    li(`Goal: ${s.goal ?? em("none")}`),
    ...(s.persona === undefined ? [] : [li(`Persona: ${s.persona}`)]),
    ...(s.role === undefined ? [] : [li(`Runs as: ${s.role}`)]),
    ...(s.requiresAuth ? [li("Needs an authenticated session")] : []),
    ...(s.preconditions.length === 0 ? [] : [li("Preconditions:"), ...s.preconditions.map((p) => li(p, 1))]),
    li("Success criteria:"),
    ...(s.successCriteria.length === 0
      ? [li(em("none"), 1)]
      : s.successCriteria.map((c) => li(`${c.description}${c.check === undefined ? "" : ` (checked by ${code(c.check)})`}`, 1))),
    ...(s.missingIntent.length === 0 ? [] : [li("Missing intent:"), ...s.missingIntent.map((w) => li(`⚠ ${w}`, 1))]),
  );

  const stepLinesOut: string[] = [];
  for (const st of r.steps) {
    const target = st.target === undefined ? "" : ` — target: ${[st.target.role, st.target.name === undefined ? undefined : `"${st.target.name}"`].filter((x) => x !== undefined).join(" ")}`;
    stepLinesOut.push(`${md ? "" : "  "}${st.number}. ${md ? `**${st.action}**` : st.action}${target}`);
    const sub = (t: string): void => {
      stepLinesOut.push(`${md ? "   " : "     "}- ${t}`);
    };
    sub(`Objective: ${st.objective ?? em("none")}`);
    if (st.expectedResult !== undefined) sub(`Expected result: ${st.expectedResult}`);
    if (st.assertion !== undefined) sub(`Checks: ${code(st.assertion)}`);
    if (st.params.length > 0) sub(`Params: ${st.params.map(code).join(", ")}`);
  }
  section(h2("Steps"), "", ...(stepLinesOut.length === 0 ? [li(em("no steps"))] : stepLinesOut));

  const fx = r.sideEffects;
  section(
    h2("Side effects"),
    "",
    h3("Write requests"),
    ...list(
      fx.writeRequests.map((w) => `${code(`${w.method} ${w.endpoint}`)} — ${w.source === "recorded" ? `recorded at step ${w.step}` : w.source === "expect-request" ? `expected at step ${w.step}` : "end-state check"}`),
      "none expected",
    ),
    "",
    h3("Controls matching safety rules"),
    ...list(
      fx.riskyControls.map(
        (c) => `step ${c.step}: ${c.role === undefined ? "" : `${c.role} `}"${c.control}" — ${c.risk} [${code(c.ruleId)}]${c.waivedBy === undefined ? "" : ` (exempted by allowControl ${code(c.waivedBy)})`}`,
      ),
      "none",
    ),
    "",
    h3("Origins"),
    ...list(fx.origins.map(code), "none"),
  );

  section(
    h2("Inputs"),
    "",
    h3("Parameters"),
    ...list(r.inputs.params.map((p) => `${code(p.name)}${p.secret ? " (secret)" : ""}${p.description === undefined ? "" : ` — ${p.description}`}`), "none"),
    "",
    h3("Secret references"),
    ...list(r.inputs.secrets.map((x) => `${code(x.field)} from ${x.manager} on ${x.origin}`), "none"),
  );

  const p = r.proof;
  const verify =
    p.verify.status === "not-verified"
      ? `not verified — ${p.verify.hint}`
      : `${p.verify.verdict} (${p.verify.at})${p.verify.stale ? " — STALE: the Journey changed after this proof ran" : ""}${p.verify.reason === undefined ? "" : ` — ${p.verify.reason}`}: ${Object.entries(p.verify.summary)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ")}`;
  section(
    h2("Proof"),
    "",
    h3("End-state checks"),
    ...list(p.endState.map(code), "none"),
    "",
    h3("Per-step assertions"),
    ...list(p.stepAssertions.map((a) => `step ${a.step}: ${code(a.check)}${a.weak ? " (weak: proves nothing about the step's effect)" : ""}`), "none"),
    "",
    h3(`Lint: ${p.lint.errors} error(s), ${p.lint.warnings} warning(s)`),
    ...list(p.lint.findings.map((f) => `${f.level} ${f.rule}${f.step === undefined ? "" : ` (step ${f.step})`}: ${f.message}`), "no findings"),
    ...(p.acceptedWeak === undefined ? [] : ["", `Accepted weak: "${p.acceptedWeak.reason}" (waived: ${p.acceptedWeak.rules.join(", ")})`]),
    "",
    `Mutation proof: ${verify}`,
  );

  const c = r.changeSinceApproval;
  const change: string[] = [];
  if (c.kind === "first-approval") change.push(em("first approval — nothing approved before"));
  else if (c.kind === "no-record") change.push(em("promoted before approvals were recorded — no approved version to compare with"));
  else if (c.kind === "snapshot-missing") {
    change.push(`Approved${c.approvedAt === undefined ? "" : ` ${c.approvedAt}`} as ${code(c.approvedHash)}; its snapshot is missing — ${c.changed ? "the Journey CHANGED since" : "unchanged since"}`);
  } else {
    change.push(`Approved${c.approvedAt === undefined ? "" : ` ${c.approvedAt}`} as ${code(c.approvedHash)} — ${c.changed ? "CHANGED since" : "unchanged since"}`);
    for (const [label, d] of [
      ["Steps", c.steps],
      ["Assertions", c.assertions],
      ["Side effects", c.sideEffects],
    ] as const) {
      if (d.added.length === 0 && d.removed.length === 0) continue;
      change.push("", h3(label), ...d.removed.map((l) => li(`− ${l}`)), ...d.added.map((l) => li(`+ ${l}`)));
    }
  }
  section(h2("Change since last approval"), "", ...change);

  // #433: the catalog links (job, persona), then the pre-approval findings — before the approval line.
  if (r.catalog !== undefined) {
    const k = r.catalog;
    const status = (st: string): string => (st === "stale" ? "STALE — needs re-review" : st === "unknown" ? "UNKNOWN — not declared in the catalog" : st);
    section(
      h2("Catalog"),
      "",
      ...(k.linked
        ? [
            li(k.job === undefined ? `Job: ${em("none")}` : `Job: ${code(k.job.id)} (${status(k.job.status)})${k.job.story === undefined ? "" : ` — ${k.job.story}`}`),
            li(k.persona === undefined ? `Persona: ${em("none")}` : `Persona: ${code(k.persona.id)} (${status(k.persona.status)})`),
            ...(k.unvetted.length === 0 ? [] : [li(`Unvetted: ${k.unvetted.join(", ")} — promote needs them approved, or --accept-unvetted "<reason>"`)]),
            ...(k.needsReReview.length === 0 ? [] : [li(`NEEDS RE-REVIEW: ${k.needsReReview.join("; ")}`)]),
          ]
        : [li(em("not linked to a job/persona"))]),
    );
  }
  if (r.findings !== undefined) section(...renderFindings(r.findings, style));
  if (r.approval?.waivers !== undefined || r.approval?.acceptedFindings !== undefined) {
    section(
      h3("Recorded with the last approval"),
      ...(r.approval.waivers ?? []).map((w) => li(`waived (${w.kind}): "${w.reason}" — ${w.items.join(", ")}`)),
      ...(r.approval.acceptedFindings === undefined ? [] : [li(`acknowledged findings: "${r.approval.acceptedFindings.reason}" — ${r.approval.acceptedFindings.findings.join(", ")}`)]),
    );
  }

  section(
    h2("Content hash"),
    "",
    `Content hash: ${code(r.contentHash)}`,
    "",
    `Approve exactly this version: ${code(`jevitate journey promote ${r.id} --reviewed-hash ${r.contentHash}`)}`,
  );
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** #432: the review sheet as Markdown (`journey review --markdown`). */
export function renderReviewMarkdown(review: JourneyReview): string {
  return renderSheet(review, "markdown");
}

/** #432: the review sheet as plain text (`journey review`, and `journey promote` in human mode). */
export function renderReviewText(review: JourneyReview): string {
  return renderSheet(review, "text");
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
