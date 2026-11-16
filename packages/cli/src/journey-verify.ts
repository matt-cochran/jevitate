/**
 * #402 — `journey verify --mutate`: a built-in negative proof that each of a Journey's assertions
 * FAILS when its outcome is absent. The Journey is replayed as recorded (it must pass), then
 * once per mutation (`planJourneyMutations`: skip a write step, abort its writes, type an empty or
 * stale value into a checked fill, or — #565 — swap or truncate a checked non-secret parameter); each assertion is sensitive only when its paired mutation broke it, at
 * that assertion, with nothing failing before the mutated step.
 *
 * Every replay goes through `runJourneyProgrammatically` — the same path, gate, fixtures and
 * environment as `journey run`. Mutations never send, fabricate or answer a request: they leave a
 * step's action out, ABORT the app's own writes in one step's window, or type `""`.
 */
import { basename, join, relative } from "node:path";
import {
  FsJourneyStore,
  JourneyRegistry,
  assertionSiteKey,
  classifyReplay,
  controlCanChangeVerdict,
  declaredTargetedProofFor,
  flatJourneySteps,
  heldSites,
  journeyAssertions,
  ParamValidationError,
  journeyEndState,
  journeyParamSchema,
  journeyWriteSteps,
  mutationReplay,
  mutationWriteMatches,
  needsRelaxedReplay,
  needsFinalNetworkObservation,
  paceBeforeMutationMs,
  paceEndStateFloorMs,
  paceFloorMs,
  paceMarginBoundMs,
  paceMarginOf,
  paceTailMs,
  pacedReplay,
  planJourneyMutations,
  endStateIsolationNotes,
  relaxedMutationReplay,
  runDeclaredTargetedProof,
  runTargetedProof,
  siblingDisagreements,
  sitesReachedEarly,
  sitesUnmatchedBy,
  suggestTargetedProofPlan,
  targetedMutationReplay,
  thinSites,
  secretParamNames,
  secretParamValues,
  validateParams,
  type AssertionVerdict,
  type AssertionProof,
  type Journey,
  type JourneyMutation,
  type JourneyTargetedProofPlan,
  type MutationFailedSite,
  type MutationReplay,
  type MutationRunResult,
  type ReplayPace,
  type SiteArrivals,
  type TargetedProof,
} from "@jevitate/journey";
import { proofVerdictFields, type LegacyMutationProofVerdict, type MutationProofVerdict } from "./journey-verify-report.js";
import { adjudicate, classifyMutation, isolationNoteReason, mutationErrored, type Known, type RunEvidence } from "@jevitate/adjudicator";
import { DEFAULT_STEP_RESPONSE_TIMEOUT_MS, describeCheck, evaluateNetworkCheckAwaiting, monitorFor, type BlockedWrite, type RequestCapture } from "@jevitate/explore";
import { clock } from "@jevitate/domain";
import { checkAssertion, waitForOutcome, type StepObserver } from "@jevitate/interpreter";
import { AssertionRefError, assertionRefs, resolveAssertionRefs } from "@jevitate/recording";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import {
  DEFAULT_ADMISSION_TIMEOUT_MS,
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_OPEN_TIMEOUT_MS,
  PlaywrightBrowserPort,
  pageUnresponsiveMsFromEnv,
  sharedResourceGovernor,
  type BrowserPort,
  type BrowserSession,
  type ResourceGovernor,
} from "@jevitate/playwright";
import { journeyContentHash } from "./journey-annotate-api.js";
import { evidenceParamsDigest } from "./journey-run-evidence.js";
import { proofEvidenceOf, type LedgerReplay, type ProofGathering } from "./journey-verify-evidence.js";
import { journeyReviewHash, type JourneyVerifyRecord } from "./journey-review.js";
import { carriesSecretValue, writeVerifyNativeReport } from "./journey-verify-evidence-file.js";
import { currentBuildTree, currentEngineInfo } from "./engine.js";
import { artifactStamp } from "./mission-journal.js";
import { preflightVerifyRecord, writePreflightedVerifyRecord } from "./journey-review-store.js";
import { UnknownJourneyError, effectiveAllowedOrigins, redactSecretValues, runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import type { OutcomeCheckFailure } from "./journey-network-checks.js";
import { journeyProofContext, journeyExecutionIdentity, type JourneyExecutionIdentity } from "./journey-proof-context.js";
import {
  JourneyVerifyResumeRefusedError,
  RETRY_REASON_NOT_KEPT,
  type IsolationNote,
  checkpointKeyPath,
  checkpointPairOf,
  checkpointReplayOf,
  isRepairableIsolation,
  openProofCheckpoint,
  readCheckpointKey,
  resumeRefusalAgainstBase,
  reusedProofFields,
  type CheckpointPair,
  type CheckpointReplay,
  type ProofCheckpointRequest,
  type ProofCheckpointSession,
  type ResumeState,
} from "./journey-verify-checkpoint.js";
import { composeObservers } from "./run-screenshots.js";
import { asProof, ProofHoldRefusedError } from "./journey-run-hooks.js";
import { noteMcpRefusal } from "./approval-provenance.js";
import { envAppVersion } from "./app-version.js";
import {
  ACTION_BOUND_MS,
  ABORTED_WRITE_GRACE_MS,
  FIXTURE_ALLOWANCE_MS,
  MAX_TIMER_MS,
  QUIET_GAP_MIN_MS,
  READ_METHODS,
  RELOAD_BOUND_MS,
  REPLAY_FLOOR_MS,
  REQUEST_LINE,
  SITE_GATE_WAIT_MS,
  STALL_MARGIN_MS,
  JourneyVerifyStalledError,
  WriteScope,
  finalObservation,
  lineOfRequest,
  relaxedWaitObserver,
  replayWithinBound,
  ReplayPacer,
  ReplayProbe,
  siteKeyOf,
  type FinalObservation,
  type JourneyVerifyProgress,
  type RelaxedSiteWait,
  type TargetedControlDiagnostics,
} from "./journey-verify-observer.js";
export { JourneyVerifyStalledError, type JourneyVerifyProgress } from "./journey-verify-observer.js";

/** `journey run`'s options a proof passes through to every replay (params, environment, auth, fixtures, browser, gate). */
export type VerifyJourneyOptions = Omit<
  RunJourneyProgrammaticallyOptions,
  "stopAfterStep" | "interpreter" | "observer" | "session" | "screenshots" | "actionDeltas" | "selfHealer" | "policy"
> & {
  /** Read patterns for the write classifier (as `journey lint`). */
  readonly readRequests?: readonly string[];
  /** M5: the app's release label the proof runs against (`--app-version`); default `JEVITATE_APP_VERSION` when valid. Bound into the receipt. */
  readonly appVersion?: string;
  /** Called as each replay starts, in order, targeted proofs' replays included. */
  readonly onProgress?: (progress: JourneyVerifyProgress) => void;
  /** The governor whose machine slot the proof keeps between replays (default: the process-wide one its replays open sessions through). */
  readonly slotGovernor?: ResourceGovernor;
  /** #787: keep durable progress for this proof, and with `resume` reuse the pairs an earlier run finished. */
  readonly checkpoint?: ProofCheckpointRequest;
  /**
   * #812: handed the proof's evidence record (`RunEvidence`, subject `mutation-proof`) the verdict was
   * adjudicated from, once the proof has its verdict. Value-free; its parameters are a keyed digest.
   */
  readonly onEvidence?: (evidence: RunEvidence) => void;
};

/** Hands a proof's bound the Journey it is sized from. */
export async function loadJourneyToVerify(dir: string, id: string): Promise<Journey> {
  const journey = await new JourneyRegistry(new FsJourneyStore(dir)).get(id);
  if (!journey) throw new UnknownJourneyError(`unknown journey '${id}'`);
  return journey;
}

function admissionBoundMs(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env["JEVITATE_ADMISSION_TIMEOUT_MS"]);
  return Number.isInteger(set) && set > 0 ? set : DEFAULT_ADMISSION_TIMEOUT_MS;
}

/**
 * The longest a proof can legally go between two replays' progress: a machine-slot admission wait,
 * then the longest legal single replay of THIS Journey, each step at its worst. A sum of worst cases,
 * so it is far above a typical replay. It limits silence and never the whole run: a proof whose
 * replays keep starting is never ended, however long it takes (#778).
 */
export function proofInactivityMs(journey: Journey, opts: Pick<VerifyJourneyOptions, "stepResponseTimeoutMs"> = {}): number {
  const responseDefault = opts.stepResponseTimeoutMs ?? DEFAULT_STEP_RESPONSE_TIMEOUT_MS;
  let replay = DEFAULT_OPEN_TIMEOUT_MS + pageUnresponsiveMsFromEnv() + DEFAULT_CLOSE_TIMEOUT_MS + FIXTURE_ALLOWANCE_MS;
  let longestStepMs = 0;
  for (const { recorded } of flatJourneySteps(journey)) {
    const wait = "waitFor" in recorded.step ? recorded.step.waitFor : undefined;
    // A relaxed site's kept response wait (`RelaxedSiteWait`) runs per request check, one after another.
    let stepMs = ACTION_BOUND_MS + SITE_GATE_WAIT_MS + RELOAD_BOUND_MS + (recorded.responseTimeoutMs ?? responseDefault) * Math.max(1, recorded.expectRequests?.length ?? 0);
    // A wait's last poll can start just before `maxMs` and still reload.
    if (wait !== undefined) stepMs += wait.maxMs + ACTION_BOUND_MS;
    replay += stepMs;
    longestStepMs = Math.max(longestStepMs, stepMs);
  }
  // Only a Journey with steps is paced: its floors' margin, and waiting for open writes before its end state and its close.
  if (longestStepMs > 0) replay += paceMarginBoundMs(longestStepMs) + 2 * (Math.max(responseDefault, longestStepMs) + ABORTED_WRITE_GRACE_MS);
  replay += journeyEndState(journey).length * (ACTION_BOUND_MS + RELOAD_BOUND_MS);
  return Math.min(admissionBoundMs() + Math.max(REPLAY_FLOOR_MS, replay), MAX_TIMER_MS - STALL_MARGIN_MS);
}

export interface JourneyVerifyMutation {
  readonly kind: JourneyMutation["kind"];
  readonly step: number;
  readonly id: string;
  /** #565: the parameter a `swap-param`/`truncate-param` altered (its name, never a value). */
  readonly param?: string;
  /** #579: where a `swap-param`'s wrong value came from (`reviewed`, `option`, `generated`), never the value. */
  readonly source?: JourneyMutation["source"];
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  /** block-write: what was aborted (`METHOD path`). */
  readonly blockedWrites?: readonly string[];
  /** Why the replay failed, was not applied, or errored. */
  readonly reason?: string;
  /**
   * #554 — the same mutation replayed with the mutated step's own postcondition relaxed, present
   * only when the first replay failed at that postcondition and a later site is paired with it.
   */
  readonly relaxed?: {
    readonly outcome: MutationRunResult["outcome"];
    readonly failedSites: readonly MutationFailedSite[];
    readonly blockedWrites?: readonly string[];
    readonly reason?: string;
    /** Sites this replay failed at sooner than the base replay passed them, so its failure counts for nothing. */
    readonly waitsCut?: readonly string[];
    readonly atBaseTime?: MutationRunResult["atBaseTime"];
  };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
  /** Sites this replay failed at sooner than the base replay passed them, so its failure counts for nothing. */
  readonly waitsCut?: readonly string[];
  /** How the fresh unmutated replay ended, when a site this mutation read sensitive had little to spare over the base replay. */
  readonly control?: MutationRunResult["outcome"];
  /** What that replay did against the base, when it did not pass. */
  readonly controlDiagnostics?: TargetedControlDiagnostics;
  /** A reading that would have needed a control kept none, because the proof's verdict was already decided. */
  readonly controlSkipped?: true;
  /** The same replay held only as long as the base took, run when the control failed at the same site (`MutationRunResult.atBaseTime`). */
  readonly atBaseTime?: MutationRunResult["atBaseTime"];
  /** How this mutation's one re-run ended, when a sibling mutation of its step passed a site it failed. */
  readonly rerun?: MutationRunResult["outcome"];
  /**
   * #778: a replay of this mutation (first, relaxed or targeted) errored and was run once more. One
   * entry per retry, with the error it followed. The replay's own result above is the retry's.
   */
  readonly retries?: readonly { readonly reason: string }[];
  /**
   * #787: this result came from a checkpoint and no replay of it ran in this process. The checkpoint
   * keeps what the verdict reads and nothing the app wrote, so `reason`, `blockedWrites` and
   * `controlDiagnostics` are absent here, and a `retries` entry or a targeted `refused` says its wording is not kept.
   */
  readonly reused?: true;
}

export interface JourneyVerifyAssertion {
  readonly site: string;
  /** The assertion, in the `--success` spec syntax. */
  readonly check: string;
  readonly verdict: AssertionVerdict;
  readonly provedBy?: string;
  /** #609: the earlier postconditions a targeted proof weakened to reach a sensitive verdict. */
  readonly relaxedSites?: readonly string[];
  /** #609: why a targeted proof was refused, when the verdict stays a cascade. */
  readonly targetedRefusal?: string;
  /** #616: the proving targeted proof came from a declared `metadata.targetedProofs` plan. */
  readonly declaredProof?: true;
  readonly obligations?: readonly (NonNullable<AssertionProof["obligations"]>[number] & { readonly declaredProof?: true })[];
}

export interface JourneyVerifyReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the proof is bound to exactly this content. */
  readonly journeyHash: string;
  readonly executionIdentity: JourneyExecutionIdentity;
  readonly base: { readonly outcome: string; readonly reason?: string };
  /** 0.30.0 §6.1: `sensitive` (0.29.0's `proven`), `insensitive` or `inconclusive`. */
  readonly verdict: MutationProofVerdict;
  /** The 0.29.0 word for `verdict` (`proven` for `sensitive`, otherwise equal), carried through 0.31.0 and removed in 0.32.0. */
  readonly verdictLegacy: LegacyMutationProofVerdict;
  readonly reason?: string;
  /** GAPS 21 (design 5.1, rules-v1 `countsForGate`): whether this proof's target trust lets it count for a strict gate. */
  readonly countsForGate: boolean;
  readonly mutations: readonly JourneyVerifyMutation[];
  readonly assertions: readonly JourneyVerifyAssertion[];
  readonly summary: Readonly<Record<"sensitive" | "insensitive" | "cascade" | "notApplied" | "error" | "unpaired" | "targeted", number>>;
  /** #616: a reviewable `metadata.targetedProofs` entry for each automatic proof stopped at its bound. */
  readonly suggestedTargetedProofs?: readonly JourneyTargetedProofPlan[];
  /** #787: how many of `mutations` were reused from a checkpoint rather than run by this process. 0 on a run that did not resume. */
  readonly reusedPairs: number;
  /**
   * #818: where this report (all of it but this field and `nativeReportError`) was persisted before it
   * was returned, and the SHA-256 of that file's exact bytes. The canonical receipt names the same file.
   */
  readonly nativeReport?: { readonly path: string; readonly sha256: string };
  /** #818: why the report could not be persisted; then no file is claimed, here or in the receipt. */
  readonly nativeReportError?: string;
}

export interface JourneyVerifyPlanReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the preview is bound to exactly this content. */
  readonly journeyHash: string;
  readonly executionIdentity: JourneyExecutionIdentity;
  readonly mutations: readonly Pick<JourneyMutation, "kind" | "step" | "id" | "param" | "source">[];
  readonly pairs: readonly { readonly site: string; readonly check: string; readonly mutation: string; readonly declared?: true }[];
  readonly assertions: readonly { readonly site: string; readonly check: string; readonly mutations: readonly string[] }[];
  readonly summary: Readonly<Record<"mutations" | "pairs" | "assertions" | "unpaired" | "minimumReplays" | "writeReplays", number>>;
  /** #817: end-state shapes a targeted proof cannot isolate, named before any browser opens. Absent when there are none. */
  readonly isolationNotes?: readonly { readonly site: string; readonly note: string }[];
}

/**
 * What a proof that reaches a verdict runs when nothing needs more: the base, the independence replay,
 * one per mutation, and the closing replay, which only a verdict that can still change gets. Relaxed and
 * targeted replays, controls and re-runs add to it. A proof that fails or is tainted partway stops sooner.
 */
function minimumReplaysOf(plan: { readonly mutations: readonly unknown[]; readonly pairs: readonly unknown[] }): number {
  if (plan.mutations.length === 0) return 1;
  return plan.mutations.length + (plan.pairs.length === 0 ? 2 : 3);
}

/**
 * How many of those replays can send a real write: all but a mutation that removes the Journey's only
 * write step. Replays that stop at an earlier failure send less, so this is what they can send, not what they will.
 */
function writeReplaysOf(plan: { readonly mutations: readonly Pick<JourneyMutation, "kind" | "step">[]; readonly pairs: readonly unknown[] }, writeSteps: readonly { readonly step: number }[]): number {
  if (writeSteps.length === 0) return 0;
  const removesEveryWrite = (m: Pick<JourneyMutation, "kind" | "step">): boolean => (m.kind === "skip" || m.kind === "block-write") && writeSteps.every((w) => w.step === m.step);
  return minimumReplaysOf(plan) - plan.mutations.filter(removesEveryWrite).length;
}

/** The one line a proof with no reset hook or fixture prints, in `--plan` and in its report. */
export function verifyNoResetLine(summary: JourneyVerifyPlanReport["summary"]): string {
  const more = summary.writeReplays === 0 ? "" : " (relaxed replays, controls and re-runs can add more)";
  return `no reset hook or fixture: nothing undoes what a replay writes, and ${summary.writeReplays} of the ${summary.minimumReplays} planned replays can send real writes${more}`;
}

/**
 * Static preview of `journey verify --mutate`: CLI resolves local target policy; no browser, fixtures, hooks, target network, session or
 * credential is opened. Values of params are used only to derive the plan and are never returned.
 */
export async function planJourneyVerification(
  opts: Pick<VerifyJourneyOptions, "dir" | "id" | "params" | "readRequests" | "browser" | "emulation">,
): Promise<JourneyVerifyPlanReport> {
  const journey = await new JourneyRegistry(new FsJourneyStore(opts.dir)).get(opts.id);
  if (!journey) throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  const sites = journeyAssertions(journey);
  const checkOf = new Map(sites.map((site) => [assertionSiteKey(site), describeCheck(site.check)]));
  const plan = planJourneyMutations(journey, {
    ...(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests }),
    params: opts.params,
  });
  const pairs = plan.pairs.map((pair) => ({ ...pair, check: checkOf.get(pair.site) ?? "unknown assertion" }));
  const assertions = sites.map((site) => {
    const key = assertionSiteKey(site);
    return { site: key, check: describeCheck(site.check), mutations: pairs.filter((pair) => pair.site === key).map((pair) => pair.mutation) };
  });
  const isolationNotes = endStateIsolationNotes(journey, plan);
  return {
    journeyId: journey.metadata.id,
    journeyHash: journeyContentHash(journey),
    executionIdentity: journeyExecutionIdentity(journey, journeyProofContext(opts.browser, opts.emulation, opts.readRequests)),
    mutations: plan.mutations,
    pairs,
    assertions,
    summary: {
      mutations: plan.mutations.length,
      pairs: pairs.length,
      assertions: assertions.length,
      unpaired: assertions.filter((assertion) => assertion.mutations.length === 0).length,
      minimumReplays: minimumReplaysOf(plan),
      writeReplays: writeReplaysOf(plan, journeyWriteSteps(journey, opts.readRequests === undefined ? {} : { readRequests: opts.readRequests })),
    },
    ...(isolationNotes.length === 0 ? {} : { isolationNotes }),
  };
}

export { verifyExitCode } from "./journey-verify-report.js";

type Run = typeof runJourneyProgrammatically;


/**
 * Only a positively matching recorded or declared write establishes applicability. A step with no write
 * evidence at all gets a block-write only from a declared `mutationPairs` entry: any write its window blocked counts.
 */
function blockedOwnWrite(recorded: readonly string[], declared: NonNullable<MutationReplay["blockMatchers"]>, blocked: readonly BlockedWrite[]): boolean {
  const observed = recorded.flatMap((line) => {
    const m = REQUEST_LINE.exec(line.trim());
    return m === null ? [] : [{ method: m[1]!, pathGlob: m[2]!, literal: true as const }];
  });
  const matchers = [...observed, ...declared];
  if (matchers.length === 0) return blocked.length > 0;
  return matchers.some((matcher) => blocked.some((request) => mutationWriteMatches(matcher, request)));
}

function failedSitesOf(result: { outcome: string; reason?: string; at?: number; failurePhase?: "action" | "postcondition" }, failures: readonly OutcomeCheckFailure[]): MutationFailedSite[] {
  if (result.outcome !== "quarantined") return [];
  const structured = failures.map((f): MutationFailedSite =>
    f.where === "step-request" ? { where: "step-request", step: f.step, checkIndex: f.checkIndex, ...(f.evaluated === true ? { evaluated: true } : {}) } : f.where === "end-state" ? { where: "end-state", index: f.index } : { where: "unevaluable" },
  );
  return result.at === undefined ? structured : [...structured, { where: "step", step: result.at + 1, postcondition: result.failurePhase === "postcondition" }];
}

/**
 * Runs the proof for one Journey by id. Usage errors (unknown id, bad params, an environment that
 * refuses a step, a site-gate refusal) throw exactly as `journey run`'s do, before any mutation.
 * The proof keeps its machine slot between replays unless another process waits for it (#766), so
 * one admission wait cannot cost a proof that took 100 minutes to get there.
 */
export async function verifyJourneyMutations(opts: VerifyJourneyOptions, run: Run = runJourneyProgrammatically): Promise<JourneyVerifyReport> {
  const endHold = (opts.slotGovernor ?? sharedResourceGovernor()).holdSlotBetweenSessions();
  const owned: { session?: ProofCheckpointSession } = {};
  try {
    // 0.30.0 §5.4: a proof never holds; a replay that reaches a human step ends it `E_HUMAN_STEP_IN_PROOF`.
    return await asProof(() => proveJourneyMutations(opts, run, owned));
  } catch (err) {
    // The tool call's answer, whatever the command made of it (mcp-cli-tools.ts).
    if (err instanceof ProofHoldRefusedError) noteMcpRefusal(err);
    // In an MCP server the process outlives the proof, so its pid no longer says the proof is running.
    owned.session?.interrupted();
    throw err;
  } finally {
    endHold();
  }
}

function paramsAccepted(journey: Journey, params: Record<string, string>): boolean {
  try {
    validateParams(journeyParamSchema(journey), params);
    return true;
  } catch (err) {
    if (err instanceof ParamValidationError) return false;
    throw err;
  }
}

const UNANSWERED = "closed with a write still unanswered";

/**
 * Why a replay may have decided another, from names alone, so an interrupted proof can give the same reason.
 * The adjudicator's wording for each class (`isolationNoteReason`), with the lines left open named when they are known.
 */
export function isolationReason(note: IsolationNote, by: string | null, openLines: readonly string[] = []): string {
  const reason = isolationNoteReason(note, by ?? undefined);
  return openLines.length === 0 ? reason : reason.replace(UNANSWERED, `${UNANSWERED} (${openLines.join(", ")})`);
}

/** A pair's result from its checkpoint, in the report's shape. */
function reusedMutation(pair: CheckpointPair): JourneyVerifyMutation {
  return {
    kind: pair.kind,
    step: pair.step,
    id: pair.id,
    ...(pair.param === undefined ? {} : { param: pair.param }),
    ...(pair.source === undefined ? {} : { source: pair.source }),
    ...reusedProofFields(pair),
    ...(pair.retries === 0 ? {} : { retries: Array.from({ length: pair.retries }, () => ({ reason: RETRY_REASON_NOT_KEPT })) }),
    reused: true,
  };
}

// One mutated replay, as `mutationReplay` (or #554's `relaxedMutationReplay`) describes it.
type Replayed = NonNullable<JourneyVerifyMutation["relaxed"]> & {
  readonly diagnostics?: TargetedControlDiagnostics;
  readonly reachedMs?: readonly (number | undefined)[];
  readonly arrivedMs?: readonly (number | undefined)[];
  readonly heldMs?: readonly (number | undefined)[];
  readonly endStateReachedMs?: number;
  readonly endStateHeldMs?: number;
  readonly marginMs?: number;
};
/**
 * Every kind of replay a proof runs after the base. `first`, `relaxed`, `targeted` and `rerun` carry
 * the mutation. `control`, `targeted-control` and `independence` are as recorded (a targeted control
 * with its relaxations), on the same floors. `at-base-time` is the mutation again, with no margin on its floors.
 */
type ReplayKind = "first" | "relaxed" | "targeted" | "control" | "targeted-control" | "independence" | "rerun" | "at-base-time";
/** #812: the evidence's role for each kind of replay (`ReplayEvidence.role`). */
const LEDGER_ROLE: Readonly<Record<ReplayKind, LedgerReplay["role"]>> = {
  first: "mutated",
  relaxed: "relaxed",
  targeted: "targeted",
  control: "control",
  "targeted-control": "control",
  independence: "independence",
  rerun: "rerun",
  "at-base-time": "at-base-time",
};
const isUnmutated = (kind: ReplayKind): boolean => kind === "control" || kind === "targeted-control" || kind === "independence";
const labelOf = (m: JourneyMutation, kind: ReplayKind): string => {
  if (kind === "control" || kind === "targeted-control") return `control for step ${m.step}`;
  if (kind === "independence") return "independence replay, as recorded";
  if (kind === "rerun") return `${m.id} (re-run)`;
  if (kind === "at-base-time") return `${m.id} (at the base's time)`;
  return m.id;
};

/** Which replay left a write open, as the taint records it: an unmutated replay applied no mutation, so none is blamed. */
const openWriteOwner = (m: JourneyMutation, kind: ReplayKind): [IsolationNote, string | null] =>
  kind === "independence" ? ["independence-write-open", null] : kind === "control" || kind === "targeted-control" ? ["control-write-open", m.id] : ["write-open", m.id];

type BoundedRun = (options: Parameters<Run>[0], mutation: NonNullable<Parameters<Run>[1]>, m?: Pick<JourneyMutation, "id">, retry?: boolean, probe?: ReplayProbe) => ReturnType<Run>;
type ReplayOptions = Omit<VerifyJourneyOptions, "readRequests" | "onProgress" | "slotGovernor" | "checkpoint">;
type Taint = (note: IsolationNote, by?: string | null, detail?: string) => void;

/** What one replay of a proof needs from the proof it is part of. */
interface ReplayContext {
  readonly opts: VerifyJourneyOptions;
  readonly runOpts: ReplayOptions;
  readonly journey: Journey;
  readonly pace: ReplayPace;
  readonly stepsTotal: number;
  readonly settleBoundMs: number;
  readonly writeScope: WriteScope;
  readonly writeSteps: ReturnType<typeof journeyWriteSteps>;
  readonly baseProbe: ReplayProbe;
  readonly boundedRun: BoundedRun;
  readonly taint: Taint;
  readonly noteWritesInFlight: (n: number) => void;
  /** #812: the writes a replay left open that the proof counts (in scope, not excused as the base's long-lived lines). */
  readonly noteCountedOpen: (n: number) => void;
  readonly noteIndependenceOpen: (lines: readonly string[]) => void;
  /** The base's step anchors and final-network capture close, when the Journey has a final network check. */
  readonly baseline: FinalObservation | undefined;
  /** Is `m` a skip paired with a final network check, so its replay must observe as long as the base did? */
  readonly judgesRequest: (m: JourneyMutation) => boolean;
}

/** What a pair's replays, and the re-runs that settle a disagreement, need from the proof. */
interface PairContext {
  readonly journey: Journey;
  readonly plan: ReturnType<typeof planJourneyMutations>;
  readonly pace: ReplayPace;
  readonly siteByKey: ReadonlyMap<string, ReturnType<typeof journeyAssertions>[number]>;
  readonly replayOpts: Parameters<typeof mutationReplay>[2];
  readonly mutations: JourneyVerifyMutation[];
  readonly checkpoint: ProofCheckpointSession | undefined;
  readonly tainted: () => boolean;
  readonly taint: Taint;
  readonly replay: (m: JourneyMutation, describe: typeof mutationReplay, kind: ReplayKind) => Promise<Replayed>;
  readonly runReplay: (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: ReplayKind, matchTo?: SiteArrivals) => Promise<Replayed>;
  readonly controlFor: (m: JourneyMutation, runs: readonly Replayed[], sitesAtStake: readonly string[]) => Promise<Replayed>;
  readonly resultsSoFar: (extra?: readonly [string, MutationRunResult]) => ReadonlyMap<string, MutationRunResult>;
  readonly noteSuggestion: (proof: TargetedProof, m: JourneyMutation) => void;
  readonly retriesOf: ReadonlyMap<string, readonly { readonly reason: string }[]>;
  /** This pair's replays as records. Cleared as a pair starts. */
  readonly pairReplays: CheckpointReplay[];
}

interface ConcludeContext {
  readonly opts: VerifyJourneyOptions;
  readonly runOpts: ReplayOptions;
  readonly journey: Journey;
  readonly journeyHash: string;
  readonly plan: ReturnType<typeof planJourneyMutations>;
  readonly sites: ReturnType<typeof journeyAssertions>;
  readonly checkOf: ReadonlyMap<string, string>;
  readonly base: Awaited<ReturnType<Run>>;
  readonly baseFields: JourneyVerifyReport["base"];
  readonly pace: ReplayPace;
  readonly mutations: readonly JourneyVerifyMutation[];
  readonly suggested: readonly JourneyTargetedProofPlan[];
  readonly receiptDestination: Awaited<ReturnType<typeof preflightVerifyRecord>>;
  readonly boundedRun: BoundedRun;
  readonly checkpoint: ProofCheckpointSession | undefined;
  readonly resuming: ResumeState | undefined;
  /** A closing replay's restore can still fail, so this is read when it is needed. */
  readonly restoreFailed: () => boolean;
  /** Independent check M6: every secret the proof's replays knew (params, bindings, fixture and extracted secrets), read when it is needed. */
  readonly runSecrets: () => readonly string[];
  readonly notIsolated: string | undefined;
  /** #812: what the evidence records beyond the pairs: the replays as they ran, the independence reading, the first taint. */
  readonly gathered: Pick<ProofGathering, "ledger" | "isolation" | "baseOpenAtClose" | "taint">;
}

const resultOfEntry = (m: JourneyVerifyMutation): MutationRunResult => ({
  outcome: m.outcome,
  failedSites: m.failedSites,
  ...(m.waitsCut === undefined ? {} : { waitsCut: m.waitsCut }),
  ...(m.relaxed === undefined ? {} : { relaxed: m.relaxed }),
  ...(m.targeted === undefined ? {} : { targeted: m.targeted }),
  ...(m.atBaseTime === undefined ? {} : { atBaseTime: m.atBaseTime }),
});

/**
 * A paced replay waits as long as the proof says, not as long as the Journey does, so a wait that ran out
 * says both. For the reader only: nothing reads `reason` for a verdict but `failedSitesOf`, which is given the run's own.
 */
function withStatedWaitLimit(reason: string, at: number | undefined, journey: Journey): string {
  const step = at === undefined ? undefined : flatJourneySteps(journey)[at]?.recorded.step;
  const stated = step !== undefined && "waitFor" in step ? step.waitFor?.maxMs : undefined;
  return reason.replace(/\(waitFor maxMs (\d+)\); it never held/, (whole, limit: string) =>
    Number(limit) === stated ? whole : `(this replay's waitFor maxMs ${limit}; the Journey's ${stated === undefined ? "sets none" : `is ${stated}`}); it never held`,
  );
}

const reported = ({ reachedMs: _reachedMs, arrivedMs: _arrivedMs, heldMs: _heldMs, endStateReachedMs: _end, endStateHeldMs: _endHeld, marginMs: _margin, ...result }: Replayed): Omit<Replayed, "reachedMs" | "arrivedMs" | "heldMs" | "endStateReachedMs" | "endStateHeldMs" | "marginMs"> => result;

// The replay is DESCRIBED, not fixed: `mutateJourney` re-describes it on the Journey the run moved
// onto the environment (#247), so a mutated copy never drops `--env`/`--base-url`.
async function attemptReplay(c: ReplayContext, m: JourneyMutation, describe: (j: Journey) => MutationReplay, retry: boolean, kind: ReplayKind, matchTo?: SiteArrivals): Promise<Replayed> {
  const { opts, runOpts, journey, pace, stepsTotal, settleBoundMs, writeScope, writeSteps, baseProbe, boundedRun, taint } = c;
  const lastIndex = stepsTotal - 1;
  const baseOpenLines = baseProbe.openLinesAtClose;
  const noEndState = journeyEndState(journey).length === 0;
  let opened: ReplayProbe | undefined;
  // What a replay left open may land in the next one, however the replay ended.
  const checkWritesLeftOpen = (p: ReplayProbe): void => {
    c.noteWritesInFlight(p.writesInFlightAtClose);
    if (kind === "independence") c.noteIndependenceOpen(p.openLinesAtClose);
    const excused = kind === "independence" && p.openLinesAtClose.every((line) => baseOpenLines.includes(line));
    c.noteCountedOpen(p.writesInFlightAtClose > 0 && !excused ? p.writesInFlightAtClose : 0);
    if (p.writesInFlightAtClose > 0 && !excused) {
      const [note, by] = openWriteOwner(m, kind);
      taint(note, by, isolationReason(note, by, p.openLinesAtClose));
    }
  };
  try {
    const paced = (j: Journey): MutationReplay => pacedReplay(j, describe(j), m, pace);
    const how = paced(journey);
    const withMargin = kind !== "at-base-time";
    // Nothing reads the time after a last step with no end state, so holding it would only cost.
    // A control also gets to each site no sooner than the mutated replay it answers for did, dead waits included.
    const atLeast = (floor: number | undefined, arrival: number | undefined): number | undefined => (floor === undefined || arrival === undefined ? (floor ?? arrival) : Math.max(floor, arrival));
    const pacer = new ReplayPacer(m.step - 1, (index) => atLeast(paceFloorMs(pace, m, index, withMargin), matchTo?.arrivedMs?.[index + 1]), paceBeforeMutationMs(pace, m), (index) => index === lastIndex && noEndState);
    // #785: a control's counts say, on failure, what it did against the base replay. Any replay that
    // sent a write stays open as long as the base did, then until its writes have settled, so what it
    // started lands before its restore.
    const probe: ReplayProbe = new ReplayProbe(stepsTotal, async (writesSent) => {
      if (writesSent > 0) await pacer.hold(paceTailMs(pace, m));
      await probe.settleOpenWrites(settleBoundMs);
    }, writeScope);
    opened = probe;
    // A mutated replay judged by a final network check observes each step prefix at least as long, up to
    // the final capture's close, as the base did. Browser admission and cleanup never count: the clock
    // starts at each step's own boundary, and an incomplete or inconsistent observation is no evidence.
    const baseline = c.baseline;
    const holdRequired = kind !== "independence" && c.judgesRequest(m);
    const observed = holdRequired ? finalObservation(stepsTotal) : undefined;
    let horizonComplete = !holdRequired;
    let horizonSleeps = 0;
    let horizonElapsed = 0;
    let horizonRequired = 0;
    let horizonCause: "missing-observer" | "sleep-failed" | "clock-no-progress" | "clock-invalid" | "wake-limit" | "incomplete" = "missing-observer";
    const captureClose = async (): Promise<void> => {
      if (observed === undefined || baseline === undefined) return;
      await observed.captureClose();
      if (!baseline.valid || !observed.valid) { horizonCause = "clock-invalid"; return; }
      if (baseline.close !== undefined) horizonRequired = Math.max(0, ...baseline.anchors.slice(0, m.step).map((before) => baseline.close! - before));
      if (baseline.close === undefined || baseline.closes !== 1 || !baseline.finalDone || baseline.anchors.length !== stepsTotal || !observed.finalDone || observed.anchors.length !== stepsTotal) return;
      horizonCause = "incomplete";
      try {
        let now = clock.monotonicMs();
        if (observed.close === undefined || !Number.isFinite(observed.close) || !Number.isFinite(now) || now < observed.close) {
          horizonCause = "clock-invalid";
          return;
        }
        for (;;) {
          let remaining = 0;
          horizonElapsed = Number.POSITIVE_INFINITY;
          for (let index = 0; index < m.step; index++) {
            const before = baseline.anchors[index];
            const replayBefore = observed.anchors[index];
            if (before === undefined || replayBefore === undefined) { horizonCause = "missing-observer"; return; }
            const required = baseline.close - before;
            const elapsed = now - replayBefore;
            if (![now, required, elapsed].every(Number.isFinite) || required < 0 || elapsed < 0) { horizonCause = "clock-invalid"; return; }
            horizonRequired = Math.max(horizonRequired, required);
            horizonElapsed = Math.min(horizonElapsed, elapsed);
            remaining = Math.max(remaining, required - elapsed);
          }
          if (remaining <= 0) { horizonComplete = true; return; }
          if (horizonSleeps >= 8) { horizonCause = "wake-limit"; return; }
          const previous = now;
          horizonSleeps++;
          try { await clock.sleep(Math.ceil(remaining)); }
          catch { horizonCause = "sleep-failed"; return; }
          now = clock.monotonicMs();
          if (!Number.isFinite(now) || now < previous) { horizonElapsed = now; horizonCause = "clock-invalid"; return; }
          if (now === previous) { horizonCause = "clock-no-progress"; return; }
        }
      } catch { horizonCause = "clock-invalid"; }
    };
    // Described on the Journey the run moved onto the environment, as the mutated copy is.
    let waits: readonly RelaxedSiteWait[] = how.relaxedSiteWaits ?? [];
    const params = how.params ?? opts.params;
    const observer = composeObservers(
      waits.length === 0 ? undefined : relaxedWaitObserver(() => waits, params, opts.stepResponseTimeoutMs ?? DEFAULT_STEP_RESPONSE_TIMEOUT_MS, (ended) => probe.recordWait(ended)),
      isUnmutated(kind) ? probe.observer() : undefined,
      pacer.observer(),
      observed?.observer,
    );
    // The step's own lines stay blocked for the rest of the replay. A later step that records the same line sends its own.
    const blockLines = how.blockRequests ?? [];
    const lineOfRecorded = (line: string): string | undefined => {
      const parsed = REQUEST_LINE.exec(line.trim());
      return parsed === null ? undefined : lineOfRequest(parsed[1]!, parsed[2]!);
    };
    const heldLines = blockLines.flatMap((l) => lineOfRecorded(l) ?? []);
    const r = await boundedRun(
      { ...runOpts, ...(how.params === undefined ? {} : { params: { ...how.params } }), observer },
      {
        structuredFailures: true,
        // The write blocker classifies with the same recorded-origin read policy as the planner.
        ...(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests }),
        ...(observed === undefined ? {} : { beforeFinalNetworkCaptureClose: captureClose }),
        beforeEndState: async () => {
          await pacer.hold(atLeast(paceEndStateFloorMs(pace, m, withMargin), matchTo?.endStateReachedMs));
          // A claim is judged with what the app was already doing finished, as far as the Journey allows.
          await pacer.holding(() => probe.settleOpenWrites(settleBoundMs));
          pacer.noteEndState();
        },
        ...(how.relaxedStepRequests === undefined ? {} : { relaxedStepRequests: how.relaxedStepRequests }),
        ...(how.journey === journey
          ? {}
          : {
              mutateJourney: (j) => {
                const onEnvironment = paced(j);
                waits = onEnvironment.relaxedSiteWaits ?? [];
                return onEnvironment.journey;
              },
            }),
        ...(how.skipIndex === undefined ? {} : { skipStep: (i: number) => i === how.skipIndex }),
        ...(how.swapSelectAtStep === undefined ? {} : { selectAlternativeAtStep: how.swapSelectAtStep }),
        ...(how.blockIndex === undefined
          ? {}
          : {
              blockWritesAtStep: how.blockIndex,
              blockAfterWindow: {
                requests: heldLines,
                exemptSteps: writeSteps.filter((w) => w.step - 1 !== how.blockIndex && w.requests.some((l) => { const line = lineOfRecorded(l); return line !== undefined && heldLines.includes(line); })).map((w) => w.step - 1),
              },
            }),
      },
      { id: labelOf(m, kind) },
      retry,
      probe,
    );
    checkWritesLeftOpen(probe);
    if (holdRequired && r.outcome === "heal-exhausted") {
      return { outcome: "failed", failedSites: [{ where: "step", step: r.at + 1, postcondition: false }], reason: r.reason };
    }
    // A replay that stopped at a step retains its original failure/cascade. A result at
    // the final-check boundary needs the completed hold, even when the observer was skipped.
    if (holdRequired && (!horizonComplete || observed?.valid !== true || observed.closes !== 1 || !observed.finalDone) && !(r.outcome === "quarantined" && r.at !== undefined)) {
      if (observed?.valid === false) horizonCause = "clock-invalid";
      return { outcome: "error", failedSites: [], reason: `final-network observation horizon failed (cause=${horizonCause}, eligible=${observed?.finalDone === true}, closeObserved=${observed?.closes === 1}, baselineAnchors=${baseline?.anchors.length ?? 0}, replayAnchors=${observed?.anchors.length ?? 0}, sleeps=${horizonSleeps}, requiredMs=${Number.isFinite(horizonRequired) ? horizonRequired : "invalid"}, elapsedMs=${Number.isFinite(horizonElapsed) ? horizonElapsed : "invalid"})` };
    }
    const blocked = r.blockedWrites ?? [];
    const blockedFields = how.blockIndex === undefined ? {} : { blockedWrites: blocked.map((b) => `${b.method} ${b.path}`) };
    // #579: a select mutation found no other enabled live option — not applied, never proof.
    if (r.outcome === "quarantined" && /no-alternative/.test(r.reason)) {
      return { outcome: "not-applied", failedSites: [], ...blockedFields, reason: r.reason };
    }
    if (how.blockIndex !== undefined && !blockedOwnWrite(how.blockRequests ?? [], how.blockMatchers ?? [], blocked)) {
      return {
        outcome: "not-applied",
        failedSites: [],
        ...blockedFields,
        reason: `step ${m.step}'s own write was not blocked${(how.blockRequests ?? []).length === 0 ? "" : ` (recorded: ${(how.blockRequests ?? []).join(", ")})`}`,
      };
    }
    // The block did not hold: a server answered the step's own write after its window.
    if (how.blockIndex !== undefined && (r.blockEscaped?.length ?? 0) > 0) {
      return { outcome: "not-applied", failedSites: [], ...blockedFields, reason: `step ${m.step}'s own write was answered after it was blocked (${r.blockEscaped!.join(", ")}), so the mutation did not hold` };
    }
    const failedSites = failedSitesOf(r, r.outcomeFailures ?? []);
    const early = isUnmutated(kind) ? [] : sitesReachedEarly(failedSites, m, pace, pacer.reachedMs, pacer.endStateReachedMs);
    const control = r.outcome === "quarantined" && isUnmutated(kind) ? probe.read() : undefined;
    const baseDiagnostics = baseProbe.read();
    const contextOptionsMatchBase = baseProbe.openOptions === undefined || probe.openOptions === undefined ? undefined : baseProbe.openOptions === probe.openOptions;
    return {
      outcome: r.outcome === "quarantined" ? "failed" : "passed",
      failedSites,
      ...blockedFields,
      ...(r.outcome === "quarantined" ? { reason: withStatedWaitLimit(r.reason, r.at, journey) } : {}),
      ...(early.length === 0 ? {} : { waitsCut: early }),
      reachedMs: pacer.reachedMs,
      arrivedMs: pacer.arrivedMs,
      heldMs: pacer.heldMs,
      marginMs: paceMarginOf(pace, m),
      ...(pacer.endStateReachedMs === undefined ? {} : { endStateReachedMs: pacer.endStateReachedMs }),
      ...(pacer.endStateHeldMs === undefined ? {} : { endStateHeldMs: pacer.endStateHeldMs }),
      ...(control === undefined
        ? {}
        : {
            diagnostics: {
              failedSites: failedSites.map(siteKeyOf),
              control,
              ...(baseDiagnostics === undefined ? {} : { base: baseDiagnostics }),
              ...(contextOptionsMatchBase === undefined ? {} : { contextOptionsMatchBase }),
            },
          }),
    };
  } catch (err) {
    // A proof that reached a human step ends, as the base would have: never one mutation's error.
    if (err instanceof ProofHoldRefusedError) throw err;
    // A stall ends the proof: it never reads as one mutation's error, which could still end `proven`.
    if (err instanceof JourneyVerifyStalledError) {
      // A stall leaves a resumable checkpoint, so what the replay left open has to be on it. A replay whose close
      // never finished (a frozen renderer, a hold) can't say what was open: that counts as open.
      if (opened !== undefined && err.sessionsClosed) checkWritesLeftOpen(opened);
      else if (opened !== undefined && opened.opened) taint(...openWriteOwner(m, kind));
      throw err;
    }
    if (opened !== undefined) checkWritesLeftOpen(opened);
    return { outcome: "error", failedSites: [], reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One planned mutation with all its replays: first, relaxed, control, at the base's time, targeted. */
async function runPair(c: PairContext, m: JourneyMutation): Promise<void> {
  const { journey, plan, pace, siteByKey, replayOpts, mutations, checkpoint, tainted, replay, runReplay, controlFor, resultsSoFar, noteSuggestion, retriesOf, pairReplays } = c;
  checkpoint?.startPair(m.id);
  pairReplays.length = 0;
  const firstRun = await replay(m, mutationReplay, "first");
  // #554: a first failure at the mutated step's own postcondition hides the LATER paired sites
  // behind it; one relaxed replay (same action, the step's own expect/waitFor left out) judges them.
  const relaxedRun = !tainted() && needsRelaxedReplay(plan, m, firstRun) ? await replay(m, relaxedMutationReplay, "relaxed") : undefined;
  const resultOf = (f: Replayed, r: Replayed | undefined): MutationRunResult => ({ outcome: f.outcome, failedSites: f.failedSites, ...(f.waitsCut === undefined ? {} : { waitsCut: f.waitsCut }), ...(r === undefined ? {} : { relaxed: r }) });
  // The sites this mutation reads sensitive that a matched control must vouch for: thin, or held.
  const provisional = resultOf(firstRun, relaxedRun);
  const wouldCount = new Set(plan.pairs.filter((p) => p.mutation === m.id).map((p) => p.site).filter((key) => {
    const site = siteByKey.get(key);
    return site !== undefined && classifyMutation(site, m, provisional) === "sensitive";
  }));
  const needing = (r: Replayed): string[] => [...new Set([...thinSites(r.failedSites, m, pace, r.reachedMs ?? [], r.endStateReachedMs), ...heldSites(r.failedSites, r)])].filter((key) => wouldCount.has(key));
  const atStake = [...new Set([...needing(firstRun), ...(relaxedRun === undefined ? [] : needing(relaxedRun))])];
  const wanted = atStake.length > 0;
  const canChange = (keys: readonly string[]): boolean => !tainted() && controlCanChangeVerdict(journey, plan, resultsSoFar([m.id, provisional]), keys);
  const fresh = wanted && canChange(atStake) ? await controlFor(m, relaxedRun === undefined ? [firstRun] : [firstRun, relaxedRun], atStake) : undefined;
  const checked = async (r: Replayed, describe: typeof mutationReplay): Promise<Replayed> => {
    if (fresh === undefined) return r;
    const keys = needing(r);
    if (keys.length === 0) return r;
    const held = r.failedSites.filter((f) => keys.includes(siteKeyOf(f)));
    const cut = fresh.outcome === "passed" ? sitesUnmatchedBy(held, r, fresh, paceMarginOf(pace, m)) : keys;
    if (cut.length === 0) return r;
    const withCut: Replayed = { ...r, waitsCut: [...new Set([...(r.waitsCut ?? []), ...cut])] };
    // The unmutated replay failed at this very site on these floors, so the hold may be what broke it. Only
    // the mutation at the base's own time can say the claim holds without it.
    const controlFailedHere = fresh.outcome === "failed" && cut.some((key) => fresh.failedSites.some((f) => siteKeyOf(f) === key));
    if (!controlFailedHere || !canChange(cut)) return withCut;
    const timed = await replay(m, describe, "at-base-time");
    return { ...withCut, atBaseTime: { outcome: timed.outcome, failedSites: timed.failedSites } };
  };
  const first = reported(await checked(firstRun, mutationReplay));
  const relaxed = relaxedRun === undefined ? undefined : reported(await checked(relaxedRun, relaxedMutationReplay));
  const controlFields = fresh === undefined ? {} : { control: fresh.outcome, ...(fresh.diagnostics === undefined ? {} : { controlDiagnostics: fresh.diagnostics }) };
  const initial: MutationRunResult = { ...resultOf(first, relaxed), ...(first.atBaseTime === undefined ? {} : { atBaseTime: first.atBaseTime }), ...controlFields };
  // #609: a later assertion still a `cascade` is only hidden by an earlier postcondition; a
  // targeted proof relaxes them one at a time (in a clone) to reach the target itself.
  const targeted: TargetedProof[] = [];
  // One replay per set of relaxations: sites of this mutation that relax the same ones share it, and its control.
  const targetedRuns = new Map<string, Promise<Replayed>>();
  const targetedReplay = (describe: (j: Journey) => MutationReplay, kind: "targeted" | "control", key?: string): Promise<Replayed> => {
    const memoKey = `${kind}\u0000${key ?? ""}`;
    const known = targetedRuns.get(memoKey);
    if (known !== undefined) return known;
    // The proof is already over: a targeted proof's next replay is not run, and whatever it reads, the verdict is decided.
    if (tainted()) return Promise.resolve({ outcome: "error", failedSites: [], reason: "not run: the proof had already ended" });
    // A control runs after the targeted replay it answers for, and gets to each site no sooner than it did.
    const running = kind === "control" ? (targetedRuns.get(`targeted\u0000${key ?? ""}`) ?? Promise.resolve(undefined)).then((run) => runReplay(m, describe, "targeted-control", run)) : runReplay(m, describe, "targeted");
    targetedRuns.set(memoKey, running);
    return running;
  };
  for (const pair of plan.pairs) {
    if (tainted()) break;
    if (pair.mutation !== m.id) continue;
    const site = siteByKey.get(pair.site);
    if (site === undefined || classifyMutation(site, m, initial) !== "cascade") continue;
    // #616: a declared plan (reviewed earlier relaxations) replaces the automatic bound search.
    const declared = declaredTargetedProofFor(journey, m, pair.site);
    targeted.push(
      declared === undefined
        ? await runTargetedProof(journey, plan, m, site, initial, targetedReplay, replayOpts)
        : await runDeclaredTargetedProof(journey, plan, m, site, declared, targetedReplay, replayOpts),
    );
    noteSuggestion(targeted[targeted.length - 1]!, m);
  }
  const finished: JourneyVerifyMutation = {
    kind: m.kind,
    step: m.step,
    id: m.id,
    ...(m.param === undefined ? {} : { param: m.param }),
    ...(m.source === undefined ? {} : { source: m.source }),
    ...first,
    ...(relaxed === undefined ? {} : { relaxed }),
    ...controlFields,
    ...(wanted && fresh === undefined && !tainted() ? { controlSkipped: true as const } : {}),
    ...(targeted.length === 0 ? {} : { targeted }),
    ...(retriesOf.has(m.id) ? { retries: retriesOf.get(m.id)! } : {}),
  };
  mutations.push(finished);
  // A tainted proof ends here, and a pair cut short by the taint is not a result a resume could stand on.
  if (!tainted()) checkpoint?.finishPair(checkpointPairOf(finished, pairReplays));
}

/**
 * Point 3 of the experiment: one sibling failed a site another passed. The reading stands only if a
 * matched control passes and the failure reproduces on one re-run. If it does not reproduce, the
 * failure is struck and the site falls to the sibling's pass: `insensitive`, since a replay that
 * passed with the mutation applied saw the claim hold without it, twice over. If the two cannot be
 * told apart (the re-run stopped short, the control did not match), neither reading is trusted and
 * the proof is `inconclusive`: a false `insensitive` is as wrong as a false `proven`.
 */
async function settleDisagreements(c: PairContext): Promise<void> {
  const { journey, plan, pace, siteByKey, replayOpts, mutations, checkpoint, tainted, taint, runReplay, controlFor, resultsSoFar } = c;
  // A resume runs these again: only a finished pair is kept, and a re-run answers for the proof it is part of.
  if (plan.mutations.length > 0) checkpoint?.phase("disagreements");
  const settled = new Set<string>();
  for (;;) {
    if (tainted()) break;
    const next = siblingDisagreements(journey, plan, resultsSoFar()).find((d) => !settled.has(`${d.site}\u0000${d.sensitive}`));
    if (next === undefined) break;
    settled.add(`${next.site}\u0000${next.sensitive}`);
    const index = mutations.findIndex((e) => e.id === next.sensitive);
    const entry = mutations[index]!;
    const m = plan.mutations.find((x) => x.id === entry.id)!;
    const site = siteByKey.get(next.site)!;
    // Which replay made this reading, so it is the one run again.
    const proof = entry.targeted?.find((t) => t.site === next.site && t.refused === undefined);
    const fromRelaxed = entry.relaxed !== undefined && !(site.where === "step" && site.step === m.step) && entry.failedSites.some((f) => f.where === "step" && f.step === m.step && f.postcondition);
    const describe = proof !== undefined ? (j: Journey): MutationReplay => targetedMutationReplay(j, m, next.site, proof.relaxedSites, replayOpts) : (j: Journey): MutationReplay => (fromRelaxed ? relaxedMutationReplay : mutationReplay)(j, m, replayOpts);
    const rerun = await runReplay(m, describe, "rerun");
    if (tainted()) {
      mutations[index] = { ...entry, rerun: rerun.outcome };
      break;
    }
    const control = await controlFor(m, [rerun], [next.site]);
    const undecided = `sibling mutations disagree on ${next.site} (${next.sensitive} failed it, ${next.passed} passed it), and a control and a re-run could not settle it; run the proof again`;
    const controlFields = { control: control.outcome, ...(control.diagnostics === undefined ? {} : { controlDiagnostics: control.diagnostics }) };
    if (rerun.outcome === "error" || control.outcome === "error") {
      mutations[index] = { ...entry, ...controlFields, rerun: rerun.outcome };
      continue;
    }
    const reread = classifyReplay(site, m, rerun);
    const strike = (e: JourneyVerifyMutation): JourneyVerifyMutation => {
      const cut = (r: { readonly waitsCut?: readonly string[] }): { waitsCut: string[] } => ({ waitsCut: [...new Set([...(r.waitsCut ?? []), next.site])] });
      if (proof !== undefined) {
        return { ...e, targeted: e.targeted!.map((t) => (t === proof ? { ...t, refused: `${next.sensitive} failed ${next.site} once and did not reproduce, while ${next.passed} passed it` } : t)) };
      }
      return fromRelaxed ? { ...e, relaxed: { ...e.relaxed!, ...cut(e.relaxed!) } } : { ...e, ...cut(e) };
    };
    const firstReading = fromRelaxed ? entry.relaxed! : entry;
    const matched = control.outcome === "passed" && sitesUnmatchedBy(firstReading.failedSites.filter((f) => siteKeyOf(f) === next.site), rerun, control, paceMarginOf(pace, m)).length === 0;
    if (reread === "insensitive") mutations[index] = { ...strike(entry), ...controlFields, rerun: rerun.outcome };
    else if (reread === "sensitive" && matched) mutations[index] = { ...entry, ...controlFields, rerun: rerun.outcome };
    else if (control.outcome === "failed" && reread === "sensitive") mutations[index] = { ...strike(entry), ...controlFields, rerun: rerun.outcome };
    else {
      mutations[index] = { ...entry, ...controlFields, rerun: rerun.outcome };
      taint("siblings-undecided", null, undecided);
    }
  }
}

/**
 * A proof with no pairs says what to add, in the Journey's own terms. A check's method does not make its
 * request a write (read RPCs are POSTs too), so the words leave that to whoever knows: this adds no pair.
 */
function withWhatToAdd(reason: string, journey: Journey): string {
  const deltaWith = (line: string): string => `"delta":${JSON.stringify({ verdict: "relevant-change", why: "sends this write", changes: [], requests: [`${line} → 200`], overheadMs: 0 })}`;
  const lineFor = (method: string, pathGlob: string): string => `${method.toUpperCase()} ${pathGlob}`;
  const named = journeyAssertions(journey).flatMap((s) => (s.where === "end-state" && (s.check.kind === "responseStatus" || s.check.kind === "requestMade") && !READ_METHODS.has(s.check.method.toUpperCase()) ? [{ site: assertionSiteKey(s), line: lineFor(s.check.method, s.check.pathGlob) }] : []));
  if (named.length === 0) return `${reason}; if a step sends a write, add it to that step's delta.requests (a step with no delta: ${deltaWith("POST /path")}), which gives the step skip and block-write mutations, or pair a check yourself in metadata.mutationPairs`;
  return [
    reason,
    ...named.map(
      (n) =>
        `${n.site} names ${n.line}, and no step records it as a write: a check names a request, not the step that sends it. If this request is the step's write, add it to that step's delta.requests, with the path it sends (a step with no delta: ${deltaWith(n.line)}), which gives the step skip and block-write mutations, or add {"check":"${n.site}","mustFailWhen":"skip:<step>"} to metadata.mutationPairs. If it is a read, there is no write here to prove`,
    ),
  ].join("; ");
}

/** The parameters as the evidence keeps them: a keyed digest when the verify-checkpoint key can be read (never created here), else a marker. */
function proofParamsDigest(opts: VerifyJourneyOptions, journey: Journey): string {
  const read = readCheckpointKey(opts.checkpoint?.keyFile ?? checkpointKeyPath());
  return "key" in read ? evidenceParamsDigest(read.key, opts.params, secretParamNames(journey, opts.params)) : "unkeyed";
}

/** The last replay as recorded, the verdict, the report and its receipt. */
async function concludeProof(c: ConcludeContext): Promise<JourneyVerifyReport> {
  const { opts, runOpts, journey, journeyHash, plan, checkOf, base, baseFields, pace, mutations, suggested, receiptDestination, boundedRun, checkpoint, resuming, restoreFailed, gathered } = c;
  let notIsolated = c.notIsolated;
  const tainted = (): boolean => restoreFailed() || notIsolated !== undefined;
  const results = new Map<string, MutationRunResult>(mutations.map((m) => [m.id, resultOfEntry(m)]));
  // The gatherer's record: the verdict is the adjudicator's, read from it alone.
  let closing: ProofGathering["closing"];
  const evidenceNow = (paramsDigest = "unkeyed"): RunEvidence =>
    proofEvidenceOf(
      {
        journey,
        plan,
        basePassed: base.outcome === "ok",
        ...gathered,
        pairs: mutations,
        restore: restoreFailed() ? "failed" : opts.fixtures === undefined ? "none" : "ok",
        ...(closing === undefined ? {} : { closing }),
      },
      journeyHash,
      { origin: opts.environment?.baseUrl ?? journey.recording.site, environment: opts.environment?.name, channel: "cli", paramsDigest, secretParamNames: secretParamNames(journey, opts.params) },
    );
  const checksOf = (evidence: RunEvidence): NonNullable<ReturnType<typeof adjudicate>["checks"]> => adjudicate(evidence).checks!;
  // A last replay as recorded, where its result can still change the verdict: a replay's slow job has no
  // request to watch, so a late landing that stuck is only seen here. It cannot see one a restore then cleared.
  // #787: a resume always runs it: nothing from before the interruption can vouch for how the proof ended.
  if (!tainted() && (resuming !== undefined || (pace.stepEndMs.length > 0 && checksOf(evidenceNow()).verdict !== "inconclusive"))) {
    checkpoint?.phase("closing");
    try {
      const ran = await boundedRun({ ...runOpts }, { structuredFailures: true }, { id: "closing replay, as recorded" });
      closing = ran.outcome === "ok" ? "passed" : "failed";
      if (ran.outcome !== "ok") notIsolated = "the Journey as recorded no longer passes after the mutated replays, so state one left behind may have decided another; isolate the replays (a fixture restore, or a longer job's end) and run the proof again";
    } catch (err) {
      if (err instanceof JourneyVerifyStalledError || err instanceof ProofHoldRefusedError) throw err;
      closing = "error";
      notIsolated = "the closing replay as recorded errored, so the proof cannot say the replays stayed isolated; retry it";
    }
  }
  const evidence = evidenceNow(opts.onEvidence === undefined ? "unkeyed" : proofParamsDigest(opts, journey));
  const checks = checksOf(evidence);
  // Base failed: nothing ran, so every paired assertion is an `error` (no proof either way).
  const declaredFor = (by: string | undefined, site: string): boolean => by !== undefined && results.get(by)?.targeted?.some((t) => t.site === site && t.declared === true) === true;
  const assertions: JourneyVerifyAssertion[] = checks.assertions.map((a) => ({
    site: a.site,
    check: checkOf.get(a.site) ?? a.site,
    verdict: a.verdict,
    ...(a.provedBy === undefined ? {} : { provedBy: a.provedBy }),
    ...(a.relaxedSites === undefined ? {} : { relaxedSites: a.relaxedSites }),
    ...(a.targetedRefusal === undefined ? {} : { targetedRefusal: a.targetedRefusal }),
    // #616: the proving proof was a declared plan, not the automatic relaxation search.
    ...(declaredFor(a.provedBy, a.site) ? { declaredProof: true as const } : {}),
    ...(a.obligations === undefined ? {} : { obligations: a.obligations.map((o) => ({ ...o, ...(declaredFor(o.provedBy, a.site) ? { declaredProof: true as const } : {}) })) }),
  }));
  const order = new Map(journeyAssertions(journey).map((s, i) => [assertionSiteKey(s), i]));
  const siteOrder = (key: string): number => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  // d-vocab-migration (§6.1): the adjudicator's word is the report's, with the 0.29.0 word beside it.
  const verdicts = proofVerdictFields(checks.verdict);
  // The evidence names a finding by class; the proof's own words for it also name the lines left open.
  const judgedReason = gathered.taint !== undefined && notIsolated !== undefined && checks.reason === isolationNoteReason(gathered.taint.note, gathered.taint.by) ? notIsolated : checks.reason;
  const reason = plan.pairs.length === 0 && judgedReason?.startsWith("no assertion is paired") === true ? withWhatToAdd(judgedReason, journey) : judgedReason;
  const count = (v: AssertionVerdict): number => assertions.filter((a) => a.verdict === v).length;
  const proofContext = journeyProofContext(opts.browser, opts.emulation, opts.readRequests);
  const executionIdentity = journeyExecutionIdentity(journey, proofContext);
  const report: JourneyVerifyReport = {
    journeyId: journey.metadata.id,
    journeyHash,
    executionIdentity,
    base: baseFields,
    ...verdicts,
    ...(reason === undefined ? {} : { reason }),
    countsForGate: checks.countsForGate,
    mutations,
    assertions,
    summary: {
      sensitive: count("sensitive"),
      insensitive: count("insensitive"),
      cascade: count("cascade"),
      notApplied: count("not-applied"),
      error: count("error"),
      unpaired: count("unpaired"),
      // #609: assertions proven sensitive through a targeted proof that relaxed earlier sites.
      targeted: assertions.filter((a) => (a.relaxedSites?.length ?? 0) > 0).length,
    },
    // #616: in assertion order, so the first suggestion is the one for the refusal the verdict quotes.
    ...(suggested.length === 0 ? {} : { suggestedTargetedProofs: [...suggested].sort((a, b) => siteOrder(a.check) - siteOrder(b.check)) }),
    reusedPairs: resuming?.pairs.size ?? 0,
  };
  // Reasons and check texts can quote what the page showed: a secret parameter never comes back.
  // Native digest/id contain no parameter values. Do not corrupt their typed identity if a
  // secret value happens to be a substring of a digest or protocol discriminant.
  const { executionIdentity: identity, ...redactable } = report;
  // Independent check M6: every secret the replays knew, not only the secret parameters, in every URL form (`redactText`).
  const secrets = [...new Set([...secretParamValues(journey, opts.params), ...c.runSecrets()])];
  const redacted: JourneyVerifyReport = { ...redactSecretValues(redactable, secrets), executionIdentity: identity };
  // #818: the whole redacted report is on disk before anything is returned or printed, and the receipt binds it.
  const native = persistNativeReport(receiptDestination, journey, secrets, redacted, proofContext);
  const nativeBinding = "error" in native ? { nativeReportError: native.error } : { nativeReport: native };
  const receipt: JourneyVerifyRecord & { readonly nativeReport?: { readonly path: string; readonly sha256: string }; readonly nativeReportError?: string } = {
    journeyId: journey.metadata.id,
    contentHash: journeyReviewHash(journey),
    proofHash: executionIdentity.proofHash,
    ...(proofContext === undefined ? {} : { proofContext }),
    verdict: redacted.verdict,
    ...(redacted.reason === undefined ? {} : { reason: redacted.reason }),
    // §5.1: readiness and require-sensitive read whether this proof's target trust lets it count.
    countsForGate: redacted.countsForGate,
    summary: { ...redacted.summary },
    ...(redacted.suggestedTargetedProofs === undefined ? {} : { suggestedTargetedProofs: redacted.suggestedTargetedProofs }),
    ...(redacted.reusedPairs === 0 ? {} : { reusedPairs: redacted.reusedPairs }),
    ...("error" in native ? { nativeReportError: native.error } : { nativeReport: { path: relative(receiptDestination.parent, native.path), sha256: native.sha256 } }),
    // #816: the engine that computed this proof's identity, so a reader can say a mismatch is the engine's, not the Journey's.
    engine: receiptEngine(),
    // M5: the target and app version the proof ran on; a reader judging another target or app version reads it stale.
    ...receiptTarget(journey, opts),
    at: clock.nowIso(),
  };
  // #432: the verdict is kept beside the Journey (bound to its review hash) for `journey review`.
  await writePreflightedVerifyRecord(receiptDestination, receipt);
  const errorGap = checkpoint !== undefined && isRepairableIsolation(checkpoint.body.taint) ? true : !tainted() && mutations.some(mutationErrored);
  checkpoint?.finish(redacted.verdict, errorGap);
  opts.onEvidence?.(evidence);
  return { ...redacted, ...nativeBinding };
}

/** M5: the receipt's target origin (`--env`/`--base-url`, else the Journey's site) and app version, when known. */
function receiptTarget(journey: Journey, opts: VerifyJourneyOptions): { target?: { origin: string }; appVersion?: string } {
  let origin: string | undefined;
  try {
    const o = new URL(opts.environment?.baseUrl ?? journey.recording.site).origin;
    origin = o === "null" ? undefined : o;
  } catch {
    origin = undefined;
  }
  const appVersion = opts.appVersion ?? envAppVersion(process.env);
  return { ...(origin === undefined ? {} : { target: { origin } }), ...(appVersion === undefined ? {} : { appVersion }) };
}

/**
 * #818: the redacted report, with the engine and the immutable bindings that identify the run, under
 * `.verify/reports/<id>/`. A secret the run knew, found anywhere in it in any form, withholds the file entirely.
 */
function persistNativeReport(
  destination: Awaited<ReturnType<typeof preflightVerifyRecord>>,
  journey: Journey,
  secrets: readonly string[],
  report: JourneyVerifyReport,
  proofContext: ReturnType<typeof journeyProofContext>,
): { readonly path: string; readonly sha256: string } | { readonly error: string } {
  const at = clock.nowIso();
  const envelope = {
    schemaVersion: 1,
    kind: "journey-verify-native-report",
    engine: { ...currentEngineInfo(), tree: currentBuildTree() },
    journeyId: journey.metadata.id,
    journeyHash: report.journeyHash,
    contentHash: journeyReviewHash(journey),
    proofHash: report.executionIdentity.proofHash,
    ...(proofContext === undefined ? {} : { proofContext }),
    at,
    report,
  };
  if (carriesSecretValue(JSON.stringify(envelope), secrets)) {
    return { error: "the native report could not be written (withheld: it still carried a secret value); the proof's verdict stands, but its full report exists only in this output" };
  }
  const dir = join(destination.parent, "reports", basename(destination.path, ".json"));
  // `.verify` was checked by the preflight: nothing under it is written through a symbolic link.
  return writeVerifyNativeReport(dir, artifactStamp(at), envelope, destination.parent);
}

/** #816: the version and commit a receipt names as its producer (no build time: it is not identity). */
function receiptEngine(): { readonly version: string; readonly commit: string } {
  const { version, commit } = currentEngineInfo();
  return { version, commit };
}

async function proveJourneyMutations(opts: VerifyJourneyOptions, run: Run, owned: { session?: ProofCheckpointSession }): Promise<JourneyVerifyReport> {
  const journey = await loadJourneyToVerify(opts.dir, opts.id);
  // #711: receipt authority is proven before the first baseline/mutation replay spends a browser.
  const receiptDestination = await preflightVerifyRecord(opts.dir, journey.metadata.id);
  const { readRequests, onProgress, slotGovernor: _slotGovernor, checkpoint: checkpointRequest, onEvidence: _onEvidence, ...runOpts } = opts;
  const inactivityMs = proofInactivityMs(journey, opts);
  const portFactory = opts.browserPortFactory ?? ((): BrowserPort => new PlaywrightBrowserPort());
  let replays = 0;
  // Every replay of the proof goes through here: it is reported, and it is bounded.
  let sessionsOpened = 0;
  // A replay's restore may fail whether it passes, fails or throws, so the run reports it as it happens.
  let restoreFailed = false;
  const lintOpts = readRequests === undefined ? {} : { readRequests };
  const journeyHash = journeyContentHash(journey);
  const sites = journeyAssertions(journey);
  const plan = planJourneyMutations(journey, { ...lintOpts, params: opts.params });
  // #787: claimed before the first replay: a refused resume spends no browser and runs no hook.
  // Params the replay will refuse keep no progress, so a mistyped command cannot replace a checkpoint. The replay raises its own refusal.
  const opened = checkpointRequest === undefined || (!checkpointRequest.resume && !paramsAccepted(journey, opts.params)) ? {} : await openProofCheckpoint(checkpointRequest, { journey, journeyHash, plan, params: opts.params, sites });
  const checkpoint = opened.session;
  if (checkpoint !== undefined) owned.session = checkpoint;
  const resuming = opened.resume;
  // A taint belongs to the whole proof: an earlier run's stands, or a resume could read `proven` where the uninterrupted proof could not.
  if (resuming?.restoreFailed === true) restoreFailed = true;
  // Independent check M6: the secrets each replay knew, for the report's redaction.
  const knownSecrets = new Set<string>();
  const boundedRun = (options: Parameters<Run>[0], mutation: NonNullable<Parameters<Run>[1]>, m?: Pick<JourneyMutation, "id">, retry = false, probe?: ReplayProbe): ReturnType<Run> => {
    replays += 1;
    checkpoint?.replayStarted(replays);
    const where: JourneyVerifyProgress = { replay: replays, ...(m === undefined ? {} : { mutation: m.id }), ...(retry ? { retry: true as const } : {}) };
    onProgress?.(retry && m !== undefined ? { ...where, mutation: `${m.id} (retry after error)` } : where);
    return replayWithinBound((browserPortFactory) => run({ ...options, browserPortFactory }, { ...mutation, onRunSecrets: (secrets) => {
          for (const v of secrets) if (v !== "") knownSecrets.add(v);
        }, onFixtureRestoreFailed: () => {
          restoreFailed = true;
          checkpoint?.taint({ restoreFailed: true });
        } }), probe === undefined ? portFactory : probe.wrap(portFactory), where, inactivityMs, () => void (sessionsOpened += 1));
  };

  const stepsTotal = flatJourneySteps(journey).length;
  const writeSteps = journeyWriteSteps(journey, lintOpts);
  const writeScope = new WriteScope(effectiveAllowedOrigins(journey, opts.environment, opts.allow), writeSteps.flatMap((w) => w.requests));
  const longestResponseMs = Math.max(opts.stepResponseTimeoutMs ?? DEFAULT_STEP_RESPONSE_TIMEOUT_MS, ...flatJourneySteps(journey).map(({ recorded }) => recorded.responseTimeoutMs ?? 0));
  const basePacer = new ReplayPacer(0, () => undefined);
  // The base stays open until its writes have settled: what it started must not land in the next replay.
  const baseProbe: ReplayProbe = new ReplayProbe(stepsTotal, () => baseProbe.settleOpenWrites(Math.max(longestResponseMs, basePacer.elapsedMs())), writeScope);
  // The base's own step boundaries and final capture close: what a final-network replay must observe as long as.
  const baseline = needsFinalNetworkObservation(journey) ? finalObservation(stepsTotal) : undefined;
  const base = await boundedRun(
    { ...runOpts, observer: composeObservers(baseProbe.observer(), basePacer.observer(), baseline?.observer) },
    {
      structuredFailures: true,
      earliestObserver: basePacer.claimObserver(),
      afterEndState: () => basePacer.noteEndState(),
      ...(baseline === undefined ? {} : { beforeFinalNetworkCaptureClose: baseline.captureClose }),
    },
    undefined,
    false,
    baseProbe,
  );
  // Every other replay waits as this one did, so this one is their control (`pacedReplay`).
  const pace: ReplayPace = { stepEndMs: basePacer.reachedMs.filter((ms): ms is number => ms !== undefined), ...(basePacer.endStateReachedMs === undefined ? {} : { endStateMs: basePacer.endStateReachedMs }), claimHeldMs: [...basePacer.claimHeldMs] };
  const baseMs = basePacer.elapsedMs();
  const settleBoundMs = Math.max(longestResponseMs, baseMs);
  writeScope.addBackground(baseProbe.repeatedLines);
  // Why a replay may have decided another (a write still open at a close, state crossing replays).
  const resumedNote = resuming === undefined ? null : (resuming.isolation ?? (resuming.notIsolatedBy === null ? null : "write-open"));
  let notIsolated: string | undefined = resumedNote === null ? undefined : isolationReason(resumedNote, resuming?.notIsolatedBy ?? null);
  // #812: the same finding as the evidence records it, for the adjudicator.
  let taintNote: ProofGathering["taint"] =
    resumedNote === null ? undefined : { note: resumedNote, ...(resuming?.notIsolatedBy == null ? {} : { by: resuming.notIsolatedBy }), carried: true };
  // Once set it stays, and an interrupted proof keeps it: a resume could otherwise read `proven` where the uninterrupted proof could not.
  const taint = (note: IsolationNote, by: string | null = null, detail?: string): void => {
    if (notIsolated !== undefined) return;
    notIsolated = detail ?? isolationReason(note, by);
    taintNote = { note, ...(by === null ? {} : { by }) };
    checkpoint?.taint({ isolation: note, notIsolatedBy: by });
  };
  // #812: what the evidence records of the replays as they run.
  const ledger: LedgerReplay[] = [];
  let isolation: Known<"isolated" | "state-crossed"> = { known: false, reason: "not-gathered" };
  let baseOpenAtClose = 0;
  // Once a replay may have decided another, the proof is `inconclusive` whatever is left: nothing else is run.
  const tainted = (): boolean => restoreFailed || notIsolated !== undefined;
  const baseFields = { outcome: base.outcome, ...(base.outcome === "quarantined" ? { reason: base.reason } : {}) };
  const checkOf = new Map(sites.map((s) => [assertionSiteKey(s), describeCheck(s.check)]));
  if (resuming !== undefined) {
    // Nothing is reused against an app whose as-recorded flow no longer passes, or a base it was not paced for.
    if (base.outcome !== "ok") {
      const why = base.outcome === "quarantined" ? redactSecretValues({ reason: base.reason }, [...secretParamValues(journey, opts.params), ...knownSecrets]).reason : base.outcome;
      throw new JourneyVerifyResumeRefusedError("base-failed", `the Journey as recorded did not pass the re-run of the base replay (${why})`);
    }
    const refused = resumeRefusalAgainstBase(resuming, plan, sites, pace, baseProbe.writesInFlightAtClose);
    if (refused !== undefined) throw refused;
  }

  const mutations: JourneyVerifyMutation[] = [];
  // #616: automatic targeted proofs stopped at their relaxation bound, each a reviewable start.
  const suggested: JourneyTargetedProofPlan[] = [];
  const seenSuggestions = new Set<string>();
  // #787: this pair's replays as records, by kind, for a later base to be held against.
  const pairReplays: CheckpointReplay[] = [];
  let replayWritesInFlight = 0;
  let countedOpen = 0;
  if (base.outcome === "ok") {
    // #565: a param mutation's replay runs with altered params (never a secret's), so it needs them.
    const replayOpts = { ...lintOpts, params: opts.params };
    const baseOpenLines = baseProbe.openLinesAtClose;
    let independenceOpen: readonly string[] = [];
    const replayContext: ReplayContext = {
      opts, runOpts, journey, pace, stepsTotal, settleBoundMs, writeScope, writeSteps, baseProbe, boundedRun, taint,
      noteWritesInFlight: (n) => void (replayWritesInFlight = Math.max(replayWritesInFlight, n)),
      noteCountedOpen: (n) => void (countedOpen += n),
      noteIndependenceOpen: (lines) => void (independenceOpen = lines),
      baseline,
      judgesRequest: (m) => m.kind === "skip" && plan.pairs.some((p) => {
        const site = p.mutation === m.id ? sites.find((s) => assertionSiteKey(s) === p.site) : undefined;
        return site?.where === "end-state" && (site.check.kind === "requestMade" || site.check.kind === "responseStatus");
      }),
    };
    const retriesOf = new Map<string, { readonly reason: string }[]>();
    // #778: one infrastructure error must not cost the proof, so a replay that errored before opening a
    // browser, as on an admission timeout, runs once more. One that opened a browser may have changed the
    // app, and a retry failing on that leftover state would read as proof, so it stays an error. A
    // `failed` replay is a result and a stall ends the proof: neither gets here. A replay that never
    // started (`describe` refused it, as a targeted proof's bad relaxation) would only be refused again.
    const attemptWithRetry = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: ReplayKind, matchTo?: SiteArrivals): Promise<Replayed> => {
      const before = replays;
      const sessionsBefore = sessionsOpened;
      const first = await attemptReplay(replayContext, m, describe, false, kind, matchTo);
      if (first.outcome !== "error" || replays === before || sessionsOpened !== sessionsBefore) return first;
      retriesOf.set(m.id, [...(retriesOf.get(m.id) ?? []), { reason: first.reason ?? "unknown error" }]);
      return attemptReplay(replayContext, m, describe, true, kind, matchTo);
    };
    // #787: the one place a replay of a pair runs, so each is kept as a record of its kind. A new kind is a new name here and in `REPLAY_RECORD_KINDS`.
    const runReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: ReplayKind, matchTo?: SiteArrivals): Promise<Replayed> => {
      replayWritesInFlight = 0;
      countedOpen = 0;
      const ran = await attemptWithRetry(m, describe, kind, matchTo);
      pairReplays.push(checkpointReplayOf(kind, ran, replayWritesInFlight));
      ledger.push({ role: LEDGER_ROLE[kind], ...(kind === "independence" ? {} : { mutation: m.id }), outcome: ran.outcome, openAtClose: { known: true, value: countedOpen } });
      return ran;
    };
    // #402: a named mutation lowers to its `MutationReplay`; #609's targeted proof passes one directly.
    const replay = (m: JourneyMutation, describe: typeof mutationReplay, kind: ReplayKind): Promise<Replayed> => runReplay(m, (j) => describe(j, m, replayOpts), kind);
    const siteByKey = new Map(sites.map((s) => [assertionSiteKey(s), s]));
    // #616: a proof the automatic bound stopped names the plan a human could declare instead.
    const noteSuggestion = (proof: TargetedProof, m: JourneyMutation): void => {
      const suggestion = suggestTargetedProofPlan(proof, m);
      if (suggestion === null) return;
      const key = `${suggestion.check}\u0000${suggestion.mustFailWhen}\u0000${suggestion.relax.join(",")}`;
      if (seenSuggestions.has(key)) return;
      seenSuggestions.add(key);
      suggested.push(suggestion);
    };
    const asRecorded = (j: Journey): MutationReplay => ({ journey: j });
    // Sibling mutations of a step have the same floors, so they share a matched control while it reached their sites together with them.
    const stepControls = new Map<number, Replayed[]>();
    const controlFor = async (m: JourneyMutation, runs: readonly Replayed[], sitesAtStake: readonly string[]): Promise<Replayed> => {
      const known = (stepControls.get(m.step) ?? []).find((c) => runs.every((r) => sitesUnmatchedBy(r.failedSites.filter((f) => sitesAtStake.includes(siteKeyOf(f))), r, c, paceMarginOf(pace, m)).length === 0));
      if (known !== undefined) {
        // Each pair keeps a record of the control it read, whoever ran it: one that left a write open ended the proof.
        pairReplays.push(checkpointReplayOf("control", known, 0));
        return known;
      }
      const latest = (of: (r: Replayed) => number | undefined): number | undefined => {
        const known = runs.map(of).filter((ms): ms is number => ms !== undefined);
        return known.length === 0 ? undefined : Math.max(...known);
      };
      const longest = Math.max(0, ...runs.map((r) => r.arrivedMs?.length ?? 0));
      const end = latest((r) => r.endStateReachedMs);
      const matchTo: SiteArrivals = { arrivedMs: Array.from({ length: longest }, (_, i) => latest((r) => r.arrivedMs?.[i])), ...(end === undefined ? {} : { endStateReachedMs: end }) };
      const ran = await runReplay(m, asRecorded, "control", matchTo);
      stepControls.set(m.step, [...(stepControls.get(m.step) ?? []), ran]);
      return ran;
    };
    const resultsSoFar = (extra?: readonly [string, MutationRunResult]): ReadonlyMap<string, MutationRunResult> => new Map([...mutations.map((e): [string, MutationRunResult] => [e.id, resultOfEntry(e)]), ...(extra === undefined ? [] : [extra])]);

    /**
     * A replay straight after the base, floored as the first mutated replay will be. What the base left
     * running, however it started (a GET, a socket, a popup), meets it where it would meet that replay.
     * A failure alone cannot say whether state crossed over or the floor itself breaks a claim that only
     * lasts so long, so it is run again after a quiet gap: a pass means state crossed. A second failure
     * is the floor if the Journey still passes unheld, and state that stuck if it does not.
     */
    const proveIndependence = async (first: JourneyMutation): Promise<void> => {
      const floored = await runReplay(first, asRecorded, "independence");
      // A write still open at the bound in the base and the next replay is a long-lived connection. Open only in the base, it was a real one.
      if (baseOpenLines.some((line) => !independenceOpen.includes(line))) {
        baseOpenAtClose = baseOpenLines.length;
        taint("base-write-open", null, isolationReason("base-write-open", null, baseOpenLines));
        return;
      }
      writeScope.addBackground(baseOpenLines);
      if (floored.outcome === "error") {
        isolation = { known: false, reason: "replay-errored" };
        taint("independence-errored");
        return;
      }
      if (floored.outcome === "passed") {
        isolation = { known: true, value: "isolated" };
        stepControls.set(first.step, [floored]);
        checkpoint?.independence("passed");
        return;
      }
      if (tainted()) return;
      await clock.sleep(Math.max(QUIET_GAP_MIN_MS, 2 * baseMs));
      const again = await runReplay(first, asRecorded, "independence");
      if (again.outcome === "passed") {
        isolation = { known: true, value: "state-crossed" };
        taint("state-crossed");
        return;
      }
      if (again.outcome === "error") {
        isolation = { known: false, reason: "replay-errored" };
        taint("independence-errored");
        return;
      }
      if (tainted()) return;
      const unheldProbe: ReplayProbe = new ReplayProbe(stepsTotal, () => unheldProbe.settleOpenWrites(settleBoundMs), writeScope);
      // #812: what the unheld replay leaves open lands in the first mutated replay, as any other replay's would.
      const unheldOpen = (): number => {
        const open = unheldProbe.writesInFlightAtClose > 0 && !unheldProbe.openLinesAtClose.every((line) => baseOpenLines.includes(line)) ? unheldProbe.writesInFlightAtClose : 0;
        if (open > 0) taint("independence-write-open", null, isolationReason("independence-write-open", null, unheldProbe.openLinesAtClose));
        return open;
      };
      try {
        const unheld = await boundedRun({ ...runOpts, observer: unheldProbe.observer() }, { structuredFailures: true }, { id: "independence replay, unheld" }, false, unheldProbe);
        ledger.push({ role: "independence", outcome: unheld.outcome === "ok" ? "passed" : "failed", openAtClose: { known: true, value: unheldOpen() } });
        if (unheld.outcome !== "ok") {
          isolation = { known: true, value: "state-crossed" };
          taint("state-stuck");
        }
      } catch (err) {
        if (err instanceof JourneyVerifyStalledError || err instanceof ProofHoldRefusedError) throw err;
        ledger.push({ role: "independence", outcome: "error", openAtClose: { known: true, value: unheldOpen() } });
        isolation = { known: false, reason: "replay-errored" };
        taint("independence-errored");
        return;
      }
      if (tainted()) return;
      isolation = { known: true, value: "isolated" };
      stepControls.set(first.step, [again]);
      checkpoint?.independence("hold-breaks-claim");
    };

    const pairContext: PairContext = { journey, plan, pace, siteByKey, replayOpts, mutations, checkpoint, tainted, taint, replay, runReplay, controlFor, resultsSoFar, noteSuggestion, retriesOf, pairReplays };
    const firstMutation = plan.mutations[0];
    // On a resume too: it answers for the base just measured, so a checkpoint never stands in for it.
    if (firstMutation !== undefined && pace.stepEndMs.length > 0 && !tainted()) {
      checkpoint?.phase("independence");
      if (baseOpenLines.some((line) => writeScope.isRecorded(line))) {
        baseOpenAtClose = baseOpenLines.length;
        taint("base-write-open", null, isolationReason("base-write-open", null, baseOpenLines));
      } else {
        await proveIndependence(firstMutation);
      }
    }
    for (const m of plan.mutations) {
      if (tainted()) break;
      // #787: a finished pair is not run again. It reaches the same judging below as a pair just run.
      const kept = resuming?.pairs.get(m.id);
      if (kept !== undefined) {
        mutations.push(reusedMutation(kept));
        for (const proof of reusedProofFields(kept).targeted ?? []) noteSuggestion(proof, m);
        continue;
      }
      await runPair(pairContext, m);
    }

    await settleDisagreements(pairContext);
  }

  return concludeProof({
    opts, runOpts, journey, journeyHash, plan, sites, checkOf, base, baseFields, pace, mutations, suggested, receiptDestination, boundedRun, checkpoint, resuming,
    restoreFailed: () => restoreFailed, runSecrets: () => [...knownSecrets], notIsolated,
    gathered: { ledger, isolation, baseOpenAtClose, ...(taintNote === undefined ? {} : { taint: taintNote }) },
  });
}

/** One human line per assertion — verdict, site, check, and the mutation that proved it. */
export function verifyAssertionLine(a: JourneyVerifyAssertion): string {
  // #609: a sensitive verdict reached by a targeted proof names the earlier postconditions it relaxed.
  // #616: a declared plan's relaxations are named as reviewed, not as an automatic search.
  const relaxed =
    a.relaxedSites === undefined || a.relaxedSites.length === 0 ? "" : a.declaredProof === true ? `, declared plan relaxed ${a.relaxedSites.join(", ")}` : `, relaxed ${a.relaxedSites.join(", ")}`;
  const proved = a.provedBy === undefined ? "" : `  (proved by ${a.provedBy}${relaxed})`;
  const refused = a.targetedRefusal === undefined ? "" : `  (targeted proof refused: ${a.targetedRefusal})`;
  const obligations = a.obligations === undefined ? "" : `  [${a.obligations.map((o) => {
    const witness = o.provedBy === undefined ? "" : ` by ${o.provedBy}`;
    const relaxed = o.relaxedSites === undefined || o.relaxedSites.length === 0 ? "" : `, ${o.declaredProof === true ? "declared plan " : ""}relaxed ${o.relaxedSites.join(", ")}`;
    const refusal = o.targetedRefusal === undefined ? "" : `, targeted proof refused: ${o.targetedRefusal}`;
    return `${o.kind}: ${o.verdict}${witness}${relaxed}${refusal}`;
  }).join("; ")}]`;
  return `${a.verdict.padEnd(11)}  ${a.site.padEnd(18)}  ${a.check}${proved}${refused}${obligations}`;
}
