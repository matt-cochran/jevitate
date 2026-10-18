import { relative, sep } from "node:path";
import {
  checkCompatibility,
  journeyParamSchema,
  lintJourney,
  type HandbackOutcome,
  type Journey,
  type JourneyLintFinding,
  type JourneyReview,
} from "@jevitate/journey";
import { currentBuildTree, currentEngineInfo } from "./engine.js";
import { environmentFromFlags, type ResolvedJourneyEnvironment } from "./environments.js";
import { runJourneyChain, chainSucceeded, type JourneyChainResult } from "./journey-chain.js";
import { journeyContentHash } from "./journey-annotate-api.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { verifyRecordPath } from "./journey-review-store.js";
import { verifyJourneyMutations } from "./journey-verify.js";
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
}

interface ReplayOutcome {
  readonly state: ReadinessCheckState;
  readonly detail: string;
}

const REQUIRED_PROOF_CHECK = "proof";

/** #581 §1: the target shared by `replay` and `prove`, refused in this order before any runner call. */
function resolveTarget(opts: JourneyReadinessOptions, deps: JourneyReadinessDeps, required: readonly string[]): ResolvedJourneyEnvironment {
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

/** `journey review --strict`: every `warn` attention item is a blocker (an `info` item is advice, not a gate). */
function reviewStrictCheck(ctx: JourneyContext): { check: ReadinessCheck; blocker?: ReadinessBlocker } {
  const warns = (ctx.review.attention ?? []).filter((a) => a.severity === "warn");
  if (warns.length > 0) {
    return {
      check: { check: "review-strict", journey: ctx.id, state: "fail", detail: warns.map((a) => a.text).join("; ") },
      blocker: { check: "review-strict", journey: ctx.id, why: warns.map((a) => a.text).join("; "), next: `jevitate journey review ${ctx.id} --strict` },
    };
  }
  return { check: { check: "review-strict", journey: ctx.id, state: "pass", detail: "no strict attention items" } };
}

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

/** The `.verify/<id>.json` proof record, and the freshness rule shared with the review sheet. */
function proofCheck(ctx: JourneyContext, journeysDir: string, cwd: string): { check: ReadinessCheck; blocker?: ReadinessBlocker } {
  const verify = ctx.review.proof.verify;
  const evidence = relativeEvidence(cwd, verifyRecordPath(journeysDir, ctx.id));
  if (verify.status === "not-verified") {
    return {
      check: { check: "proof", journey: ctx.id, state: "not-run", detail: verify.hint },
      blocker: { check: "proof", journey: ctx.id, why: "no mutation proof recorded", next: `jevitate journey verify ${ctx.id} --mutate` },
    };
  }
  if (verify.stale) {
    return {
      check: { check: "proof", journey: ctx.id, state: "stale", detail: `the ${verify.verdict} proof at ${verify.at} is bound to older content`, evidence },
      blocker: { check: "proof", journey: ctx.id, why: "the recorded proof is stale", next: `jevitate journey verify ${ctx.id} --mutate` },
    };
  }
  if (verify.verdict === "proven") {
    const passed = Object.values(verify.summary).reduce((a, b) => a + b, 0);
    return { check: { check: "proof", journey: ctx.id, state: "pass", detail: `proven ${passed}/${passed}`, evidence } };
  }
  if (verify.verdict === "insensitive") {
    return {
      check: { check: "proof", journey: ctx.id, state: "fail", detail: verify.reason ?? "some checks cannot fail", evidence },
      blocker: { check: "proof", journey: ctx.id, why: verify.reason ?? "some checks cannot fail", next: `jevitate journey verify ${ctx.id} --mutate` },
    };
  }
  return { check: { check: "proof", journey: ctx.id, state: "inconclusive", detail: verify.reason ?? `proof verdict ${verify.verdict}`, evidence } };
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

function pairReplay(result: JourneyChainResult): ReplayOutcome {
  if (chainSucceeded(result)) return { state: "pass", detail: "the chain held for every request" };
  if (result.runs.some((r) => r.outcome === "inconclusive")) return { state: "inconclusive", detail: "a chained run had no verdict" };
  return { state: "fail", detail: `${result.unmatched.length} unmatched request(s), ${result.runs.filter((r) => r.outcome !== "ok").length} failed run(s)` };
}

function verdictOf(checks: readonly ReadinessCheck[], mode: ReadinessMode): ReadinessVerdict {
  if (checks.some((c) => c.state === "fail")) return "blocked";
  if (checks.some((c) => c.state === "inconclusive")) return "inconclusive";
  const requiredReplay = mode !== "report";
  const required = checks.filter((c) => c.check === REQUIRED_PROOF_CHECK || (requiredReplay && c.check === "replay"));
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
  if (mode !== "report") {
    environment = resolveTarget(opts, deps, requiredParams(contexts[0]!.journey, pair, opts.requests !== undefined));
    const params = { ...(opts.params ?? {}) };
    try {
      if (pair) {
        const chained = await chain({
          from: opts.id,
          to: opts.with as string,
          requests: opts.requests ?? "",
          dir: opts.journeysDir,
          environment,
          ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
          ...(opts.browser === undefined ? {} : { browser: opts.browser }),
          ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
        });
        replay = pairReplay(chained);
      } else {
        const result = await run({
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
        try {
          await verify({
            dir: opts.journeysDir,
            id: ctx.id,
            params,
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

  for (const ctx of contexts) {
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
