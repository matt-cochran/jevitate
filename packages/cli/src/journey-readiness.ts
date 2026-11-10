import { relative, sep } from "node:path";
import {
  MAX_DECLARED_RELAXATIONS,
  checkCompatibility,
  journeyParamSchema,
  lintJourney,
  type HandbackOutcome,
  type Journey,
  type JourneyLintFinding,
  type JourneyReview,
  type JourneyTargetedProofPlan,
} from "@jevitate/journey";
import { currentBuildTree, currentEngineInfo } from "./engine.js";
import { environmentFromFlags, type ResolvedJourneyEnvironment } from "./environments.js";
import { runJourneyChain, chainSucceeded, type JourneyChainResult } from "./journey-chain.js";
import { journeyContentHash } from "./journey-annotate-api.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { verifyRecordPath } from "./journey-review-store.js";
import { journeyReadRequests } from "./target-config.js";
import { verifyJourneyMutations } from "./journey-verify.js";
import { clock, DEFAULT_DONE_CHECK_POLICY } from "@jevitate/domain";
import type { JobVerdict } from "@jevitate/adjudicator";
import { resolveCatalogDir } from "./catalog-api.js";
import { DoneCheckRun, doneCheckPolicyOf } from "./journey-done-check-hook.js";
import { JOB_NOT_ACHIEVED_ATTENTION } from "./journey-review.js";
import { runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";

/**
 * #581 — `jevitate journey readiness <id> [--with <toId>]`: one receipt over a Journey (or a linked
 * pair) that runs only static checks in `report` mode. `replay` adds the baseline run/chain and
 * `prove` adds `journey verify --mutate`; both refuse a missing/production target and a missing
 * required param before any browser opens. It reuses `journey lint`, the review sheet (and its
 * `--strict` attention), the `.verify/<id>.json` proof record, catalog links, `journey run`/`chain`
 * and `journey verify`. It adds no proof, approval or authority — only a code-computed verdict.
 */

export type ReadinessMode = "report" | "replay" | "prove";

export type ReadinessCheckState = "pass" | "fail" | "inconclusive" | "stale" | "not-run" | "awaiting-human";

export type ReadinessVerdict = "technically-ready" | "blocked" | "inconclusive" | "incomplete";

export interface ReadinessCheck {
  readonly check: string;
  readonly journey: string;
  readonly state: ReadinessCheckState;
  readonly detail: string;
  readonly evidence?: string;
  /**
   * 0.30.0 (owner decision "Proof role"): the check is shown but does not gate the verdict — the mutation
   * proof under `mutationProofPolicy: advisory` (the default), the job under `doneCheckPolicy: advisory`.
   */
  readonly advisory?: true;
}

export interface ReadinessBlocker {
  readonly check: string;
  readonly journey: string;
  readonly why: string;
  readonly next: string;
}

export interface ReadinessAwaitingHuman {
  readonly check: string;
  readonly journey: string;
  readonly item: string;
  readonly next: string;
}

export interface ReadinessJourney {
  readonly id: string;
  readonly contentHash: string;
  readonly reviewHash: string;
  readonly promoted: boolean;
}

export interface ReadinessTarget {
  readonly origin: string;
  readonly env?: string;
}

export interface ReadinessEngine {
  readonly version: string;
  readonly commit: string;
  readonly tree: string;
}

export interface ReadinessReceipt {
  readonly engine: ReadinessEngine;
  readonly mode: ReadinessMode;
  readonly target: ReadinessTarget | null;
  readonly journeys: readonly ReadinessJourney[];
  readonly checks: readonly ReadinessCheck[];
  readonly verdict: ReadinessVerdict;
  readonly blockers: readonly ReadinessBlocker[];
  readonly awaitingHuman: readonly ReadinessAwaitingHuman[];
  readonly next: readonly string[];
}

/** #581: a refusal `replay`/`prove` makes before any browser opens (exit 64, docs/contracts/readiness-and-bundle.md §1). */
export type ReadinessRefusalCode = "E_READINESS_TARGET" | "E_READINESS_PRODUCTION" | "E_READINESS_PARAMS";

export class ReadinessError extends Error {
  readonly code: ReadinessRefusalCode;

  constructor(code: ReadinessRefusalCode, message: string) {
    super(message);
    this.name = "ReadinessError";
    this.code = code;
  }
}

export interface JourneyReadinessOptions {
  readonly id: string;
  /** A linked pair: `<id>` produces, `<toId>` consumes (the #582 handoff is checked). */
  readonly with?: string;
  readonly mode?: ReadinessMode;
  readonly env?: string;
  readonly baseUrl?: string;
  readonly params?: Readonly<Record<string, string>>;
  /** The approved requests, as raw JSON Lines (a pair's `replay`/`prove` needs them). */
  readonly requests?: string;
  readonly storageState?: string;
  /** The shared browser launch settings (`--browser-*`), as `journey run` takes them. */
  readonly browser?: RunJourneyProgrammaticallyOptions["browser"];
  /** The host's browser seam (tests inject a pooled browser), as `journey run`/`journey chain`. */
  readonly browserPortFactory?: RunJourneyProgrammaticallyOptions["browserPortFactory"];
  readonly journeysDir: string;
  readonly catalogDir?: string | null;
  readonly targetsFile?: string;
  /** The project root an upload fixture resolves against (defaults to the run's own resolution). */
  readonly projectDir?: string;
  /** A per-Journey mission-fixtures builder, as `journey run --fixtures` (pair chains never take one). */
  readonly fixtures?: (id: string, environment: ResolvedJourneyEnvironment | undefined) => RunJourneyProgrammaticallyOptions["fixtures"];
}

export interface JourneyReadinessDeps {
  readonly review?: typeof reviewJourneyById;
  readonly run?: typeof runJourneyProgrammatically;
  readonly chain?: typeof runJourneyChain;
  readonly verify?: typeof verifyJourneyMutations;
  readonly environmentsFile?: string;
  readonly cwd?: () => string;
}

interface JourneyContext {
  readonly id: string;
  journey: Journey;
  review: JourneyReview;
  /** M4: in replay/prove, the job verdict of the replay this receipt just ran (never an earlier run's). */
  replayJob?: NonNullable<JourneyReview["job"]>;
}

interface ReplayOutcome {
  readonly state: ReadinessCheckState;
  readonly detail: string;
}

/** The checks whose `stale` / `not-run` makes the verdict `incomplete` (unless they are advisory). */
const REQUIRED_CHECKS: ReadonlySet<string> = new Set(["proof", "job"]);

/** #581 §1: the target shared by `replay` and `prove`, refused in this order before any runner call. */
function resolveTarget(opts: JourneyReadinessOptions, deps: JourneyReadinessDeps, required: readonly string[], declared: readonly string[]): ResolvedJourneyEnvironment {
  let environment: ResolvedJourneyEnvironment | undefined;
  if (opts.env !== undefined || opts.baseUrl !== undefined) {
    environment = environmentFromFlags(
      { ...(opts.env === undefined ? {} : { env: opts.env }), ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }) },
      { ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }), ...(opts.targetsFile === undefined ? {} : { targetsFile: opts.targetsFile }) },
    );
  }
  if (environment === undefined) {
    throw new ReadinessError("E_READINESS_TARGET", "replay and prove need a target: pass --env <name> or --base-url <origin>");
  }
  if (environment.production === true) {
    throw new ReadinessError("E_READINESS_PRODUCTION", `environment '${environment.name ?? environment.baseUrl}' is flagged production: readiness never replays or proves against it`);
  }
  const missing = required.filter((name) => !(name in (opts.params ?? {})));
  if (missing.length > 0) {
    throw new ReadinessError("E_READINESS_PARAMS", `missing required param(s): ${missing.join(", ")}`);
  }
  // #608: a param the driven Journey does not declare is refused by name here (never by the chain),
  // so a mistyped `--param` never opens a browser. Names only — never a value.
  const unknown = Object.keys(opts.params ?? {}).filter((name) => !declared.includes(name));
  if (unknown.length > 0) {
    throw new ReadinessError("E_READINESS_PARAMS", `unknown param(s): ${unknown.join(", ")}`);
  }
  return environment;
}

/** The required params of the Journey the run/`--param` flags drive (a pair's consumer is bound by the chain). */
function requiredParams(journey: Journey, pair: boolean, hasRequests: boolean): string[] {
  const names = journeyParamSchema(journey).required;
  return pair && !hasRequests ? [...names, "requests"] : names;
}

function lintFindings(journey: Journey, projectDir: string | undefined): JourneyLintFinding[] {
  // `lintJourney` runs the upload-fixture rules itself when it is given a project root (#488).
  return lintJourney(journey, projectDir === undefined ? {} : { baseDir: projectDir });
}

function lintCheck(ctx: JourneyContext, projectDir: string | undefined): { check: ReadinessCheck; blocker?: ReadinessBlocker } {
  const findings = lintFindings(ctx.journey, projectDir);
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warning").length;
  if (errors > 0) {
    return {
      check: { check: "lint", journey: ctx.id, state: "fail", detail: `${errors} error(s)${warnings === 0 ? "" : `, ${warnings} warning(s)`}` },
      blocker: { check: "lint", journey: ctx.id, why: `${errors} lint error(s)`, next: `jevitate journey lint ${ctx.id}` },
    };
  }
  return { check: { check: "lint", journey: ctx.id, state: "pass", detail: warnings === 0 ? "no findings" : `${warnings} warning(s)` } };
}

function schemaCheck(ctx: JourneyContext): ReadinessCheck {
  return { check: "schema", journey: ctx.id, state: "pass", detail: "the Journey loads" };
}

/** #582: the producing/consuming contract of a pair; absent contracts are nothing to check. */
function handoffCheck(producer: JourneyContext, consumer: JourneyContext): { check: ReadinessCheck; blocker?: ReadinessBlocker } {
  const declared = producer.journey.metadata.outputs !== undefined || consumer.journey.metadata.inputs !== undefined;
  if (!declared) {
    return { check: { check: "handoff", journey: producer.id, state: "not-run", detail: "neither Journey declares a handoff contract" } };
  }
  const issues = checkCompatibility(producer.journey, consumer.journey);
  if (issues.length > 0) {
    return {
      check: { check: "handoff", journey: producer.id, state: "fail", detail: issues.map((i) => i.message).join("; ") },
      blocker: { check: "handoff", journey: producer.id, why: issues.map((i) => i.message).join("; "), next: `jevitate journey chain --from ${producer.id} --to ${consumer.id} --requests <file>` },
    };
  }
  return { check: { check: "handoff", journey: producer.id, state: "pass", detail: "contracts are compatible" } };
}

/** #583: a declared prepare-only boundary is what stops a Journey before the irreversible action. */
function boundaryCheck(ctx: JourneyContext): ReadinessCheck {
  return ctx.journey.metadata.boundary === undefined
    ? { check: "boundary", journey: ctx.id, state: "not-run", detail: "no prepare-only boundary declared" }
    : { check: "boundary", journey: ctx.id, state: "pass", detail: "a prepare-only boundary is declared" };
}

type Attention = NonNullable<JourneyReview["attention"]>[number];

/** #808: the command a person runs for one owner action the sheet names (hash-bound for the Journey's own promotion). */
function ownerActionCommand(ctx: JourneyContext, action: NonNullable<Attention["ownerActions"]>[number]): string {
  if (action.kind === "journey-promote") return `jevitate journey promote ${action.id} --reviewed-hash ${ctx.review.contentHash}`;
  return action.kind === "job-approve" ? `jevitate job review ${action.id}` : `jevitate persona review ${action.id}`;
}

/**
 * `journey review --strict`: every `warn` attention item is a blocker (an `info` item is advice, not a gate).
 * #808: an item only a person's approval settles (it names its owner actions: a stale Journey approval, a
 * catalog link that needs re-review) is approval currency, not a technical defect: it is listed under
 * `awaitingHuman` with the owner's commands, never sent back to strict review. `journey review --strict`
 * itself still fails on it, so CI keeps refusing a stale approval; nothing here approves anything.
 */
function reviewStrictCheck(ctx: JourneyContext): { check: ReadinessCheck; blocker?: ReadinessBlocker; awaiting: ReadinessAwaitingHuman[] } {
  // #608: an item a person's catalog approval settles is the catalog check's awaiting-human entry;
  // counted here too, a draft workflow could never be technically ready. Promotion still refuses it.
  const all = (ctx.review.attention ?? []).filter((a) => a.severity === "warn" && !(a.settledBy === "catalog-approval" && ctx.review.catalog !== undefined));
  // The job verdict has its own check (`job`); counted here too, one run would block twice.
  const strict = all.filter((a) => !a.text.startsWith(JOB_NOT_ACHIEVED_ATTENTION));
  const human = strict.filter((a) => a.ownerActions !== undefined && a.ownerActions.length > 0);
  const warns = strict.filter((a) => !human.includes(a));
  const awaiting = human.flatMap((a) => a.ownerActions!.map((action) => ({ check: "review-strict", journey: ctx.id, item: a.text, next: ownerActionCommand(ctx, action) })));
  if (warns.length > 0) {
    return {
      check: { check: "review-strict", journey: ctx.id, state: "fail", detail: warns.map((a) => a.text).join("; ") },
      blocker: { check: "review-strict", journey: ctx.id, why: warns.map((a) => a.text).join("; "), next: `jevitate journey review ${ctx.id} --strict` },
      awaiting,
    };
  }
  if (human.length > 0) {
    return { check: { check: "review-strict", journey: ctx.id, state: "awaiting-human", detail: `only a person's approval settles: ${human.map((a) => a.text).join("; ")}` }, awaiting };
  }
  return { check: { check: "review-strict", journey: ctx.id, state: "pass", detail: "no strict attention items" }, awaiting };
}

/**
 * Owner decision "Proof role" (2026-11-09): the job gates. The latest run's `job.attainment` (the review
 * sheet's `job`): `achieved` passes, `not-achieved` blocks (as `journey run` exits 1). `unverified` follows
 * doneCheckPolicy: `require` (the default) gates with the reason and the fix (exit 2, as `journey run`);
 * `advisory` shows it and does not gate. A harness target's `unverified` does not gate (as its run exits 0).
 */
function jobCheck(ctx: JourneyContext): { check: ReadinessCheck; blocker?: ReadinessBlocker } {
  const judged = ctx.replayJob ?? ctx.review.job ?? { attainment: "unverified" as const, basis: "no-run", doneCheckPolicy: DEFAULT_DONE_CHECK_POLICY };
  // M4: `achieved` counts only from a run whose own steps passed, read from that same run (outcome and job of one record).
  const job: typeof judged = judged.attainment === "achieved" && judged.outcome !== "ok" ? { ...judged, attainment: "unverified", basis: "run-not-passed" } : judged;
  const run = `jevitate journey run ${ctx.id} --env <non-production>`;
  const when = ctx.replayJob !== undefined ? " (this readiness replay)" : job.at === undefined ? "" : ` (latest run ${job.at})`;
  if (job.attainment === "achieved") {
    return { check: { check: "job", journey: ctx.id, state: "pass", detail: `achieved: the done check read false before the latest run and true after it, in a fresh session${when}` } };
  }
  if (job.attainment === "not-achieved") {
    const why = `the job was not achieved: the done check read false before the latest run and still false after it, in a fresh session${when}`;
    return { check: { check: "job", journey: ctx.id, state: "fail", detail: why }, blocker: { check: "job", journey: ctx.id, why, next: run } };
  }
  const reason = JOB_UNVERIFIED_REASON[job.basis] ?? `job attainment is unverified (${job.basis})`;
  const detail = `unverified (${job.basis}): ${reason}${when}`;
  if (job.doneCheckPolicy === "advisory" || job.basis === "harness") {
    return { check: { check: "job", journey: ctx.id, state: "not-run", detail: `${detail}; ${job.basis === "harness" ? "a harness target's pass" : "doneCheckPolicy advisory"}: it does not gate`, advisory: true } };
  }
  const fix =
    job.basis === "no-check" ? `add a "done" check to the linked job in .jevitate/jobs.json, then ${run} (or set doneCheckPolicy "advisory" in .jevitate/project.json)`
    : job.basis === "already-true" ? `reset the app so the done check reads false, then ${run}`
    : run;
  const state: ReadinessCheckState = job.basis === "no-run" || job.basis === "earlier-version" ? "not-run" : "inconclusive";
  return { check: { check: "job", journey: ctx.id, state, detail: `${detail}; doneCheckPolicy require: a pass that cannot say the job happened does not count` }, blocker: { check: "job", journey: ctx.id, why: `job attainment unverified: ${reason}`, next: fix } };
}

/** Why a job reads `unverified`, by its basis (code tokens to words; never a value). */
const JOB_UNVERIFIED_REASON: Readonly<Record<string, string>> = {
  "no-run": "no run of this Journey is recorded",
  "earlier-version": "the latest run was of an earlier version of this Journey",
  "not-recorded": "the latest run's record predates job verdicts",
  "no-check": "the latest run had no done check (its linked job declares none, or it ran with --no-done-check)",
  "already-true": "the done check already read true before the latest run, so it proves nothing",
  "reading-unknown": "a done-check reading could not be taken on the latest run",
  harness: "the latest run was on a harness target, which forces unverified",
  "run-not-passed": "the run's own steps did not pass, so its done check does not count",
  "replay-no-verdict": "the readiness replay gave no job verdict (it did not finish, or no done check was read)",
};

/** Every step objective written; a missing one is a person's annotation to draft. */
function annotationsCheck(ctx: JourneyContext): { check: ReadinessCheck; awaiting: ReadinessAwaitingHuman[] } {
  const missing = ctx.review.summary.missingIntent;
  if (missing.length === 0) return { check: { check: "annotations", journey: ctx.id, state: "pass", detail: "every step has an objective" }, awaiting: [] };
  return {
    check: { check: "annotations", journey: ctx.id, state: "awaiting-human", detail: `${missing.length} intent gap(s)` },
    awaiting: missing.map((item) => ({ check: "annotations", journey: ctx.id, item, next: `jevitate journey annotate ${ctx.id}` })),
  };
}

/** #433: the job/persona links resolve; a draft/stale approval is a person's call. */
function catalogCheck(ctx: JourneyContext): { check: ReadinessCheck; blocker?: ReadinessBlocker; awaiting: ReadinessAwaitingHuman[] } {
  const links = ctx.review.catalog;
  if (links === undefined) return { check: { check: "catalog", journey: ctx.id, state: "not-run", detail: "the catalog was not loaded" }, awaiting: [] };
  const dangling: string[] = [];
  for (const [kind, link] of [["job", links.job], ["persona", links.persona]] as const) {
    if (link !== undefined && link.status === "unknown") dangling.push(`${kind}:${link.id}`);
  }
  if (dangling.length > 0) {
    return {
      check: { check: "catalog", journey: ctx.id, state: "fail", detail: `dangling link(s): ${dangling.join(", ")}` },
      blocker: { check: "catalog", journey: ctx.id, why: `dangling link(s): ${dangling.join(", ")}`, next: `jevitate journey link ${ctx.id} --job <job-id> --persona <persona-id>` },
      awaiting: [],
    };
  }
  if (!links.linked) {
    return {
      check: { check: "catalog", journey: ctx.id, state: "fail", detail: "no job/persona link declared" },
      blocker: { check: "catalog", journey: ctx.id, why: "no job/persona link declared", next: `jevitate journey link ${ctx.id} --job <job-id> --persona <persona-id>` },
      awaiting: [],
    };
  }
  if (links.unvetted.length > 0) {
    return {
      check: { check: "catalog", journey: ctx.id, state: "awaiting-human", detail: links.unvetted.join(", ") },
      awaiting: links.unvetted.map((item) => ({
        check: "catalog",
        journey: ctx.id,
        item,
        next: item.startsWith("job:") ? `jevitate job review ${item.slice("job:".length)}` : `jevitate persona review ${item.slice("persona:".length)}`,
      })),
    };
  }
  return { check: { check: "catalog", journey: ctx.id, state: "pass", detail: "links resolve and are approved" }, awaiting: [] };
}

/**
 * The `.verify/<id>.json` proof record, and the freshness rule shared with the review sheet. Owner decision
 * "Proof role": under `mutationProofPolicy: advisory` (the default) a missing, stale or insensitive proof is
 * the checks-strength line, and so is an unwaived `inconclusive` attempt (owner clarification, 2026-11-09):
 * shown with its state, never a blocker. `require-attempt` / `require-sensitive` gate on it as before.
 */
function proofCheck(ctx: JourneyContext, journeysDir: string, cwd: string): { check: ReadinessCheck; blocker?: ReadinessBlocker } {
  const gated = proofCheckOf(ctx, journeysDir, cwd);
  if ((ctx.review.proof.policy?.mode ?? "advisory") !== "advisory") return gated;
  // Owner clarification (2026-11-09): an unwaived `inconclusive` attempt does not gate either; its authoring
  // guidance stays on the line, so the warning still says how to make the proof conclusive.
  const guidance = gated.check.state === "inconclusive" && gated.blocker !== undefined ? `; to make it conclusive: ${gated.blocker.why}` : "";
  const detail = gated.check.state === "pass" ? gated.check.detail : `${gated.check.detail}${guidance} (mutationProofPolicy advisory: checks strength only, it does not gate)`;
  return { check: { ...gated.check, detail, advisory: true } };
}

function proofCheckOf(ctx: JourneyContext, journeysDir: string, cwd: string): { check: ReadinessCheck; blocker?: ReadinessBlocker } {
  const verify = ctx.review.proof.verify;
  const evidence = relativeEvidence(cwd, verifyRecordPath(journeysDir, ctx.id));
  const policy = ctx.review.proof.policy;
  if (policy !== undefined && (policy.mode !== "advisory" || policy.waiver.status === "valid")) {
    return policy.passed
      ? { check: { check: "proof", journey: ctx.id, state: "pass", detail: policy.reason, evidence } }
      : { check: { check: "proof", journey: ctx.id, state: policy.freshness === "stale" ? "stale" : policy.freshness === "missing" ? "not-run" : policy.verdict === "insensitive" ? "fail" : "inconclusive", detail: policy.reason, evidence }, blocker: { check: "proof", journey: ctx.id, why: policy.reason, next: policy.next } };
  }
  if (verify.status === "not-verified") {
    return {
      check: { check: "proof", journey: ctx.id, state: "not-run", detail: verify.hint },
      blocker: { check: "proof", journey: ctx.id, why: "no mutation proof recorded", next: `jevitate journey verify ${ctx.id} --mutate` },
    };
  }
  if (verify.stale) {
    // #816: only a changed Journey is blamed on the Journey.
    const engine = verify.staleCause === "engine";
    const by = verify.recordedBy === undefined ? "" : ` (${verify.recordedBy.version}, ${verify.recordedBy.commit})`;
    const detail = engine
      ? `the ${verify.verdict} proof at ${verify.at} was recorded by another jevitate engine${by}: the Journey is unchanged, but this engine computes its proof identity differently`
      : verify.staleCause === "engine-unknown" ? `the ${verify.verdict} proof at ${verify.at} does not match this engine, and its receipt does not say which engine recorded it; the Journey is unchanged`
      : verify.staleCause === "read-policy" ? `the ${verify.verdict} proof at ${verify.at} ran under other safety.readRequests` : `the ${verify.verdict} proof at ${verify.at} is bound to older content`;
    return {
      check: { check: "proof", journey: ctx.id, state: "stale", detail, evidence },
      blocker: {
        check: "proof",
        journey: ctx.id,
        why: engine ? "the recorded proof comes from another engine version (the Journey did not change)" : "the recorded proof is stale",
        next: engine ? `review with the jevitate version that recorded the proof, or jevitate journey verify ${ctx.id} --mutate` : `jevitate journey verify ${ctx.id} --mutate`,
      },
    };
  }
  if (verify.verdict === "sensitive") {
    // #609: `targeted` is a subset of `sensitive`, not a seventh outcome — summing every count
    // would double-count it. It is named separately, never added to the sensitive total.
    const targeted = verify.summary.targeted ?? 0;
    const passed = Object.entries(verify.summary).filter(([k]) => k !== "targeted").reduce((a, [, b]) => a + b, 0);
    // §5.1: a proof whose target cannot be reset (or a receipt from before 0.30.0) is reported with countsForGate false.
    const gate = verify.countsForGate === true ? "countsForGate true" : "countsForGate false: a proof's strength depends on a target you can reset";
    const detail = `checks strength: ${targeted === 0 ? `sensitive ${passed}/${passed}` : `sensitive ${passed}/${passed}, ${targeted} through a targeted proof (earlier defenses relaxed one at a time; see the verify report)`}; ${gate}`;
    return { check: { check: "proof", journey: ctx.id, state: "pass", detail, evidence } };
  }
  if (verify.verdict === "insensitive") {
    return {
      check: { check: "proof", journey: ctx.id, state: "fail", detail: verify.reason ?? "some checks cannot fail", evidence },
      blocker: { check: "proof", journey: ctx.id, why: verify.reason ?? "some checks cannot fail", next: `jevitate journey verify ${ctx.id} --mutate` },
    };
  }
  // #609: an inconclusive proof stays inconclusive — the refusal names the authoring fix, not a pass.
  // #616: a recorded proof carries the declared plans the automatic bound refused.
  const suggested = verify.status === "recorded" ? verify.suggestedTargetedProofs : undefined;
  return {
    check: { check: "proof", journey: ctx.id, state: "inconclusive", detail: verify.reason ?? `proof verdict ${verify.verdict}`, evidence },
    blocker: { check: "proof", journey: ctx.id, why: inconclusiveProofGuidance(verify.reason ?? "", suggested), next: `jevitate journey verify ${ctx.id} --mutate` },
  };
}

/** #609: the marker the adjudicator's proof verdict puts before a refused targeted proof's own refusal text. */
const TARGETED_REFUSAL_MARKER = "a targeted proof was refused: ";

/**
 * #609: the authoring guidance a refused targeted proof carries, chosen from the refusal text (names
 * only — a refusal never contains a param value, a record field or reply text). A proof that stays
 * inconclusive for any other reason gets the generic cascade guidance.
 */
function inconclusiveProofGuidance(reason: string, suggested?: readonly JourneyTargetedProofPlan[]): string {
  const at = reason.indexOf(TARGETED_REFUSAL_MARKER);
  if (at < 0) return "inspect the cascade assertions in the verify report";
  const refusal = reason.slice(at + TARGETED_REFUSAL_MARKER.length).trim();
  const unpaired = /^(\S+) is not paired with (\S+)$/.exec(refusal);
  if (unpaired !== null) {
    return `declare the earlier check ${unpaired[1]} as a defense of ${unpaired[2]} with a metadata.mutationPairs entry {check:'${unpaired[1]}', mustFailWhen:'${unpaired[2]}'}, then re-run verify`;
  }
  const bound = /relaxation bound (\d+)/.exec(refusal);
  if (bound !== null) {
    // #616: a declared plan lets a human review the earlier relaxations the automatic bound refused.
    const first = suggested?.[0];
    const plan =
      first === undefined
        ? `declare a metadata.targetedProofs plan (at most ${MAX_DECLARED_RELAXATIONS} earlier postconditions)`
        : `declare exactly this metadata.targetedProofs entry: ${JSON.stringify(first)} — a human reviews it like any other proof change (the review hash changes, so the Journey needs re-approval)`;
    return `${plan}, then re-run verify (relaxation bound ${bound[1]})`;
  }
  const blocked = /^(\S+) blocked the declared proof \(not in relax\)$/.exec(refusal);
  if (blocked !== null) return `add ${blocked[1]} to that plan's relax list (metadata.targetedProofs), then re-run verify`;
  const unsound = /^relaxed site (\S+) is not itself proven sensitive to (\S+)$/.exec(refusal);
  if (unsound !== null) return `pair ${unsound[1]} with ${unsound[2]} (metadata.mutationPairs) or make it a real defense, then re-run verify`;
  if (refusal.includes("action failed")) return "the mutated value makes an earlier action impossible, so that target cannot be proven independently — keep the check; it stays inconclusive by design";
  return "inspect the cascade assertions in the verify report";
}

function relativeEvidence(cwd: string, path: string): string {
  const r = relative(cwd, path);
  return r === "" || r.startsWith("..") ? path : r.split(sep).join("/");
}

/** `review` promoted with an approval that still binds the current review hash. */
function promotionCheck(ctx: JourneyContext): { check: ReadinessCheck; awaiting: ReadinessAwaitingHuman[] } {
  const change = ctx.review.changeSinceApproval;
  const stale = (change.kind === "diff" || change.kind === "snapshot-missing") && change.changed;
  const current = ctx.journey.metadata.promoted && ctx.journey.metadata.approval !== undefined && !stale;
  if (current) return { check: { check: "promotion", journey: ctx.id, state: "pass", detail: "promoted with a current approval" }, awaiting: [] };
  const why = !ctx.journey.metadata.promoted ? "not promoted" : stale ? "approval is stale (the Journey changed since it was approved)" : "no recorded approval";
  return {
    check: { check: "promotion", journey: ctx.id, state: "awaiting-human", detail: why },
    awaiting: [{ check: "promotion", journey: ctx.id, item: why, next: `jevitate journey promote ${ctx.id}` }],
  };
}

function replayCheck(ctx: JourneyContext, outcome: ReplayOutcome): { check: ReadinessCheck; blocker?: ReadinessBlocker } {
  const next = `jevitate journey run ${ctx.id}`;
  const check: ReadinessCheck = { check: "replay", journey: ctx.id, state: outcome.state, detail: outcome.detail };
  return outcome.state === "pass" ? { check } : { check, blocker: { check: "replay", journey: ctx.id, why: outcome.detail, next } };
}

/** The #583 handback state, as `journey run` reports it. */
function handbackOutcome(state: HandbackOutcome["state"]): ReplayOutcome {
  switch (state) {
    case "prepared":
      return { state: "pass", detail: "the run stopped at its prepare-only boundary" };
    case "submitted":
      return { state: "fail", detail: "the run submitted the irreversible action (a prepare-only boundary must stop before it)" };
    case "inconclusive":
      return { state: "inconclusive", detail: "the handback state is inconclusive" };
    default:
      return { state: "fail", detail: `the handback state is ${state}` };
  }
}

function oneJourneyReplay(result: { outcome: string; reason?: string; handback?: HandbackOutcome }): ReplayOutcome {
  if (result.outcome === "ok") {
    return result.handback === undefined ? { state: "pass", detail: "the recorded replay held" } : handbackOutcome(result.handback.state);
  }
  if (result.outcome === "quarantined") return { state: "fail", detail: result.reason ?? "the replay diverged" };
  if (result.outcome === "inconclusive") return { state: "inconclusive", detail: result.reason ?? "the replay had no verdict" };
  return { state: "fail", detail: `the replay ended ${result.outcome}` };
}

/** #624: the first rejection as `<key>: <field> <code>` — keys, field names and codes only, never values. */
function firstRejection(result: JourneyChainResult): string | undefined {
  const rejection = result.rejected?.[0];
  if (rejection === undefined) return undefined;
  const error = rejection.errors[0];
  return error === undefined ? rejection.key : `${rejection.key}: ${error.field} ${error.code}`;
}

function pairReplay(result: JourneyChainResult): ReplayOutcome {
  if (chainSucceeded(result)) return { state: "pass", detail: "the chain held for every request" };
  if (result.runs.some((r) => r.outcome === "inconclusive")) return { state: "inconclusive", detail: "a chained run had no verdict" };
  const counts = `${result.unmatched.length} unmatched request(s), ${result.rejected?.length ?? 0} rejected, ${result.runs.filter((r) => r.outcome !== "ok").length} failed run(s)`;
  const first = firstRejection(result);
  return { state: "fail", detail: first === undefined ? counts : `${counts}; first rejection ${first}` };
}

function verdictOf(all: readonly ReadinessCheck[], mode: ReadinessMode): ReadinessVerdict {
  // Owner decision "Proof role": an advisory check is shown, never counted.
  const checks = all.filter((c) => c.advisory !== true);
  if (checks.some((c) => c.state === "fail")) return "blocked";
  if (checks.some((c) => c.state === "inconclusive")) return "inconclusive";
  const requiredReplay = mode !== "report";
  const required = checks.filter((c) => REQUIRED_CHECKS.has(c.check) || (requiredReplay && c.check === "replay"));
  if (required.some((c) => c.state === "stale" || c.state === "not-run")) return "incomplete";
  return "technically-ready";
}

function commandsFor(verdict: ReadinessVerdict, mode: ReadinessMode, id: string, blockers: readonly ReadinessBlocker[], awaiting: readonly ReadinessAwaitingHuman[]): string[] {
  const next: string[] = [];
  const add = (command: string): void => void (command !== "" && !next.includes(command) && next.push(command));
  if (verdict === "blocked") {
    for (const b of blockers) add(b.next);
    return next;
  }
  // The job's fix comes first: until a run says the job happened, promotion is not what is next.
  for (const b of blockers) if (b.check === "job") add(b.next);
  if (mode !== "prove") add(`jevitate journey readiness ${id} --mode prove`);
  if (verdict === "technically-ready") add(`jevitate journey promote ${id}`);
  for (const a of awaiting) add(a.next);
  return next;
}

/**
 * #581: one Journey's (or a linked pair's) readiness receipt. Static checks only in `report`; the
 * baseline replay in `replay`/`prove`; fresh mutation proofs in `prove`. Experience reuse is the
 * existing rule: a proof is fresh only while it binds the current review hash.
 */
export async function runJourneyReadiness(opts: JourneyReadinessOptions, deps: JourneyReadinessDeps = {}): Promise<ReadinessReceipt> {
  const mode = opts.mode ?? "report";
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const review = deps.review ?? reviewJourneyById;
  const run = deps.run ?? runJourneyProgrammatically;
  const chain = deps.chain ?? runJourneyChain;
  const verify = deps.verify ?? verifyJourneyMutations;
  const reviewOpts = { strict: true, ...(opts.catalogDir === undefined ? {} : { catalogDir: opts.catalogDir }), ...(opts.targetsFile === undefined ? {} : { targetsFile: opts.targetsFile }) } as const;

  const contexts: JourneyContext[] = [];
  const loaded = await review(opts.journeysDir, opts.id, reviewOpts);
  contexts.push({ id: opts.id, journey: loaded.journey, review: loaded.review });
  if (opts.with !== undefined) {
    const consumer = await review(opts.journeysDir, opts.with, reviewOpts);
    contexts.push({ id: opts.with, journey: consumer.journey, review: consumer.review });
  }

  const pair = opts.with !== undefined;
  let environment: ResolvedJourneyEnvironment | undefined;
  let replay: ReplayOutcome | undefined;
  /** #608: the params the chain bound for the first consumer (`to`) run, captured via the runner seam. */
  let boundConsumerParams: Record<string, string> | undefined;
  /** #624: the pair chain's result, kept in scope so the prove hint can name a rejection. */
  let chained: JourneyChainResult | undefined;
  // M4: in replay/prove the job is the replay's own: each run reads its done check in a scope, as `journey run`.
  const catalogDir = opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir;
  const replayJobs = new Map<string, NonNullable<JourneyReview["job"]>>();
  const withJob = async (o: RunJourneyProgrammaticallyOptions): Promise<Awaited<ReturnType<typeof run>>> => {
    const scope = new DoneCheckRun({
      catalogDir,
      journeysDir: opts.journeysDir,
      ...(o.environment?.baseUrl === undefined ? {} : { origin: o.environment.baseUrl }),
      ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
      ...(opts.browserPortFactory === undefined ? {} : { sessionPortFactory: opts.browserPortFactory }),
    });
    const result = await scope.run(() => run(o));
    if (!replayJobs.has(o.id)) {
      // A result that already carries its verdict (a surface that folded it) is that run's own.
      const carried = (result as { job?: JobVerdict }).job;
      const job = carried ?? scope.job;
      const outcome = /^[a-z-]{1,40}$/.test(result.outcome) ? { outcome: result.outcome } : {};
      const policy = contexts.find((c) => c.id === o.id)?.review.job?.doneCheckPolicy ?? doneCheckPolicyOf(catalogDir);
      replayJobs.set(o.id, job === undefined ? { attainment: "unverified", basis: "replay-no-verdict", doneCheckPolicy: policy, ...outcome } : { attainment: job.attainment, basis: job.basis, doneCheckPolicy: policy, at: clock.nowIso(), ...outcome });
    }
    return result;
  };
  if (mode !== "report") {
    const producerSchema = journeyParamSchema(contexts[0]!.journey).required;
    environment = resolveTarget(opts, deps, requiredParams(contexts[0]!.journey, pair, opts.requests !== undefined), producerSchema);
    const params = { ...(opts.params ?? {}) };
    try {
      if (pair) {
        chained = await chain(
          {
            from: opts.id,
            to: opts.with as string,
            requests: opts.requests ?? "",
            params: { ...(opts.params ?? {}) },
            dir: opts.journeysDir,
            environment,
            ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
            ...(opts.browser === undefined ? {} : { browser: opts.browser }),
            ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
          },
          {
            // #608: the consumer's proof must run with the params the chain actually bound for it
            // (record fields + request), captured from the first consumer run; names and outcomes
            // are all the chain itself returns.
            runJourney: async (chainOpts) => {
              const result = await withJob(chainOpts);
              if (chainOpts.id === opts.with && boundConsumerParams === undefined) {
                boundConsumerParams = { ...chainOpts.params };
              }
              return result;
            },
          },
        );
        replay = pairReplay(chained);
      } else {
        const result = await withJob({
          dir: opts.journeysDir,
          id: opts.id,
          params,
          environment,
          ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
          ...(opts.browser === undefined ? {} : { browser: opts.browser }),
          ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
          ...(opts.fixtures === undefined ? {} : { fixtures: opts.fixtures(opts.id, environment) }),
        });
        replay = oneJourneyReplay(result as { outcome: string; reason?: string; handback?: HandbackOutcome });
      }
    } catch (err) {
      replay = { state: "inconclusive", detail: err instanceof Error ? err.message : String(err) };
    }
    if (mode === "prove") {
      for (const ctx of contexts) {
        const consumer = pair && ctx.id === opts.with;
        if (consumer && boundConsumerParams === undefined) {
          // #608/#624: the chain bound no request for the consumer, so no proof can run. When the
          // chain rejected a record, the hint names that rejection; otherwise it asks for a
          // matching request. Either way it names only the consumer and keys/fields/codes — never
          // a param value, a record field value or reply text.
          const rejection = chained === undefined ? undefined : firstRejection(chained);
          const hint = rejection === undefined
            ? `the chain bound no request for '${ctx.id}' — supply a --requests line that matches a discovered record`
            : `the chain rejected the consumer's matching record (${rejection})`;
          ctx.review = {
            ...ctx.review,
            proof: {
              ...ctx.review.proof,
              verify: { status: "not-verified", hint },
            },
          };
          continue;
        }
        const proofParams = consumer ? (boundConsumerParams as Record<string, string>) : params;
        try {
          // #763: as this receipt's review classified the Journey's writes. An unreadable targets file already refused that review.
          const readRequests = journeyReadRequests(ctx.journey, opts.targetsFile === undefined ? {} : { targetsFile: opts.targetsFile });
          await verify({
            dir: opts.journeysDir,
            id: ctx.id,
            params: proofParams,
            ...(readRequests === undefined ? {} : { readRequests }),
            environment,
            ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
          ...(opts.browser === undefined ? {} : { browser: opts.browser }),
          ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
            ...(opts.fixtures === undefined ? {} : { fixtures: opts.fixtures(ctx.id, environment) }),
          });
        } catch (err) {
          // A proof the host could not run leaves the existing evidence in place (never a crash).
          ctx.review = { ...ctx.review, proof: { ...ctx.review.proof, verify: { status: "not-verified", hint: err instanceof Error ? err.message : String(err) } } };
          continue;
        }
        // Re-read the freshly recorded proof through the same sheet the verdict is computed from.
        const refreshed = await review(opts.journeysDir, ctx.id, reviewOpts);
        ctx.review = refreshed.review;
      }
    }
  }

  const checks: ReadinessCheck[] = [];
  const blockers: ReadinessBlocker[] = [];
  const awaiting: ReadinessAwaitingHuman[] = [];
  const push = (r: { check: ReadinessCheck; blocker?: ReadinessBlocker; awaiting?: ReadinessAwaitingHuman[] }): void => {
    checks.push(r.check);
    if (r.blocker !== undefined) blockers.push(r.blocker);
    if (r.awaiting !== undefined) awaiting.push(...r.awaiting);
  };

  if (mode !== "report") {
    // M4: never an earlier run's verdict here; a Journey the replay did not reach has none.
    for (const ctx of contexts) {
      ctx.replayJob = replayJobs.get(ctx.id) ?? { attainment: "unverified", basis: "replay-no-verdict", doneCheckPolicy: ctx.review.job?.doneCheckPolicy ?? doneCheckPolicyOf(catalogDir) };
    }
  }
  for (const ctx of contexts) {
    // Owner decision "Proof role": the receipt leads with the job verdict.
    push(jobCheck(ctx));
    push({ check: schemaCheck(ctx) });
    push(lintCheck(ctx, opts.projectDir));
    if (pair && ctx.id === opts.id) push(handoffCheck(contexts[0]!, contexts[1]!));
    push({ check: boundaryCheck(ctx) });
    push(reviewStrictCheck(ctx));
    push(annotationsCheck(ctx));
    push(catalogCheck(ctx));
    push(proofCheck(ctx, opts.journeysDir, cwd));
    if (mode !== "report") push(replayCheck(ctx, replay ?? { state: "not-run", detail: "the replay did not run" }));
    push(promotionCheck(ctx));
  }

  const verdict = verdictOf(checks, mode);
  const engineInfo = currentEngineInfo();
  const target: ReadinessTarget | null = environment === undefined ? null : { origin: environment.baseUrl, ...(environment.name === undefined ? {} : { env: environment.name }) };
  return {
    engine: { version: engineInfo.version, commit: engineInfo.commit, tree: currentBuildTree() },
    mode,
    target,
    journeys: contexts.map((ctx) => ({ id: ctx.id, contentHash: journeyContentHash(ctx.journey), reviewHash: ctx.review.contentHash, promoted: ctx.journey.metadata.promoted })),
    checks,
    verdict,
    blockers,
    awaitingHuman: awaiting,
    next: commandsFor(verdict, mode, opts.id, blockers, awaiting),
  };
}
