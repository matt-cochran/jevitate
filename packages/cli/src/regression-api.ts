import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { RecordingSchema, type Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import {
  reproduceFailure,
  reproduceFailureAt,
  NeverFailedError,
  minimizeRecording,
  makeSingleShotReproduces,
  commitRegression,
  replayRegression,
  deriveOracleFromTranscript,
  oracleFromAssertion,
  appendOracleStep,
  fingerprintFailure,
  type FailureFingerprint,
  type MissionTranscriptEntry,
  type DerivedOracle,
  type NetworkCheckOracle,
  type ReproductionReport,
  type RegressionMeta,
} from "@jevitate/regression";
import { parseSuccessSpec } from "./explore-api.js";
import { assertAuthorizedExploreTarget, monitorFor, evaluateNetworkCheck, describeCheck, verifyFix, type SuccessCheck } from "@jevitate/explore";
import { parsePersistedMission, findFinding, type PersistedMission, type PersistedFinding } from "./verify-fix-api.js";

/**
 * The clear, actionable refusal #81 requires: a Recording with no failure to
 * reproduce is refused rather than "minimized" into a vacuous artifact that
 * can only ever pass.
 */
export class NoFailureToReproduceError extends Error {
  readonly code = "E_REGRESSION_NO_FAILURE" as const;
  constructor(message?: string) {
    super(
      message ??
        "this Recording contains no failure to reproduce; pass --result <result.json> --fingerprint <fp> or a Recording whose final step's expect fails",
    );
    this.name = "NoFailureToReproduceError";
  }
}

/** `--result` was given but carries no usable oracle at all: no failed `--success` check (of ANY
 * kind — page/reloadThen/requestMade/responseStatus), no matching declared-invariant defect, and no
 * APP-caused failed-action step (jevitate's own engine refusals — #92's repeated-side-effect guard,
 * a budget/fail-closed cutoff, … — are never a valid oracle; #119/#129). */
export class NoOracleInResultError extends Error {
  readonly code = "E_REGRESSION_NO_ORACLE" as const;
  constructor(resultPath: string, detail: string) {
    super(`--result ${resultPath} has no usable oracle: ${detail}`);
    this.name = "NoOracleInResultError";
  }
}

/** An explicit `--fingerprint` disagrees with the oracle derived from `--result`. */
export class FingerprintMismatchError extends Error {
  readonly code = "E_REGRESSION_FINGERPRINT_MISMATCH" as const;
  constructor(given: string, derived: string) {
    super(
      `--fingerprint '${given}' does not match the oracle derived from --result ('${derived}'), and is not a defect/invariant fingerprint in that result either`,
    );
    this.name = "FingerprintMismatchError";
  }
}

/** An invariant defect matched by `--fingerprint`, but `verify-fix`'s own replay says it does not
 * currently reproduce (fixed, or inconclusive) — never fabricated into a regression. */
export class InvariantNotReproducingError extends Error {
  readonly code = "E_REGRESSION_INVARIANT_NOT_REPRODUCING" as const;
  constructor(invariantId: string, verdict: string, reason: string) {
    super(`invariant '${invariantId}' does not currently reproduce (verify-fix verdict: ${verdict}): ${reason}`);
    this.name = "InvariantNotReproducingError";
  }
}

/** The mission result JSON `--result` reads — `jevitate explore`'s `<recording>.result.json` (shape `{ result: { transcript, checks } }`), or a flat `{ transcript, checks }` for hand-authored/test files. */
interface MissionResultFile {
  readonly result?: {
    readonly transcript?: readonly MissionTranscriptEntry[];
    readonly checks?: readonly { readonly check: string; readonly passed: boolean; readonly detail: string }[];
  };
  readonly transcript?: readonly MissionTranscriptEntry[];
  readonly checks?: readonly { readonly check: string; readonly passed: boolean; readonly detail: string }[];
}

/** A failure oracle derived from a mission result: either a Recording-replayable `Step`
 * (`DerivedOracle`, from `@jevitate/regression`), or a network check (`requestMade`/`responseStatus`)
 * that has no replayable `Assertion` and is instead re-evaluated against what a replay's OWN traffic
 * captures (#119/#129 — see `replayAndCheckNetwork` below). */
type ResolvedOracle = DerivedOracle | { readonly source: "network-check"; readonly check: NetworkCheckOracle };

/**
 * Derives a failure oracle from a mission result (#81 item 2, extended by #119/#129): the mission's
 * own last APP-CAUSED failed action (preferred — concrete, page-actionable, and replayable
 * regardless of what the mission's success check even was; jevitate's own engine refusals are
 * excluded by `deriveOracleFromTranscript` itself), or its first failed `--success` check, of ANY
 * kind: `page`/`reloadThen` become a Recording `Assertion`; `requestMade`/`responseStatus` become a
 * network-check oracle (no `Assertion` exists for network traffic, so it is never turned into a
 * Recording step). `undefined` when neither is available.
 */
function deriveOracle(missionResult: MissionResultFile): ResolvedOracle | undefined {
  const body = missionResult.result ?? missionResult;
  const fromTranscript = deriveOracleFromTranscript(body.transcript ?? []);
  if (fromTranscript) return fromTranscript;

  for (const check of body.checks ?? []) {
    if (check.passed) continue;
    let parsed;
    try {
      parsed = parseSuccessSpec(check.check);
    } catch {
      continue;
    }
    if (parsed.kind === "page" || parsed.kind === "reloadThen") return oracleFromAssertion(parsed.assertion);
    if (parsed.kind === "requestMade") {
      return { source: "network-check", check: { kind: "requestMade", method: parsed.method, pathGlob: parsed.pathGlob } };
    }
    if (parsed.kind === "responseStatus") {
      return { source: "network-check", check: { kind: "responseStatus", method: parsed.method, pathGlob: parsed.pathGlob, status: parsed.status } };
    }
  }
  return undefined;
}

/** Explains, accurately, why `deriveOracle` found nothing — named so #119's misleading refusal
 * ("has no failed success check" when one WAS present, just engine-refused/unusable) cannot recur. */
function describeNoOracle(missionResult: MissionResultFile): string {
  const body = missionResult.result ?? missionResult;
  const transcript = body.transcript ?? [];
  const checks = body.checks ?? [];
  const failedChecks = checks.filter((c) => !c.passed);
  const failedActions = transcript.filter((t) => !t.actOk && t.descriptor !== undefined);
  const onlyEngineRefusals = failedActions.length > 0 && failedActions.every((t) => t.origin === "engine" || /refused|fail-closed|budget exhausted/.test(t.reason ?? ""));
  const parts: string[] = [];
  parts.push(failedChecks.length === 0 ? "no --success check failed" : `${failedChecks.length} failed check(s) could not be parsed into an oracle`);
  parts.push(
    onlyEngineRefusals
      ? "the transcript's only failed step(s) were jevitate's own engine refusal(s) (never a valid oracle)"
      : "no app-caused failed-action step in the transcript",
  );
  return parts.join("; ");
}

export interface RunRegressionCaptureOptions {
  failingRecordingPath: string;
  id: string;
  regressionsDir: string;
  attempts?: number;
  bugSummary?: string;
  makeActor: () => Promise<Actor>;
  /**
   * Path to a mission result JSON (what `jevitate explore` writes alongside its Recording as
   * `<recording>.result.json`) — supplies a failure oracle (#81 item 2) when the Recording alone
   * carries no reproducible failure, because the failing action itself was never captured as a
   * step (see `@jevitate/explore`'s `RunRecorder`: only successful actions are recorded).
   */
  resultPath?: string;
  /**
   * An explicit failure fingerprint. Accepts EITHER a `stepSignature` (see `@jevitate/regression`'s
   * `fingerprintFailure`) alone pinning which structural step in `--from` counts as "the" failure,
   * OR — combined with `--result` (#119/#129) — the SAME defect/invariant fingerprint every other
   * command (`verify-fix`, the mission report) uses: when it matches one of the mission's OWN
   * declared-invariant defects, that invariant is re-checked (via `verify-fix`'s own machinery)
   * rather than turned into a Recording step. Combined with a page-checkable `--result` oracle, it
   * cross-checks the derived oracle.
   */
  fingerprint?: string;
}

export type RunRegressionCaptureResult =
  | { recordingPath: string; metaPath: string }
  | { skipped: "flaky"; rate: number };

export async function runRegressionCapture(opts: RunRegressionCaptureOptions): Promise<RunRegressionCaptureResult> {
  const raw = JSON.parse(await readFile(opts.failingRecordingPath, "utf8"));
  const recording = RecordingSchema.parse(raw);
  const attempts = opts.attempts ?? 3;

  let missionResult: MissionResultFile | undefined;
  let persistedMission: PersistedMission | undefined;
  if (opts.resultPath) {
    const rawResult: unknown = JSON.parse(await readFile(opts.resultPath, "utf8"));
    missionResult = rawResult as MissionResultFile;
    try {
      persistedMission = parsePersistedMission(rawResult);
    } catch {
      // Not every --result file matches verify-fix's typed mission shape (e.g. a hand-authored test
      // fixture with only `{ transcript, checks }`) — the transcript/checks view still works below.
      persistedMission = undefined;
    }
  }

  // An explicit --fingerprint matching one of the mission's OWN declared-invariant defects
  // (#119/#129): re-checked the same way `verify-fix` does (reusing its defect lookup,
  // `findFinding`), never turned into a Recording step — an invariant is not a page `Assertion`.
  if (opts.fingerprint !== undefined && persistedMission !== undefined) {
    const finding = findFinding(persistedMission, opts.fingerprint);
    if (finding !== undefined && finding.kind === "invariant" && finding.invariantId !== undefined && persistedMission.invariantSpec !== undefined) {
      return captureInvariantRegression(opts, recording, persistedMission, finding, attempts);
    }
  }

  let working: Recording = recording;
  let requiredFingerprint: FailureFingerprint | undefined;
  let networkOracle: NetworkCheckOracle | undefined;

  if (missionResult !== undefined) {
    const oracle = deriveOracle(missionResult);
    if (!oracle) throw new NoOracleInResultError(opts.resultPath as string, describeNoOracle(missionResult));

    if (oracle.source === "network-check") {
      networkOracle = oracle.check;
      const derivedSig = `network:${describeCheck(asSuccessCheck(oracle.check))}`;
      if (opts.fingerprint !== undefined && opts.fingerprint !== derivedSig) {
        throw new FingerprintMismatchError(opts.fingerprint, derivedSig);
      }
    } else {
      const { augmented, flatIndex } = appendOracleStep(working, oracle);
      working = augmented;
      requiredFingerprint = fingerprintFailure(working, flatIndex);

      if (opts.fingerprint !== undefined && opts.fingerprint !== requiredFingerprint.stepSignature) {
        throw new FingerprintMismatchError(opts.fingerprint, requiredFingerprint.stepSignature);
      }
    }
  } else if (opts.fingerprint !== undefined) {
    requiredFingerprint = { stepSignature: opts.fingerprint };
  }

  if (networkOracle !== undefined) {
    return captureNetworkCheckRegression(opts, working, networkOracle, attempts);
  }

  let report;
  try {
    report = requiredFingerprint
      ? await reproduceFailureAt(working, opts.makeActor, requiredFingerprint, attempts)
      : await reproduceFailure(working, opts.makeActor, attempts);
  } catch (cause) {
    if (cause instanceof NeverFailedError) throw new NoFailureToReproduceError();
    throw cause;
  }
  if (report.label === "flaky") return { skipped: "flaky", rate: report.rate };

  const reproduces = makeSingleShotReproduces(opts.makeActor, report.fingerprint);
  const minimized = await minimizeRecording(working, reproduces);

  return commitRegression(opts.regressionsDir, opts.id, minimized, report, opts.bugSummary);
}

/** `NetworkCheckOracle` (`@jevitate/regression`, duck-typed, no `Assertion`) as the concrete
 * `SuccessCheck` `@jevitate/explore`'s network-check evaluator expects. */
function asSuccessCheck(check: NetworkCheckOracle): Extract<SuccessCheck, { kind: "requestMade" | "responseStatus" }> {
  return check.status === undefined
    ? { kind: "requestMade", method: check.method, pathGlob: check.pathGlob }
    : { kind: "responseStatus", method: check.method, pathGlob: check.pathGlob, status: check.status };
}

/**
 * Replays `recording` once (a fresh session from `makeActor`), capturing every request the replay
 * itself sends (`@jevitate/explore`'s page monitor — the SAME capture a live mission's own
 * `requestMade`/`responseStatus` check reads), and re-evaluates `check` against exactly that
 * traffic. Returns whether the check STILL FAILS (the defect reproduced) — never whether the
 * Recording interpreter's own step outcomes succeeded, which is irrelevant to a network check.
 */
async function replayAndCheckNetwork(makeActor: () => Promise<Actor>, recording: Recording, check: NetworkCheckOracle): Promise<boolean> {
  const actor = await makeActor();
  const page = actor.ability(BrowseTheWebToken).session.page;
  const monitor = monitorFor(page);
  await monitor.instrument().catch(() => undefined);
  const capture = monitor.startCapture();
  try {
    await new RecordingInterpreter().run(actor, recording);
  } catch {
    // A replay that throws (browser/automation error) still leaves whatever the app sent captured;
    // the network check is evaluated over that, same as a replay that merely fails a later step.
  }
  // The interpreter's own postcondition can resolve before a write it triggered finishes (a click's
  // `expect` is often already true pre-click, e.g. "the button stayed visible") — wait for the
  // network to go idle before reading what was captured, or a fast write can be missed entirely.
  await monitor.waitSettled({ ceilingMs: 5_000 }).catch(() => undefined);
  monitor.stopCapture(capture);
  const result = evaluateNetworkCheck(asSuccessCheck(check), capture.requests(), capture.truncated);
  return !result.passed;
}

async function captureNetworkCheckRegression(
  opts: RunRegressionCaptureOptions,
  recording: Recording,
  check: NetworkCheckOracle,
  attempts: number,
): Promise<RunRegressionCaptureResult> {
  let reproducedCount = 0;
  for (let i = 0; i < attempts; i++) {
    if (await replayAndCheckNetwork(opts.makeActor, recording, check)) reproducedCount++;
  }
  if (reproducedCount === 0) throw new NoFailureToReproduceError();
  const rate = reproducedCount / attempts;
  if (rate !== 1) return { skipped: "flaky", rate };

  const report: ReproductionReport = {
    attempts,
    reproducedCount,
    rate,
    label: "reproducible",
    // Synthetic — a network check has no Recording step, so this is a description, never a
    // structural signature `matchesFingerprint` re-derives (`regression run` uses `meta.oracle`).
    fingerprint: { stepSignature: `network:${describeCheck(asSuccessCheck(check))}` },
    firstFailureAt: -1,
  };
  // No structural step to minimize against (#119/#129): commit the captured Recording as-is.
  return commitRegression(opts.regressionsDir, opts.id, recording, report, opts.bugSummary, { kind: "network", check });
}

async function captureInvariantRegression(
  opts: RunRegressionCaptureOptions,
  fallbackRecording: Recording,
  mission: PersistedMission,
  finding: PersistedFinding,
  attempts: number,
): Promise<RunRegressionCaptureResult> {
  const invariantSpec = mission.invariantSpec as NonNullable<PersistedMission["invariantSpec"]>;
  const invariantId = finding.invariantId as string;
  const recording = finding.recording ?? mission.recording ?? fallbackRecording;

  // Guardrail: the replay may only ever touch the mission's own authorized origins.
  assertAuthorizedExploreTarget(mission.target.seedUrl, mission.target.allowlist);

  const verifyResult = await verifyFix({
    recording,
    recordingStepIndex: finding.repro.recordingStepIndex,
    fingerprint: finding.fingerprint,
    defectKind: "invariant",
    invariant: { spec: invariantSpec, id: invariantId, allowlist: mission.target.allowlist, baseUrl: mission.target.seedUrl },
    replays: attempts,
    openSession: async () => {
      const actor = await opts.makeActor();
      const page = actor.ability(BrowseTheWebToken).session.page;
      // Session teardown is owned by the caller's `makeActor` (the CLI collects and closes every
      // opened session after the whole capture command finishes — same convention the step-based
      // path above already relies on via `@jevitate/regression`'s `makeActor` contract).
      return { page, actor, close: async () => undefined };
    },
  });

  if (verifyResult.verdict === "still-reproduces") {
    const ran = verifyResult.attempts?.filter((a) => a.ran).length ?? attempts;
    const report: ReproductionReport = {
      attempts: ran,
      reproducedCount: ran,
      rate: 1,
      label: "reproducible",
      fingerprint: { stepSignature: `invariant:${invariantId}` },
      firstFailureAt: finding.repro.recordingStepIndex,
    };
    return commitRegression(opts.regressionsDir, opts.id, recording, report, opts.bugSummary, {
      kind: "invariant",
      invariantId,
      invariantSpec,
      recordingStepIndex: finding.repro.recordingStepIndex,
      allowlist: mission.target.allowlist,
      baseUrl: mission.target.seedUrl,
      defectFingerprint: finding.fingerprint,
    });
  }
  if (verifyResult.verdict === "intermittent") {
    const ran = verifyResult.attempts?.filter((a) => a.ran).length ?? attempts;
    const fired = verifyResult.attempts?.filter((a) => a.ran && a.fired).length ?? 0;
    return { skipped: "flaky", rate: ran === 0 ? 0 : fired / ran };
  }
  throw new InvariantNotReproducingError(invariantId, verifyResult.verdict, verifyResult.reason);
}

/** No committed `<id>.recording.json`/`<id>.meta.json` in the regressions directory. */
export class RegressionNotFoundError extends Error {
  readonly code = "E_REGRESSION_NOT_FOUND" as const;
  constructor(id: string, dir: string) {
    super(`no regression '${id}' in ${dir}`);
    this.name = "RegressionNotFoundError";
  }
}

export interface RunRegressionRunOptions {
  readonly id: string;
  readonly regressionsDir: string;
  readonly makeActor: () => Promise<Actor>;
  /** Fresh-context replays for a declared-invariant oracle (mirrors `verify-fix --replays`). Default 3. */
  readonly attempts?: number;
}

export type RegressionRunVerdict = "reproduces" | "fixed" | "inconclusive" | "intermittent";

export interface RegressionRunReport {
  readonly id: string;
  readonly verdict: RegressionRunVerdict;
  readonly reason: string;
}

/**
 * `regression run <id>` (#129 item 4): replays a committed regression and reports whether it still
 * REPRODUCES or is now FIXED. Dispatches on `meta.oracle` — absent (the default/original) means the
 * committed Recording's own trailing `assert` step IS the oracle, replayed by `@jevitate/regression`'s
 * `replayRegression` (its `expect` failing/holding is the verdict, no different from any other
 * `RecordingInterpreter` run); a `network`/`invariant` oracle is re-evaluated the SAME way capture
 * established it (`replayAndCheckNetwork` / `verifyFix`'s invariant re-check) — never duplicated.
 */
export async function runRegressionRun(opts: RunRegressionRunOptions): Promise<RegressionRunReport> {
  const recordingPath = join(opts.regressionsDir, `${opts.id}.recording.json`);
  const metaPath = join(opts.regressionsDir, `${opts.id}.meta.json`);
  let recording: Recording;
  let meta: RegressionMeta;
  try {
    recording = RecordingSchema.parse(JSON.parse(await readFile(recordingPath, "utf8")));
    meta = JSON.parse(await readFile(metaPath, "utf8")) as RegressionMeta;
  } catch {
    throw new RegressionNotFoundError(opts.id, opts.regressionsDir);
  }

  const oracle = meta.oracle;
  if (oracle === undefined) {
    const actor = await opts.makeActor();
    const outcome = await replayRegression(actor, recording);
    return outcome === "failed"
      ? { id: opts.id, verdict: "reproduces", reason: "the committed Recording's own oracle step failed again on replay" }
      : { id: opts.id, verdict: "fixed", reason: "the committed Recording replayed clean; its oracle step held" };
  }

  if (oracle.kind === "network") {
    const spec = describeCheck(asSuccessCheck(oracle.check));
    const stillFails = await replayAndCheckNetwork(opts.makeActor, recording, oracle.check);
    return stillFails
      ? { id: opts.id, verdict: "reproduces", reason: `the network check (${spec}) still fails on replay` }
      : { id: opts.id, verdict: "fixed", reason: `the network check (${spec}) now passes on replay` };
  }

  // oracle.kind === "invariant"
  assertAuthorizedExploreTarget(oracle.baseUrl, oracle.allowlist);
  const verifyResult = await verifyFix({
    recording,
    recordingStepIndex: oracle.recordingStepIndex,
    fingerprint: oracle.defectFingerprint,
    defectKind: "invariant",
    invariant: { spec: oracle.invariantSpec, id: oracle.invariantId, allowlist: oracle.allowlist, baseUrl: oracle.baseUrl },
    replays: opts.attempts ?? 3,
    openSession: async () => {
      const actor = await opts.makeActor();
      const page = actor.ability(BrowseTheWebToken).session.page;
      return { page, actor, close: async () => undefined };
    },
  });
  const verdict: RegressionRunVerdict = verifyResult.verdict === "still-reproduces" ? "reproduces" : verifyResult.verdict;
  return { id: opts.id, verdict, reason: verifyResult.reason };
}
