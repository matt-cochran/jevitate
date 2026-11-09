import { DEFAULT_DONE_CHECK_POLICY, type DoneCheckPolicy, type JobBasis, type JobUnknownReason, type JobVerdict, type MissionOutcome } from "@jevitate/domain";
import type { TargetTrust } from "./run-mode.js";
import { isDoneCheckIssues, parseDoneCheck } from "@jevitate/journey";
import { PlaywrightDoneCheckPort } from "./journey-done-check-hook.js";
import { readDoneCheck, type BrowserPort } from "./journey-done-check.js";
import { loadCatalog } from "./catalog-api.js";
import { findJob } from "./catalog.js";
import { loadProjectConfig, ProjectConfigError } from "./project-config.js";
import type { DoneCheckReader } from "./explore-goal.js";
import type { BrowserPort as SessionPort } from "@jevitate/playwright";

/**
 * 0.30.0 (#800, design §3.1): `explore --goal --job <id>` reads the job's done check
 * (`.jevitate/jobs.json` → `jobs[].done`) in a FRESH browser context. Once before the run (a check already true proves nothing:
 * `already-true`) and after each `done` the model proposes (`cfg.doneCheck`). No reading value reaches an error or a reason.
 */

export interface ExploreJobCheckRequest {
  readonly jobId: string;
  readonly catalogDir: string | null;
  readonly journeysDir: string;
  /** The run's start URL (its origin is the only origin a reading may open). */
  readonly startUrl: string;
  readonly storageState?: string | undefined;
  /** Non-secret `--param` values a `${param}` placeholder may name. */
  readonly params?: Readonly<Record<string, string>>;
  readonly browserPort?: BrowserPort | undefined;
  readonly sessionPortFactory?: (() => SessionPort) | undefined;
}

export type ExploreJobCheck =
  | {
      readonly ok: true;
      readonly reader?: DoneCheckReader;
      readonly basis: JobBasis;
      /** With basis `reading-unknown`: why the before reading could not be taken. */
      readonly reason?: JobUnknownReason;
      /** With a reader: why its last reading was unknown (undefined after a known one). */
      readonly lastUnknownReason?: () => JobUnknownReason | undefined;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Resolves the job's check and takes the before reading. A job that is unknown is refused; a job with no usable check reads `unverified`. */
export async function prepareJobDoneCheck(req: ExploreJobCheckRequest): Promise<ExploreJobCheck> {
  let done: unknown;
  try {
    const job = findJob(await loadCatalog(req.catalogDir, req.journeysDir), req.jobId);
    if (job === undefined) return { ok: false, code: "E_EXPLORE_JOB", message: `--job: no job '${req.jobId}' in ${req.catalogDir ?? "a .jevitate/ project (none found)"}/jobs.json` };
    done = job.job.done;
  } catch (err) {
    return { ok: false, code: "E_EXPLORE_JOB", message: `--job: the catalog could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (done === undefined) return { ok: true, basis: "no-check" };
  const params = req.params ?? {};
  const spec = parseDoneCheck(done, { bound: Object.keys(params) });
  if (isDoneCheckIssues(spec)) return { ok: true, basis: "reading-unknown", reason: "check-unevaluable" };
  let origin: string;
  try {
    origin = new URL(req.startUrl).origin;
  } catch {
    return { ok: true, basis: "reading-unknown", reason: "check-unevaluable" };
  }
  const port = req.browserPort ?? new PlaywrightDoneCheckPort({ origin, ...(req.sessionPortFactory === undefined ? {} : { sessionPortFactory: req.sessionPortFactory }) });
  const auth = req.storageState === undefined ? {} : { storageState: req.storageState };
  const read = (at: "pre" | "post") => readDoneCheck({ spec, origin, auth, params, extracts: {}, browserPort: port, at });
  const before = await read("pre").catch(() => undefined);
  if (before === undefined) return { ok: true, basis: "reading-unknown", reason: "session-unavailable" };
  if (!before.value.known) return { ok: true, basis: "reading-unknown", reason: before.value.reason };
  if (before.value.value) return { ok: true, basis: "already-true" };
  let lastUnknown: JobUnknownReason | undefined;
  return {
    ok: true,
    basis: "done-check",
    reader: async () => {
      const after = await read("post").catch(() => undefined);
      lastUnknown = after === undefined ? "session-unavailable" : after.value.known ? undefined : after.value.reason;
      return after !== undefined && after.value.known ? after.value.value : null;
    },
    lastUnknownReason: () => lastUnknown,
  };
}

/** The `runExploration` options a prepared check gives: its reader, or why there is none, and why a reading was unknown. */
export function jobCheckRunOptions(check: ExploreJobCheck | undefined): {
  readonly doneCheck?: DoneCheckReader;
  readonly doneCheckBasis?: JobBasis;
  readonly doneCheckUnknownReason?: () => JobUnknownReason | undefined;
} {
  if (check?.ok !== true) return {};
  if (check.reader !== undefined) return { doneCheck: check.reader, ...(check.lastUnknownReason === undefined ? {} : { doneCheckUnknownReason: check.lastUnknownReason }) };
  const reason = check.reason;
  return { doneCheckBasis: check.basis, ...(reason === undefined ? {} : { doneCheckUnknownReason: () => reason }) };
}

/** The policy for an unverified pass: `--require-done-check`, else project.json `doneCheckPolicy`, else `require`. Throws `ProjectConfigError`. */
export function exploreDoneCheckPolicy(catalogDir: string | null, requireDoneCheck: boolean | undefined): DoneCheckPolicy {
  if (requireDoneCheck === true) return "require";
  return loadProjectConfig(catalogDir).doneCheckPolicy ?? DEFAULT_DONE_CHECK_POLICY;
}

export { ProjectConfigError };

/** What a goal run knows when it decides its job verdict (explore-goal.ts, after the mission). */
export interface GoalJobInput {
  /** The run's outcome is `completed` (code accepted a `done`, a `--success`, or a grounded answer). */
  readonly completed: boolean;
  /** The verdict the goal loop attached to that completion (only when a done-check reader was configured). */
  readonly loopJob?: JobVerdict | undefined;
  /** How the completion was verified (`success-condition`, `grounded-answer`, `grounded-judgment`, …). */
  readonly verifiedBy?: string | undefined;
  /** A fresh-context done-check reader was configured (`--job` with a usable check that read false before). */
  readonly hasReader: boolean;
  /** What that reader last said (false: a proposed `done` was rejected by it). */
  readonly lastReading?: boolean | null | undefined;
  /** Why nothing fresh decides the job when there is no reader (`already-true`, `reading-unknown`, `no-check`). */
  readonly basis?: JobBasis | undefined;
  /** rc-030: why the reading that leaves the job `reading-unknown` could not be taken (shown as `job.reason`). */
  readonly unknownReason?: JobUnknownReason | undefined;
  readonly goalOutcome: string;
  /** The folded mission outcome before the decision-3 fold. */
  readonly foldedOutcome: string;
  /** The done-check policy (absent: the result is reported, the exit is not folded). */
  readonly policy?: DoneCheckPolicy | undefined;
  readonly requireDoneCheck?: boolean | undefined;
  /** The target's trust, as the run mode decided it (`run.target.trust`). */
  readonly trust?: TargetTrust | undefined;
}

/**
 * The goal run's job verdict, and whether decision 3 folds its pass to `inconclusive` (exit 2).
 *  - A done check's reading decides the job; otherwise nothing fresh was read (`unverified`).
 *  - rc-030: a run that ends with no verdict from the loop (a `done` the judgment rejected, a blocked or
 *    answered run) is decided by its final fresh reading (`finalJobReading`): false `not-achieved`, true
 *    `achieved` (false before, true after). A reading that could not be taken stays `reading-unknown`, with
 *    its `reason`; it is never turned into true or false.
 *  - #802 (owner, exit-codes.md "Harness"): on a trust `harness` target a reading decides nothing:
 *    `unverified`/`harness`, and the pass is not folded (exit 0), as `journey run` (`doneCheckExitInput`).
 *  - Decision 3 (2026-11-09 clarification): it applies only to a run that claims an end state. A find-out
 *    run's grounded answer (`grounded-answer`) and an independent `--success` check (`success-condition`)
 *    are the run's own verification, so they stand unless `--require-done-check` asks for a done check.
 */
export function goalJobDecision(i: GoalJobInput): { readonly job: JobVerdict | undefined; readonly unverifiedPass: boolean } {
  let job: JobVerdict | undefined =
    i.completed && i.loopJob !== undefined
      ? i.loopJob
      : i.hasReader && i.lastReading === false
        ? { attainment: "not-achieved", basis: "done-check" }
        : i.hasReader && i.lastReading === true
          ? { attainment: "achieved", basis: "done-check" }
          : i.goalOutcome === "succeeded" || i.hasReader || i.basis !== undefined
            ? { attainment: "unverified", basis: i.basis ?? (i.hasReader ? "reading-unknown" : "no-check") }
            : undefined;
  if (job?.basis === "reading-unknown" && job.reason === undefined && i.unknownReason !== undefined) job = { ...job, reason: i.unknownReason };
  // As the journey hook: on a harness, any reading of a valid check (true, false, already true) decides nothing.
  if (i.trust === "harness" && job !== undefined && (i.hasReader || job.basis === "already-true")) job = { attainment: "unverified", basis: "harness" };
  const ownVerification = i.verifiedBy === "success-condition" || i.verifiedBy === "grounded-answer";
  const folds = i.policy === "require" || i.requireDoneCheck === true;
  const unverifiedPass =
    folds && i.foldedOutcome === "clean" && job?.attainment === "unverified" && job.basis !== "harness" && (i.requireDoneCheck === true || !ownVerification);
  return { job, unverifiedPass };
}

/** Code-templated: what a goal run's `done-check-failed` failure says (decision 2). Never a value. */
export const GOAL_DONE_CHECK_FAILED_MESSAGE =
  "the goal run ended passing, but the job's done check read false in a fresh session: the job did not happen";

/**
 * Decision 2 (exit-codes.md): the mission outcome of a goal run with its job verdict folded in.
 *  - `not-achieved` over a pass (`clean`) or a pending review is `defects-found` (exit 1) with
 *    `failure.kind: "done-check-failed"`, whatever verified the pass (a grounded answer, a `--success`
 *    check, the judgment) and whatever the policy: the find-out exemption covers only `unverified`.
 *  - an unverified pass decision 3 folds (`unverifiedPass`) is `inconclusive` (exit 2).
 *  - anything else keeps the folded outcome; a run already failing keeps its own ending.
 */
export function goalJobFold(i: {
  readonly foldedOutcome: MissionOutcome;
  readonly job: JobVerdict | undefined;
  readonly unverifiedPass: boolean;
}): { readonly missionOutcome: MissionOutcome; readonly failure?: { readonly kind: "done-check-failed"; readonly message: string } } {
  if (i.job?.attainment === "not-achieved" && (i.foldedOutcome === "clean" || i.foldedOutcome === "pending-review")) {
    return { missionOutcome: "defects-found", failure: { kind: "done-check-failed", message: GOAL_DONE_CHECK_FAILED_MESSAGE } };
  }
  return { missionOutcome: i.unverifiedPass ? "inconclusive" : i.foldedOutcome };
}
