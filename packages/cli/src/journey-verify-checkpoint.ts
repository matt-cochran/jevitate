import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { clock } from "@jevitate/domain";
import {
  assertionSiteKey,
  needsRelaxedReplay,
  sitesReachedEarly,
  thinSites,
  type Journey,
  type JourneyAssertionSite,
  type JourneyMutation,
  type MutationFailedSite,
  type MutationPlan,
  type MutationRunResult,
  type ReplayPace,
  type TargetedProof,
} from "@jevitate/journey";
import { classifyMutation } from "@jevitate/adjudicator";
import { readProofVerdict, type MutationProofVerdict } from "./journey-verify-report.js";
import {
  JourneyVerifyResumeRefusedError,
  ageRefusal,
  canonicalJson,
  currentVerifierIdentity,
  finishedForGood,
  keyed,
  macMatches,
  mutationPlanDigest,
  optional,
  reusableOnResume,
  reusedProofFields,
  storableRefusal,
  structuredSites,
  unknownRecordKind,
  verifierStateOf,
  type CheckpointBody,
  type CheckpointPair,
  type IsolationNote,
  type ResumeRefusalReason,
} from "./journey-verify-checkpoint-binding.js";
import { createCheckpointKey, readCheckpointFile, readCheckpointKey, withCheckpointLock, writeCheckpointFile } from "./journey-verify-checkpoint-store.js";
export {
  CHECKPOINT_MAX_AGE_MS,
  REFUSAL_NOT_KEPT,
  REPLAY_RECORD_KINDS,
  JourneyVerifyResumeRefusedError,
  browserBindingOf,
  canonicalJson,
  hookBindingOf,
  reusedProofFields,
  verifierStateOf,
} from "./journey-verify-checkpoint-binding.js";
export { currentVerifierIdentity, mutationPlanDigest };
export type { CheckpointBody, CheckpointPair, IsolationNote, ResumeRefusalReason } from "./journey-verify-checkpoint-binding.js";
/** @public: kept on this module's surface for a reader of a checkpoint's status. */
export type { VerifierState } from "./journey-verify-checkpoint-binding.js";
export { checkpointKeyPath, createCheckpointKey, readCheckpointKey, verifyCheckpointPath } from "./journey-verify-checkpoint-store.js";
export { isLiveVerifyReceipt, readVerifyProgress, verifyProgressLine } from "./journey-verify-checkpoint-progress.js";
/** @public: kept on this module's surface for a reader of a checkpoint's status. */
export type { VerifyProgressStatus } from "./journey-verify-checkpoint-progress.js";

/**
 * #787: the durable progress of `journey verify --mutate`, one small file per Journey and journey
 * store under `<project>/.jevitate/logs/verify-progress/`, replaced atomically as the proof moves.
 * A "pair" here is one planned mutation with all its replays (first, relaxed, control, targeted),
 * since that is the unit of work a proof finishes: `pairs` in the plan are site↔mutation links.
 *
 * What it stores is what a resumed verdict needs and nothing the app or the operator wrote: outcome
 * classes, structured failed sites, site keys, mutation ids, timings and counts. Never a `reason`, a
 * blocked write's path, hook text, a parameter value or a Journey value. Hooks, params, origins and
 * browser settings are bound by HMAC-SHA-256 under a random key kept in `~/.jevitate/` (0600), never in
 * the project: a plain hash of a short secret parameter could be guessed offline from this file. The
 * same key signs the file, so a change by someone who can write to `.jevitate/` but cannot read the
 * home key refuses the resume. The MAC proves the file came from this user's own runs; it does not
 * stop that user's own processes, which can read the key, nor a rollback to an older genuine file.
 */

/** What a retry's error says on a reused pair: errors can quote the app, so only their count is stored. */
export const RETRY_REASON_NOT_KEPT = "not kept in the checkpoint";

/** Whose failure a control already answers for, or that the proof never reads as thin. Any other kind, a new one too, gets the thin check. */
const NOT_THIN_CHECKED: ReadonlySet<string> = new Set(["targeted", "control", "targeted-control", "at-base-time"]);

export type CheckpointReplay = CheckpointPair["replays"][number];

/** What a proof's checkpoint is bound to, from the command that runs it. Everything but `build` is only ever digested. */
export interface ProofCheckpointRequest {
  readonly path: string;
  readonly keyFile: string;
  readonly resume: boolean;
  readonly build: CheckpointBody["build"];
  readonly config: { readonly hook: unknown; readonly origin: unknown; readonly browser: unknown };
  /** A short, value-free line for the operator: why this run keeps no progress, or what it replaced or reused. */
  readonly onNotice?: (text: string) => void;
}

/** Every reused result against the plan and the Journey: a result the plan could not have produced refuses the resume. */
function pairProblems(body: CheckpointBody, plan: MutationPlan, journey: Journey, sites: readonly JourneyAssertionSite[]): string | undefined {
  const stepCount = journey.recording.pages.reduce((n, p) => n + p.steps.length, 0);
  const keys = new Set(sites.map(assertionSiteKey));
  const siteProblem = (f: MutationFailedSite): boolean => ("step" in f && f.step > stepCount) || (f.where === "end-state" && !keys.has(`end-state:${f.index}`));
  if (body.total !== plan.mutations.length) return `it counts ${body.total} pairs and the plan ${plan.mutations.length}`;
  if (body.completed.length > plan.mutations.length) return "it holds more results than the plan has pairs";
  if (body.taint.notIsolatedBy !== null && !plan.mutations.some((m) => m.id === body.taint.notIsolatedBy)) return "its isolation note names no planned pair";
  for (const [i, pair] of body.completed.entries()) {
    const m = plan.mutations[i]!;
    if (pair.id !== m.id || pair.kind !== m.kind || pair.step !== m.step || pair.param !== m.param || pair.source !== m.source) return `result ${i + 1} is not planned pair ${m.id}`;
    const runs: { outcome: MutationRunResult["outcome"]; failedSites: readonly MutationFailedSite[] }[] = [pair, ...(pair.relaxed === undefined ? [] : [pair.relaxed]), ...(pair.targeted ?? [])];
    for (const run of runs) {
      if (run.outcome !== "failed" && run.failedSites.length > 0) return `${m.id} has failed sites on a replay that did not fail`;
      if (run.failedSites.some(siteProblem)) return `${m.id} names a site this Journey does not have`;
    }
    if (pair.replays.some((r) => r.failedSites.some(siteProblem))) return `${m.id} names a site this Journey does not have`;
    if (pair.replays.some((r) => r.outcome !== "failed" && r.failedSites.length > 0)) return `${m.id} has failed sites on a replay that did not fail`;
    if ((pair.relaxed !== undefined) !== needsRelaxedReplay(plan, m, pair)) return `${m.id} does not hold the replays its first result calls for`;
    for (const t of pair.targeted ?? []) {
      if (!keys.has(t.site)) return `${m.id} has a targeted proof of a site this Journey does not have`;
      if (!plan.pairs.some((p) => p.mutation === m.id && p.site === t.site)) return `${m.id} has a targeted proof of a site it is not paired with`;
    }
    // Every result the verdict reads must stand on a replay record that says the same.
    const ofKind = (kind: string): readonly CheckpointReplay[] => pair.replays.filter((r) => r.kind === kind);
    const sameRun = (r: CheckpointReplay, run: { outcome: string; failedSites: readonly MutationFailedSite[] }): boolean => r.outcome === run.outcome && canonicalJson(r.failedSites) === canonicalJson(run.failedSites);
    if (ofKind("first").length !== 1 || !sameRun(ofKind("first")[0]!, pair)) return `${m.id} has no replay record for its first result`;
    if (pair.relaxed === undefined ? ofKind("relaxed").length !== 0 : ofKind("relaxed").length !== 1 || !sameRun(ofKind("relaxed")[0]!, pair.relaxed)) return `${m.id} has no replay record for its relaxed result`;
    if (pair.control === undefined ? ofKind("control").length !== 0 : ofKind("control").length !== 1 || ofKind("control")[0]!.outcome !== pair.control) return `${m.id} has no replay record for its control`;
    for (const t of pair.targeted ?? []) {
      // A proof refused on the mutated replay's own control repeats that control's class, and ran none of its own.
      if (t.control !== undefined && t.control !== pair.control && !ofKind("targeted-control").some((r) => r.outcome === t.control)) return `${m.id} has no replay record for a targeted control`;
    }
  }
  return undefined;
}

/**
 * The one isolation note a resume can answer: it says the independence replay gave no reading, not that
 * state crossed. A resume never reuses that replay's answer and runs it against the base it re-measures,
 * so dropping the note leaves that fresh run to decide; if it errors too, the note comes back.
 */
export const isRepairableIsolation = (taint: CheckpointBody["taint"]): boolean => taint.isolation === "independence-errored" && !taint.restoreFailed;

/** Why a finished proof takes no resume. One a replay may have decided has nothing a resume could stand on, and it says what will help. */
function finishedDetail(body: CheckpointBody): string {
  const ended = `this proof already finished (${body.verdict === undefined ? "no verdict" : readProofVerdict(body.verdict)})`;
  const tainted = body.taint.restoreFailed || body.taint.notIsolatedBy !== null || body.taint.isolation !== null;
  return tainted ? `${ended}, and a replay may have decided another, so no result of it can be reused; fix that cause, then rerun with plain --mutate` : `${ended}; its receipt stands`;
}

export interface ResumeState {
  readonly pairs: ReadonlyMap<string, CheckpointPair>;
  readonly restoreFailed: boolean;
  readonly notIsolatedBy: string | null;
  /** Why a replay may have decided another. Absent or null with `notIsolatedBy` set: a replay closed with a write open. */
  readonly isolation?: IsolationNote | null;
}

/** One proof's writer. A failed write never ends a proof: the next one writes everything again. */
export class ProofCheckpointSession {
  #body: CheckpointBody;
  #failed = false;

  constructor(
    readonly path: string,
    readonly key: Buffer,
    body: CheckpointBody,
    readonly onNotice: (text: string) => void,
  ) {
    this.#body = body;
  }

  get body(): CheckpointBody {
    return this.#body;
  }

  #write(change: Partial<CheckpointBody>): boolean {
    this.#body = { ...this.#body, ...change, updatedAt: clock.nowIso() };
    try {
      writeCheckpointFile(this.path, this.key, this.#body);
      this.#failed = false;
      return true;
    } catch (err) {
      if (!this.#failed) this.onNotice(`journey verify: progress could not be saved (${(err as NodeJS.ErrnoException).code ?? "error"}); the proof goes on, and a resume may repeat work`);
      this.#failed = true;
      return false;
    }
  }

  replayStarted(replay: number): void {
    this.#write({ replay });
  }

  independence(independence: NonNullable<CheckpointBody["independence"]>): void {
    this.#write({ independence });
  }

  phase(phase: CheckpointBody["phase"]): void {
    this.#write({ phase, currentPair: null });
  }

  startPair(id: string): void {
    this.#write({ phase: "pairs", currentPair: id });
  }

  /** A pair run again after it errored takes its own place, so `completed` stays in the plan's order. */
  finishPair(pair: CheckpointPair): void {
    const known = this.#body.completed.some((p) => p.id === pair.id);
    this.#write({ completed: known ? this.#body.completed.map((p) => (p.id === pair.id ? pair : p)) : [...this.#body.completed, pair], currentPair: null });
  }

  /**
   * Written the moment it happens: a taint that dies with the process could turn a resumed proof `proven`.
   * So if it cannot be written (a full disk), the older file without it must not stay resumable. A later
   * write that succeeds carries the taint, since each write holds the whole body.
   */
  taint(change: Partial<CheckpointBody["taint"]>): void {
    if (this.#write({ taint: { ...this.#body.taint, ...change } })) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Nothing more can be done here: the proof itself still carries the taint to its verdict.
    }
  }

  finish(verdict: MutationProofVerdict, errorGap: boolean): void {
    this.#write({ state: "finished", verdict, currentPair: null, ...(errorGap ? { errorGap: true as const } : {}) });
  }

  /** The proof ended with no verdict, in a process that may go on (an MCP server), so its pid no longer says anything. */
  interrupted(): void {
    if (this.#body.state === "running") this.#write({ state: "interrupted" });
  }
}

export interface OpenedCheckpoint {
  readonly session?: ProofCheckpointSession;
  readonly resume?: ResumeState;
}

const refuse = (reason: ResumeRefusalReason, detail: string): never => {
  throw new JourneyVerifyResumeRefusedError(reason, detail);
};

/**
 * Claims the checkpoint for this run, before any browser. A resume returns the results it may reuse or
 * refuses by name. A fresh run replaces an ended checkpoint and leaves a live verifier's alone, going
 * on without progress of its own, since a proof that ran before this file existed must still run.
 */
export async function openProofCheckpoint(
  req: ProofCheckpointRequest,
  proof: { readonly journey: Journey; readonly journeyHash: string; readonly plan: MutationPlan; readonly params: Readonly<Record<string, string>>; readonly sites: readonly JourneyAssertionSite[] },
): Promise<OpenedCheckpoint> {
  const notice = req.onNotice ?? ((): void => undefined);
  const journeyId = proof.journey.metadata.id;
  let keyRead = readCheckpointKey(req.keyFile);
  if ("missing" in keyRead && !req.resume) {
    try {
      createCheckpointKey(req.keyFile);
      keyRead = readCheckpointKey(req.keyFile);
    } catch (err) {
      keyRead = { problem: `it could not be created (${(err as NodeJS.ErrnoException).code ?? "error"})` };
    }
  }
  if (!("key" in keyRead)) {
    const why = "missing" in keyRead ? "it does not exist" : keyRead.problem;
    if (req.resume) return refuse("key-unavailable", `the checkpoint key ${req.keyFile} cannot be used: ${why}`);
    notice(`journey verify: no progress is kept for this run, because the checkpoint key ${req.keyFile} cannot be used: ${why}`);
    return {};
  }
  const { key } = keyRead;
  const bindings = {
    params: keyed(key, "params", proof.params),
    hook: keyed(key, "hook", req.config.hook),
    origin: keyed(key, "origin", req.config.origin),
    browser: keyed(key, "browser", req.config.browser),
  };
  const planDigest = mutationPlanDigest(proof.plan);
  const now = clock.nowIso();
  const fresh: CheckpointBody = {
    schema: 2,
    journeyId,
    journeyHash: proof.journeyHash,
    planDigest,
    bindings,
    build: req.build,
    total: proof.plan.mutations.length,
    completed: [],
    phase: "base",
    currentPair: null,
    replay: 0,
    startedAt: now,
    updatedAt: now,
    state: "running",
    reusedPairs: 0,
    independence: null,
    taint: { restoreFailed: false, notIsolatedBy: null, isolation: null },
    verifier: currentVerifierIdentity(),
  };

  const claimFresh = (): OpenedCheckpoint => {
    const found = readCheckpointFile(req.path);
    if (found.kind === "not-regular") {
      notice(`journey verify: no progress is kept for this run: something other than a regular file is at ${req.path}`);
      return {};
    }
    if (found.kind === "read" && macMatches(key, found.body, found.mac)) {
      const verifier = verifierStateOf(found.body);
      if (verifier === "live" || (verifier === "stale" && found.body.verifier.host !== hostname())) {
        notice(`journey verify: no progress is kept for this run: verifier ${found.body.verifier.pid} owns ${req.path}`);
        return {};
      }
      if (found.body.state !== "finished" && found.body.completed.length > 0) notice(`journey verify: starting again replaces a checkpoint with ${found.body.completed.length} finished pairs; --resume would have reused them`);
    }
    try {
      writeCheckpointFile(req.path, key, fresh);
    } catch (err) {
      notice(`journey verify: no progress is kept for this run: ${(err as NodeJS.ErrnoException).code ?? "the checkpoint could not be written"}`);
      return {};
    }
    return { session: new ProofCheckpointSession(req.path, key, fresh, notice) };
  };

  const claimResume = (): OpenedCheckpoint => {
    const found = readCheckpointFile(req.path);
    if (found.kind === "none") return refuse("no-checkpoint", `there is no checkpoint for journey '${journeyId}' at ${req.path}`);
    if (found.kind === "not-regular") return refuse("not-regular-file", `something other than a regular file is at ${req.path}`);
    if (found.kind === "corrupt") return refuse("corrupt", `the checkpoint at ${req.path} cannot be used: ${found.detail}`);
    const { body } = found;
    if (!macMatches(key, body, found.mac)) return refuse("integrity", `the checkpoint at ${req.path} does not carry this user's key: it was changed outside jevitate, or the key was replaced`);
    if (body.journeyId !== journeyId) return refuse("corrupt", `the checkpoint at ${req.path} belongs to another Journey`);
    const verifier = verifierStateOf(body);
    if (verifier === "live") return refuse("live-verifier", `verifier ${body.verifier.pid} is still running this proof; read it with --status`);
    if (body.state === "running" && body.verifier.host !== hostname()) return refuse("other-host", `verifier ${body.verifier.pid} ran on host ${body.verifier.host}, where this host cannot check it`);
    if (finishedForGood(body)) return refuse("finished", finishedDetail(body));
    if (body.journeyHash !== proof.journeyHash) return refuse("journey-hash", "the Journey changed since the checkpoint");
    if (body.planDigest !== planDigest) return refuse("mutation-plan", "the mutation plan changed since the checkpoint");
    if (body.bindings.params !== bindings.params) return refuse("params", "the parameters differ from the checkpoint's");
    if (body.bindings.hook !== bindings.hook) return refuse("hook", "the hooks or fixtures differ from the checkpoint's");
    if (body.bindings.origin !== bindings.origin) return refuse("origin", "the environment, base URL, allowed origins or read requests differ from the checkpoint's");
    if (body.bindings.browser !== bindings.browser) return refuse("browser", "the browser, emulation or session settings differ from the checkpoint's");
    if (req.build.commit === "unknown" || req.build.builtAt === "unknown") return refuse("cli-build", "this build cannot say which build it is, so it cannot be shown to be the checkpoint's");
    if (canonicalJson(body.build) !== canonicalJson(req.build)) return refuse("cli-build", `the checkpoint was written by ${body.build.version} (${body.build.commit}, built ${body.build.builtAt}) and this is ${req.build.version} (${req.build.commit}, built ${req.build.builtAt})`);
    const unknown = unknownRecordKind(body);
    if (unknown !== undefined) return refuse("unknown-record", `the checkpoint holds a replay record of kind '${unknown}', which this build cannot re-check`);
    const old = ageRefusal(body);
    if (old !== undefined) return refuse("too-old", old);
    const invalid = pairProblems(body, proof.plan, proof.journey, proof.sites);
    if (invalid !== undefined) return refuse("corrupt", `the checkpoint at ${req.path} cannot be used: ${invalid}`);
    // A pair run again stays on file until its new result takes its place, and is never reused.
    const reused = body.completed.filter(reusableOnResume);
    const { verdict: _verdict, errorGap: _errorGap, ...unfinished } = body;
    const taint = body.taint.isolation === "independence-errored" ? { ...body.taint, isolation: null, notIsolatedBy: null } : body.taint;
    const claimed: CheckpointBody = { ...unfinished, taint, state: "running", phase: "base", independence: null, currentPair: null, replay: 0, reusedPairs: reused.length, updatedAt: clock.nowIso(), verifier: currentVerifierIdentity() };
    try {
      // A resume that cannot record its claim cannot keep a second verifier out.
      writeCheckpointFile(req.path, key, claimed);
    } catch (err) {
      return refuse("not-writable", `the claim could not be written to ${req.path} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    const again = body.completed.length - reused.length;
    notice(`journey verify: resuming with ${reused.length} of ${body.total} pairs finished${again === 0 ? "" : ` and ${again} errored or short of a control, which run again`}; the base replay runs first and must pass before any is reused`);
    const session = new ProofCheckpointSession(req.path, key, claimed, notice);
    return { session, resume: { pairs: new Map(reused.map((p) => [p.id, p])), restoreFailed: taint.restoreFailed, notIsolatedBy: taint.notIsolatedBy, isolation: taint.isolation } };
  };

  const opened = await withCheckpointLock(req.path, req.resume ? claimResume : claimFresh).catch((err: unknown) => {
    if (err instanceof JourneyVerifyResumeRefusedError) throw err;
    if (req.resume) return refuse("not-writable", `the checkpoint could not be claimed (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    notice(`journey verify: no progress is kept for this run: ${(err as NodeJS.ErrnoException).code ?? "the checkpoint could not be claimed"}`);
    return {} satisfies OpenedCheckpoint;
  });
  if (opened !== "busy") return opened;
  if (req.resume) return refuse("live-verifier", "another process is claiming this checkpoint right now");
  notice("journey verify: no progress is kept for this run: another process is claiming its checkpoint");
  return {};
}

/** A finished pair's result as `journey-verify` reports it, field by field: anything not named here cannot reach the file. */
export interface FinishedPair {
  readonly id: string;
  readonly kind: JourneyMutation["kind"];
  readonly step: number;
  readonly param?: string;
  readonly source?: JourneyMutation["source"];
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  readonly waitsCut?: readonly string[];
  readonly relaxed?: { readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[]; readonly waitsCut?: readonly string[]; readonly atBaseTime?: MutationRunResult["atBaseTime"] };
  readonly control?: MutationRunResult["outcome"];
  readonly controlSkipped?: true;
  readonly atBaseTime?: MutationRunResult["atBaseTime"];
  readonly targeted?: readonly TargetedProof[];
  readonly retries?: readonly unknown[];
}

const storedAtBaseTime = (run: MutationRunResult["atBaseTime"]): { outcome: MutationRunResult["outcome"]; failedSites: MutationFailedSite[] } | undefined =>
  run === undefined ? undefined : { outcome: run.outcome, failedSites: structuredSites(run.failedSites) };

export function checkpointPairOf(pair: FinishedPair, replays: readonly CheckpointReplay[]): CheckpointPair {
  return {
    id: pair.id,
    kind: pair.kind,
    step: pair.step,
    ...optional("param", pair.param),
    ...optional("source", pair.source),
    outcome: pair.outcome,
    failedSites: structuredSites(pair.failedSites),
    ...optional("waitsCut", pair.waitsCut === undefined ? undefined : [...pair.waitsCut]),
    ...optional(
      "relaxed",
      pair.relaxed === undefined ? undefined : { outcome: pair.relaxed.outcome, failedSites: structuredSites(pair.relaxed.failedSites), ...optional("waitsCut", pair.relaxed.waitsCut === undefined ? undefined : [...pair.relaxed.waitsCut]), ...optional("atBaseTime", storedAtBaseTime(pair.relaxed.atBaseTime)) },
    ),
    ...optional("control", pair.control),
    ...optional("controlSkipped", pair.controlSkipped),
    ...optional("atBaseTime", storedAtBaseTime(pair.atBaseTime)),
    ...optional(
      "targeted",
      pair.targeted?.map((t) => ({
        site: t.site,
        relaxedSites: [...t.relaxedSites],
        outcome: t.outcome,
        failedSites: structuredSites(t.failedSites),
        ...optional("refused", t.refused === undefined ? undefined : storableRefusal(t.refused)),
        ...optional("control", t.control),
        ...optional("declared", t.declared),
      })),
    ),
    retries: pair.retries?.length ?? 0,
    finishedAt: clock.nowIso(),
    replays: [...replays],
  };
}

/** One replay in the file's form, by kind. Named fields only, so a `reason` on the run cannot reach the file. */
export function checkpointReplayOf(kind: string, run: { readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[]; readonly reachedMs?: readonly (number | undefined)[]; readonly endStateReachedMs?: number }, writesInFlightAtClose: number): CheckpointReplay {
  return { kind, outcome: run.outcome, failedSites: structuredSites(run.failedSites), reachedMs: Array.from(run.reachedMs ?? [], (ms) => ms ?? null), ...optional("endStateReachedMs", run.endStateReachedMs), writesInFlightAtClose };
}

const undefinedHoles = (reached: readonly (number | null)[]): (number | undefined)[] => reached.map((ms) => ms ?? undefined);

/**
 * The reused results against a base measured just now. A reused replay was paced to the base of its own
 * run. Under the rule (`evidenceRefusal`) its failure is evidence only if it got there no sooner than an
 * unmutated replay passes that site, and the replay that says so now is the re-measured one. So each
 * reused failure is read again against the new pace, by the same functions the proof uses: reached
 * sooner than the new base, or newly thin with no control that answered for it, refuses the whole resume.
 * A failed replay already cut needs nothing: it counts for nothing either way. A faster base only
 * leaves a reused replay more room. Every record goes through the same loop whatever its kind, controls
 * included. Writes left open are compared as the proof compares them.
 */
export function resumeRefusalAgainstBase(state: ResumeState, plan: MutationPlan, sites: readonly JourneyAssertionSite[], pace: ReplayPace, baseWritesInFlightAtClose: number): JourneyVerifyResumeRefusedError | undefined {
  const siteByKey = new Map(sites.map((s) => [assertionSiteKey(s), s]));
  for (const m of plan.mutations) {
    const pair = state.pairs.get(m.id);
    if (pair === undefined) continue;
    for (const r of pair.replays) {
      if (r.writesInFlightAtClose > baseWritesInFlightAtClose) {
        return new JourneyVerifyResumeRefusedError("isolation", `a ${r.kind} replay of ${m.id} closed with ${r.writesInFlightAtClose} writes open and the re-measured base with ${baseWritesInFlightAtClose}, so it may have decided a later replay`);
      }
    }
    const result = reusedProofFields(pair);
    // Only a site read sensitive can turn into a false `proven`: a pair with none cannot change by being cut.
    const sensitive = plan.pairs.filter((p) => {
      const site = siteByKey.get(p.site);
      return p.mutation === m.id && site !== undefined && classifyMutation(site, m, result) === "sensitive";
    });
    if (sensitive.length === 0) continue;
    const cutFor = (r: CheckpointReplay): readonly string[] | undefined => (r.kind === "first" ? pair.waitsCut : r.kind === "relaxed" ? pair.relaxed?.waitsCut : undefined);
    for (const r of pair.replays) {
      // A replay at the base's time only ever says a claim held without the mutation, and a failure there is no reading.
      if (r.outcome !== "failed" || r.kind === "at-base-time" || (cutFor(r)?.length ?? 0) > 0) continue;
      const reached = undefinedHoles(r.reachedMs);
      const early = sitesReachedEarly(r.failedSites, m, pace, reached, r.endStateReachedMs);
      if (early.length > 0) return new JourneyVerifyResumeRefusedError("pace", `a ${r.kind} replay of ${m.id} failed at ${early.join(", ")} sooner than the re-measured base replay passed it, so the reused failure is not evidence`);
      if (NOT_THIN_CHECKED.has(r.kind) || pair.control !== undefined) continue;
      const thin = thinSites(r.failedSites, m, pace, reached, r.endStateReachedMs);
      if (sensitive.some((p) => thin.includes(p.site))) return new JourneyVerifyResumeRefusedError("pace", `a ${r.kind} replay of ${m.id} reached ${thin.join(", ")} with little to spare over the re-measured base replay, and no control replay answers for it`);
    }
  }
  return undefined;
}
