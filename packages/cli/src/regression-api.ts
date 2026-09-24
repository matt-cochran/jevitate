import { readFile } from "node:fs/promises";
import type { Actor } from "@jevitate/screenplay";
import { RecordingSchema, type Recording } from "@jevitate/recording";
import {
  reproduceFailure,
  reproduceFailureAt,
  NeverFailedError,
  minimizeRecording,
  makeSingleShotReproduces,
  commitRegression,
  deriveOracleFromTranscript,
  oracleFromAssertion,
  appendOracleStep,
  fingerprintFailure,
  type FailureFingerprint,
  type MissionTranscriptEntry,
} from "@jevitate/regression";
import { parseSuccessSpec } from "./explore-api.js";

/**
 * The clear, actionable refusal #81 requires: a Recording with no failure to
 * reproduce is refused rather than "minimized" into a vacuous artifact that
 * can only ever pass.
 */
export class NoFailureToReproduceError extends Error {
  readonly code = "E_REGRESSION_NO_FAILURE" as const;
  constructor() {
    super(
      "this Recording contains no failure to reproduce; pass --result <result.json> --fingerprint <fp> or a Recording whose final step's expect fails",
    );
    this.name = "NoFailureToReproduceError";
  }
}

/** `--result` was given but carries neither a failed action nor a page-checkable failed `--success` check. */
export class NoOracleInResultError extends Error {
  readonly code = "E_REGRESSION_NO_ORACLE" as const;
  constructor(resultPath: string) {
    super(`--result ${resultPath} has no failed success check and no failed-action step to use as an oracle`);
    this.name = "NoOracleInResultError";
  }
}

/** An explicit `--fingerprint` disagrees with the oracle derived from `--result`. */
export class FingerprintMismatchError extends Error {
  readonly code = "E_REGRESSION_FINGERPRINT_MISMATCH" as const;
  constructor(given: string, derived: string) {
    super(`--fingerprint '${given}' does not match the oracle derived from --result ('${derived}')`);
    this.name = "FingerprintMismatchError";
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

/**
 * Derives a failure oracle from a mission result (#81 item 2): the mission's own last failed
 * action (preferred — concrete, page-actionable, and replayable regardless of what the mission's
 * success check even was), or its first failed `--success` check whose kind is page-checkable
 * (`page`/`reloadThen` — a `requestMade`/`responseStatus` network check has no `Assertion` a
 * Recording replay can check and is skipped). `undefined` when neither is available.
 */
function deriveOracle(missionResult: MissionResultFile) {
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
    if (parsed.kind === "page" || parsed.kind === "reloadThen") {
      return oracleFromAssertion(parsed.assertion);
    }
  }
  return undefined;
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
   * An explicit failure fingerprint (a `stepSignature`, see `@jevitate/regression`'s
   * `fingerprintFailure`). Alone, it PINS which structural step in `--from` counts as "the"
   * failure, rather than accepting whichever step happens to fail first — the exact fix for a
   * recording whose replay fails at an unrelated, incidentally-flaky step. Combined with
   * `--result`, it cross-checks the derived oracle.
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

  let working: Recording = recording;
  let requiredFingerprint: FailureFingerprint | undefined;

  if (opts.resultPath) {
    const missionResult = JSON.parse(await readFile(opts.resultPath, "utf8")) as MissionResultFile;
    const oracle = deriveOracle(missionResult);
    if (!oracle) throw new NoOracleInResultError(opts.resultPath);

    const { augmented, flatIndex } = appendOracleStep(working, oracle);
    working = augmented;
    requiredFingerprint = fingerprintFailure(working, flatIndex);

    if (opts.fingerprint && opts.fingerprint !== requiredFingerprint.stepSignature) {
      throw new FingerprintMismatchError(opts.fingerprint, requiredFingerprint.stepSignature);
    }
  } else if (opts.fingerprint) {
    requiredFingerprint = { stepSignature: opts.fingerprint };
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
