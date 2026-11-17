/**
 * The mutation phase of `journey verify --mutate`: it plans the mutation pairs, opens or resumes the
 * checkpoint, proves independence, runs each mutation with its control, and records the verdicts the
 * report is assembled from. `proveJourneyMutations` in `journey-verify.ts` keeps the orchestration of
 * the proof (the base replay, the taint, the receipt) and calls these helpers in the original order.
 */
import { clock } from "@jevitate/domain";
import { isolationNoteReason, type Known, type RunEvidence } from "@jevitate/adjudicator";
import { DEFAULT_STEP_RESPONSE_TIMEOUT_MS } from "@jevitate/explore";
import type { BrowserPort, ResourceGovernor } from "@jevitate/playwright";
import {
  assertionSiteKey,
  flatJourneySteps,
  journeyAssertions,
  journeyWriteSteps,
  mutationReplay,
  needsFinalNetworkObservation,
  paceMarginOf,
  planJourneyMutations,
  sitesUnmatchedBy,
  suggestTargetedProofPlan,
  type Journey,
  type JourneyMutation,
  type JourneyTargetedProofPlan,
  type MutationReplay,
  type MutationRunResult,
  type ReplayPace,
  type SiteArrivals,
  type TargetedProof,
} from "@jevitate/journey";
import { effectiveAllowedOrigins, runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { checkpointReplayOf, reusedProofFields, type CheckpointReplay, type IsolationNote, type ProofCheckpointRequest, type ProofCheckpointSession, type ResumeState } from "./journey-verify-checkpoint.js";
import { reusedMutation, type JourneyVerifyMutation } from "./journey-verify-scope.js";
import { ProofHoldRefusedError } from "./journey-run-hooks.js";
import { composeObservers } from "./run-screenshots.js";
import {
  QUIET_GAP_MIN_MS,
  JourneyVerifyStalledError,
  ReplayPacer,
  ReplayProbe,
  WriteScope,
  finalObservation,
  siteKeyOf,
  replayWithinBound,
  type FinalObservation,
  type JourneyVerifyProgress,
  type TargetedControlDiagnostics,
} from "./journey-verify-observer.js";
import type { LedgerReplay, ProofGathering } from "./journey-verify-evidence.js";

export type Run = typeof runJourneyProgrammatically;

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

const UNANSWERED = "closed with a write still unanswered";

/**
 * Why a replay may have decided another, from names alone, so an interrupted proof can give the same reason.
 * The adjudicator's wording for each class (`isolationNoteReason`), with the lines left open named when they are known.
 */
export function isolationReason(note: IsolationNote, by: string | null, openLines: readonly string[] = []): string {
  const reason = isolationNoteReason(note, by ?? undefined);
  return openLines.length === 0 ? reason : reason.replace(UNANSWERED, `${UNANSWERED} (${openLines.join(", ")})`);
}

// One mutated replay, as `mutationReplay` (or #554's `relaxedMutationReplay`) describes it.
export type Replayed = NonNullable<JourneyVerifyMutation["relaxed"]> & {
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
export type ReplayKind = "first" | "relaxed" | "targeted" | "control" | "targeted-control" | "independence" | "rerun" | "at-base-time";
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
export const isUnmutated = (kind: ReplayKind): boolean => kind === "control" || kind === "targeted-control" || kind === "independence";
export const labelOf = (m: JourneyMutation, kind: ReplayKind): string => {
  if (kind === "control" || kind === "targeted-control") return `control for step ${m.step}`;
  if (kind === "independence") return "independence replay, as recorded";
  if (kind === "rerun") return `${m.id} (re-run)`;
  if (kind === "at-base-time") return `${m.id} (at the base's time)`;
  return m.id;
};

/** Which replay left a write open, as the taint records it: an unmutated replay applied no mutation, so none is blamed. */
export const openWriteOwner = (m: JourneyMutation, kind: ReplayKind): [IsolationNote, string | null] =>
  kind === "independence" ? ["independence-write-open", null] : kind === "control" || kind === "targeted-control" ? ["control-write-open", m.id] : ["write-open", m.id];

export const resultOfEntry = (m: JourneyVerifyMutation): MutationRunResult => ({
  outcome: m.outcome,
  failedSites: m.failedSites,
  ...(m.waitsCut === undefined ? {} : { waitsCut: m.waitsCut }),
  ...(m.relaxed === undefined ? {} : { relaxed: m.relaxed }),
  ...(m.targeted === undefined ? {} : { targeted: m.targeted }),
  ...(m.atBaseTime === undefined ? {} : { atBaseTime: m.atBaseTime }),
});

export type BoundedRun = (options: Parameters<Run>[0], mutation: NonNullable<Parameters<Run>[1]>, m?: Pick<JourneyMutation, "id">, retry?: boolean, probe?: ReplayProbe) => ReturnType<Run>;
export type ReplayOptions = Omit<VerifyJourneyOptions, "readRequests" | "onProgress" | "slotGovernor" | "checkpoint">;
export type Taint = (note: IsolationNote, by?: string | null, detail?: string) => void;

/** What one replay of a proof needs from the proof it is part of. */
export interface ReplayContext {
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
export interface PairContext {
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

/** The counters a proof keeps across its replays: each is a side effect of running one, so callers read them live. */
export interface ProofState {
  replays: number;
  sessionsOpened: number;
  restoreFailed: boolean;
  readonly knownSecrets: Set<string>;
}

/** Creates the one place every replay of the proof goes through: it is reported, bounded and counted. */
export function createBoundedRun(
  state: ProofState,
  deps: {
    readonly run: Run;
    readonly portFactory: () => BrowserPort;
    readonly inactivityMs: number;
    readonly checkpoint: ProofCheckpointSession | undefined;
    readonly onProgress: ((progress: JourneyVerifyProgress) => void) | undefined;
  },
): BoundedRun {
  return (options, mutation, m, retry = false, probe) => {
    state.replays += 1;
    deps.checkpoint?.replayStarted(state.replays);
    const where: JourneyVerifyProgress = { replay: state.replays, ...(m === undefined ? {} : { mutation: m.id }), ...(retry ? { retry: true as const } : {}) };
    deps.onProgress?.(retry && m !== undefined ? { ...where, mutation: `${m.id} (retry after error)` } : where);
    return replayWithinBound(
      (browserPortFactory) =>
        deps.run(
          { ...options, browserPortFactory },
          {
            ...mutation,
            onRunSecrets: (secrets) => {
              for (const v of secrets) if (v !== "") state.knownSecrets.add(v);
            },
            onFixtureRestoreFailed: () => {
              state.restoreFailed = true;
              deps.checkpoint?.taint({ restoreFailed: true });
            },
          },
        ),
      probe === undefined ? deps.portFactory : probe.wrap(deps.portFactory),
      where,
      deps.inactivityMs,
      () => void (state.sessionsOpened += 1),
    );
  };
}

/** What the baseline replay left the proof with: its timing floors, write scope and observation baseline. */
export interface BaselinePhase {
  readonly stepsTotal: number;
  readonly writeSteps: ReturnType<typeof journeyWriteSteps>;
  readonly writeScope: WriteScope;
  readonly baseProbe: ReplayProbe;
  readonly baseline: FinalObservation | undefined;
  readonly base: Awaited<ReturnType<Run>>;
  readonly pace: ReplayPace;
  readonly baseMs: number;
  readonly settleBoundMs: number;
}

/** Runs replay 1 (the Journey as recorded) and derives every floor later replays are held to. */
export async function runBaselinePhase(input: {
  readonly opts: VerifyJourneyOptions;
  readonly runOpts: ReplayOptions;
  readonly journey: Journey;
  readonly lintOpts: { readonly readRequests?: readonly string[] };
  readonly boundedRun: BoundedRun;
}): Promise<BaselinePhase> {
  const { opts, runOpts, journey, lintOpts, boundedRun } = input;
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
  return { stepsTotal, writeSteps, writeScope, baseProbe, baseline, base, pace, baseMs, settleBoundMs };
}

/** The proof's taint, read and written live: an earlier run's stands, and a resume can never erase it. */
export interface ProofTaint {
  readonly taint: Taint;
  readonly tainted: () => boolean;
  readonly notIsolated: () => string | undefined;
  readonly taintNote: () => ProofGathering["taint"];
}

/** Restores the taint an interrupted proof carried, then accumulates the one this run finds. */
export function createProofTaint(resuming: ResumeState | undefined, checkpoint: ProofCheckpointSession | undefined, restoreFailed: () => boolean): ProofTaint {
  const resumedNote = resuming === undefined ? null : (resuming.isolation ?? (resuming.notIsolatedBy === null ? null : "write-open"));
  let notIsolated: string | undefined = resumedNote === null ? undefined : isolationReason(resumedNote, resuming?.notIsolatedBy ?? null);
  // #812: the same finding as the evidence records it, for the adjudicator.
  let taintNote: ProofGathering["taint"] =
    resumedNote === null ? undefined : { note: resumedNote, ...(resuming?.notIsolatedBy == null ? {} : { by: resuming.notIsolatedBy }), carried: true };
  // Once set it stays, and an interrupted proof keeps it: a resume could otherwise read `proven` where the uninterrupted proof could not.
  const taint: Taint = (note, by = null, detail) => {
    if (notIsolated !== undefined) return;
    notIsolated = detail ?? isolationReason(note, by);
    taintNote = { note, ...(by === null ? {} : { by }) };
    checkpoint?.taint({ isolation: note, notIsolatedBy: by });
  };
  return { taint, tainted: () => restoreFailed() || notIsolated !== undefined, notIsolated: () => notIsolated, taintNote: () => taintNote };
}

/** What the mutation phase produced, for the report's assembly. */
export interface MutationProofResult {
  readonly mutations: JourneyVerifyMutation[];
  readonly suggested: JourneyTargetedProofPlan[];
  readonly ledger: LedgerReplay[];
  readonly isolation: Known<"isolated" | "state-crossed">;
  readonly baseOpenAtClose: number;
}

/** Everything the mutation phase reads from the proof before it starts. */
export interface MutationPhaseInput {
  readonly opts: VerifyJourneyOptions;
  readonly runOpts: ReplayOptions;
  readonly journey: Journey;
  readonly plan: ReturnType<typeof planJourneyMutations>;
  readonly sites: ReturnType<typeof journeyAssertions>;
  readonly pace: ReplayPace;
  readonly stepsTotal: number;
  readonly baseMs: number;
  readonly settleBoundMs: number;
  readonly writeScope: WriteScope;
  readonly writeSteps: ReturnType<typeof journeyWriteSteps>;
  readonly baseProbe: ReplayProbe;
  readonly baseline: FinalObservation | undefined;
  readonly boundedRun: BoundedRun;
  readonly checkpoint: ProofCheckpointSession | undefined;
  readonly resuming: ResumeState | undefined;
  readonly taint: Taint;
  readonly tainted: () => boolean;
  readonly attemptReplay: (c: ReplayContext, m: JourneyMutation, describe: (j: Journey) => MutationReplay, retry: boolean, kind: ReplayKind, matchTo?: SiteArrivals) => Promise<Replayed>;
  readonly runPair: (c: PairContext, m: JourneyMutation) => Promise<void>;
  readonly settleDisagreements: (c: PairContext) => Promise<void>;
  readonly proofState: ProofState;
}

/** The mutation phase's own live state: each replay appends as it runs, so the helpers read it in order. */
interface MutationPhaseState {
  readonly ledger: LedgerReplay[];
  isolation: Known<"isolated" | "state-crossed">;
  baseOpenAtClose: number;
  independenceOpen: readonly string[];
  replayWritesInFlight: number;
  countedOpen: number;
  readonly pairReplays: CheckpointReplay[];
}

interface PairTools {
  readonly replay: PairContext["replay"];
  readonly runReplay: PairContext["runReplay"];
  readonly controlFor: PairContext["controlFor"];
  readonly resultsSoFar: PairContext["resultsSoFar"];
  readonly noteSuggestion: PairContext["noteSuggestion"];
}

interface PairToolsInput {
  readonly opts: VerifyJourneyOptions;
  readonly runOpts: ReplayOptions;
  readonly journey: Journey;
  readonly plan: ReturnType<typeof planJourneyMutations>;
  readonly sites: ReturnType<typeof journeyAssertions>;
  readonly pace: ReplayPace;
  readonly stepsTotal: number;
  readonly settleBoundMs: number;
  readonly writeScope: WriteScope;
  readonly writeSteps: ReturnType<typeof journeyWriteSteps>;
  readonly baseProbe: ReplayProbe;
  readonly baseline: FinalObservation | undefined;
  readonly boundedRun: BoundedRun;
  readonly checkpoint: ProofCheckpointSession | undefined;
  readonly taint: Taint;
  readonly attemptReplay: MutationPhaseInput["attemptReplay"];
  readonly replayOpts: Parameters<typeof mutationReplay>[2];
  readonly mutations: JourneyVerifyMutation[];
  readonly suggested: JourneyTargetedProofPlan[];
  readonly seenSuggestions: Set<string>;
  readonly stepControls: Map<number, Replayed[]>;
  readonly retriesOf: Map<string, readonly { readonly reason: string }[]>;
  readonly state: MutationPhaseState;
  readonly proofState: ProofState;
}

const asRecorded = (j: Journey): MutationReplay => ({ journey: j });

/** The one place a replay of a pair runs, so each is kept as a record of its kind. */
function buildPairTools(input: PairToolsInput): PairTools {
  const { opts, runOpts, journey, plan, sites, pace, stepsTotal, settleBoundMs, writeScope, writeSteps, baseProbe, baseline, boundedRun, checkpoint, taint, attemptReplay, replayOpts, mutations, suggested, seenSuggestions, stepControls, retriesOf, state, proofState } = input;
  const replayContext: ReplayContext = {
    opts, runOpts, journey, pace, stepsTotal, settleBoundMs, writeScope, writeSteps, baseProbe, boundedRun, taint,
    noteWritesInFlight: (n) => void (state.replayWritesInFlight = Math.max(state.replayWritesInFlight, n)),
    noteCountedOpen: (n) => void (state.countedOpen += n),
    noteIndependenceOpen: (lines) => void (state.independenceOpen = lines),
    baseline,
    judgesRequest: (m) => m.kind === "skip" && plan.pairs.some((p) => {
      const site = p.mutation === m.id ? sites.find((s) => assertionSiteKey(s) === p.site) : undefined;
      return site?.where === "end-state" && (site.check.kind === "requestMade" || site.check.kind === "responseStatus");
    }),
  };
  // #778: one infrastructure error must not cost the proof, so a replay that errored before opening a
  // browser, as on an admission timeout, runs once more. One that opened a browser may have changed the
  // app, and a retry failing on that leftover state would read as proof, so it stays an error. A
  // `failed` replay is a result and a stall ends the proof: neither gets here. A replay that never
  // started (`describe` refused it, as a targeted proof's bad relaxation) would only be refused again.
  const attemptWithRetry = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: ReplayKind, matchTo?: SiteArrivals): Promise<Replayed> => {
    const before = proofState.replays;
    const sessionsBefore = proofState.sessionsOpened;
    const first = await attemptReplay(replayContext, m, describe, false, kind, matchTo);
    if (first.outcome !== "error" || proofState.replays === before || proofState.sessionsOpened !== sessionsBefore) return first;
    retriesOf.set(m.id, [...(retriesOf.get(m.id) ?? []), { reason: first.reason ?? "unknown error" }]);
    return attemptReplay(replayContext, m, describe, true, kind, matchTo);
  };
  // #787: the one place a replay of a pair runs, so each is kept as a record of its kind. A new kind is a new name here and in `REPLAY_RECORD_KINDS`.
  const runReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: ReplayKind, matchTo?: SiteArrivals): Promise<Replayed> => {
    state.replayWritesInFlight = 0;
    state.countedOpen = 0;
    const ran = await attemptWithRetry(m, describe, kind, matchTo);
    state.pairReplays.push(checkpointReplayOf(kind, ran, state.replayWritesInFlight));
    state.ledger.push({ role: LEDGER_ROLE[kind], ...(kind === "independence" ? {} : { mutation: m.id }), outcome: ran.outcome, openAtClose: { known: true, value: state.countedOpen } });
    return ran;
  };
  // #402: a named mutation lowers to its `MutationReplay`; #609's targeted proof passes one directly.
  const replay = (m: JourneyMutation, describe: typeof mutationReplay, kind: ReplayKind): Promise<Replayed> => runReplay(m, (j) => describe(j, m, replayOpts), kind);
  // #616: a proof the automatic bound stopped names the plan a human could declare instead.
  const noteSuggestion = (proof: TargetedProof, m: JourneyMutation): void => {
    const suggestion = suggestTargetedProofPlan(proof, m);
    if (suggestion === null) return;
    const key = `${suggestion.check}\u0000${suggestion.mustFailWhen}\u0000${suggestion.relax.join(",")}`;
    if (seenSuggestions.has(key)) return;
    seenSuggestions.add(key);
    suggested.push(suggestion);
  };
  // Sibling mutations of a step have the same floors, so they share a matched control while it reached their sites together with them.
  const controlFor = async (m: JourneyMutation, runs: readonly Replayed[], sitesAtStake: readonly string[]): Promise<Replayed> => {
    const known = (stepControls.get(m.step) ?? []).find((c) => runs.every((r) => sitesUnmatchedBy(r.failedSites.filter((f) => sitesAtStake.includes(siteKeyOf(f))), r, c, paceMarginOf(pace, m)).length === 0));
    if (known !== undefined) {
      // Each pair keeps a record of the control it read, whoever ran it: one that left a write open ended the proof.
      state.pairReplays.push(checkpointReplayOf("control", known, 0));
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
  return { replay, runReplay, controlFor, resultsSoFar, noteSuggestion };
}

/** The state the independence proof reads and writes while it runs. */
interface IndependenceInput {
  readonly first: JourneyMutation;
  readonly runReplay: PairContext["runReplay"];
  readonly baseOpenLines: readonly string[];
  readonly writeScope: WriteScope;
  readonly baseMs: number;
  readonly stepsTotal: number;
  readonly settleBoundMs: number;
  readonly boundedRun: BoundedRun;
  readonly runOpts: ReplayOptions;
  readonly stepControls: Map<number, Replayed[]>;
  readonly taint: Taint;
  readonly tainted: () => boolean;
  readonly checkpoint: ProofCheckpointSession | undefined;
  readonly state: MutationPhaseState;
}

/**
 * A replay straight after the base, floored as the first mutated replay will be. What the base left
 * running, however it started (a GET, a socket, a popup), meets it where it would meet that replay.
 * A failure alone cannot say whether state crossed over or the floor itself breaks a claim that only
 * lasts so long, so it is run again after a quiet gap: a pass means state crossed. A second failure
 * is the floor if the Journey still passes unheld, and state that stuck if it does not.
 */
export async function provePairIndependence(input: IndependenceInput): Promise<void> {
  const { first, runReplay, baseOpenLines, writeScope, baseMs, stepsTotal, settleBoundMs, boundedRun, runOpts, stepControls, taint, tainted, checkpoint, state } = input;
  const floored = await runReplay(first, asRecorded, "independence");
  // A write still open at the bound in the base and the next replay is a long-lived connection. Open only in the base, it was a real one.
  if (baseOpenLines.some((line) => !state.independenceOpen.includes(line))) {
    state.baseOpenAtClose = baseOpenLines.length;
    taint("base-write-open", null, isolationReason("base-write-open", null, baseOpenLines));
    return;
  }
  writeScope.addBackground(baseOpenLines);
  if (floored.outcome === "error") {
    state.isolation = { known: false, reason: "replay-errored" };
    taint("independence-errored");
    return;
  }
  if (floored.outcome === "passed") {
    state.isolation = { known: true, value: "isolated" };
    stepControls.set(first.step, [floored]);
    checkpoint?.independence("passed");
    return;
  }
  if (tainted()) return;
  await clock.sleep(Math.max(QUIET_GAP_MIN_MS, 2 * baseMs));
  const again = await runReplay(first, asRecorded, "independence");
  if (again.outcome === "passed") {
    state.isolation = { known: true, value: "state-crossed" };
    taint("state-crossed");
    return;
  }
  if (again.outcome === "error") {
    state.isolation = { known: false, reason: "replay-errored" };
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
    state.ledger.push({ role: "independence", outcome: unheld.outcome === "ok" ? "passed" : "failed", openAtClose: { known: true, value: unheldOpen() } });
    if (unheld.outcome !== "ok") {
      state.isolation = { known: true, value: "state-crossed" };
      taint("state-stuck");
    }
  } catch (err) {
    if (err instanceof JourneyVerifyStalledError || err instanceof ProofHoldRefusedError) throw err;
    state.ledger.push({ role: "independence", outcome: "error", openAtClose: { known: true, value: unheldOpen() } });
    state.isolation = { known: false, reason: "replay-errored" };
    taint("independence-errored");
    return;
  }
  if (tainted()) return;
  state.isolation = { known: true, value: "isolated" };
  stepControls.set(first.step, [again]);
  checkpoint?.independence("hold-breaks-claim");
}

/**
 * The mutation phase: proves independence, then runs every planned mutation with its control,
 * reusing the pairs a resume finished and settling any sibling disagreement. The taint it meets ends
 * it wherever it is; the verdicts it recorded are returned for the report.
 */
export async function proveMutationPairs(input: MutationPhaseInput): Promise<MutationProofResult> {
  const { opts, runOpts, journey, plan, sites, pace, stepsTotal, baseMs, settleBoundMs, writeScope, writeSteps, baseProbe, baseline, boundedRun, checkpoint, resuming, taint, tainted, attemptReplay, runPair, settleDisagreements, proofState } = input;
  const mutations: JourneyVerifyMutation[] = [];
  // #616: automatic targeted proofs stopped at their relaxation bound, each a reviewable start.
  const suggested: JourneyTargetedProofPlan[] = [];
  const seenSuggestions = new Set<string>();
  const state: MutationPhaseState = { ledger: [], isolation: { known: false, reason: "not-gathered" }, baseOpenAtClose: 0, independenceOpen: [], replayWritesInFlight: 0, countedOpen: 0, pairReplays: [] };
  // #565: a param mutation's replay runs with altered params (never a secret's), so it needs them.
  const replayOpts = { ...(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests }), params: opts.params };
  const baseOpenLines = baseProbe.openLinesAtClose;
  const siteByKey = new Map(sites.map((s) => [assertionSiteKey(s), s]));
  const stepControls = new Map<number, Replayed[]>();
  const retriesOf = new Map<string, readonly { readonly reason: string }[]>();
  const tools = buildPairTools({ opts, runOpts, journey, plan, sites, pace, stepsTotal, settleBoundMs, writeScope, writeSteps, baseProbe, baseline, boundedRun, checkpoint, taint, attemptReplay, replayOpts, mutations, suggested, seenSuggestions, stepControls, retriesOf, state, proofState });
  const pairContext: PairContext = { journey, plan, pace, siteByKey, replayOpts, mutations, checkpoint, tainted, taint, replay: tools.replay, runReplay: tools.runReplay, controlFor: tools.controlFor, resultsSoFar: tools.resultsSoFar, noteSuggestion: tools.noteSuggestion, retriesOf, pairReplays: state.pairReplays };
  const firstMutation = plan.mutations[0];
  // On a resume too: it answers for the base just measured, so a checkpoint never stands in for it.
  if (firstMutation !== undefined && pace.stepEndMs.length > 0 && !tainted()) {
    checkpoint?.phase("independence");
    if (baseOpenLines.some((line) => writeScope.isRecorded(line))) {
      state.baseOpenAtClose = baseOpenLines.length;
      taint("base-write-open", null, isolationReason("base-write-open", null, baseOpenLines));
    } else {
      await provePairIndependence({ first: firstMutation, runReplay: tools.runReplay, baseOpenLines, writeScope, baseMs, stepsTotal, settleBoundMs, boundedRun, runOpts, stepControls, taint, tainted, checkpoint, state });
    }
  }
  for (const m of plan.mutations) {
    if (tainted()) break;
    // #787: a finished pair is not run again. It reaches the same judging below as a pair just run.
    const kept = resuming?.pairs.get(m.id);
    if (kept !== undefined) {
      mutations.push(reusedMutation(kept));
      for (const proof of reusedProofFields(kept).targeted ?? []) tools.noteSuggestion(proof, m);
      continue;
    }
    await runPair(pairContext, m);
  }

  await settleDisagreements(pairContext);
  return { mutations, suggested, ledger: state.ledger, isolation: state.isolation, baseOpenAtClose: state.baseOpenAtClose };
}
