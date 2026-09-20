import type { Actor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { fingerprintFailure, matchesFingerprint, type FailureFingerprint } from "./fingerprint.js";

export class NeverFailedError extends Error {}

export interface ReproductionReport {
  attempts: number;
  reproducedCount: number;
  rate: number;
  label: "reproducible" | "flaky";
  fingerprint: FailureFingerprint;
  firstFailureAt: number;
}

/**
 * Replays `recording` `attempts` times (a fresh `Actor` per attempt, via
 * `makeActor` — a Playwright-backed session cannot be reused after a run)
 * and counts how many attempts fail at the SAME structural step (per
 * `matchesFingerprint`). `label: "reproducible"` requires EVERY attempt to
 * reproduce identically (rate === 1); anything less is `"flaky"` and must
 * never be promoted to a committed regression.
 */
export async function reproduceFailure(
  recording: Recording,
  makeActor: () => Promise<Actor>,
  attempts = 3,
): Promise<ReproductionReport> {
  if (attempts < 1) throw new Error("reproduceFailure: attempts must be >= 1");

  const interpreter = new RecordingInterpreter();
  let firstFailureAt = -1;
  let reproducedCount = 0;
  let fingerprint: FailureFingerprint | undefined;

  for (let i = 0; i < attempts; i++) {
    const actor = await makeActor();
    const result = await interpreter.run(actor, recording);
    if (result.outcome !== "failed") continue;

    if (!fingerprint) {
      firstFailureAt = result.at;
      fingerprint = fingerprintFailure(recording, result.at);
      reproducedCount = 1;
      continue;
    }
    if (matchesFingerprint(recording, result.at, fingerprint)) reproducedCount++;
  }

  if (!fingerprint) {
    throw new NeverFailedError(
      "reproduceFailure: the recording did not fail on any of the attempts — nothing to reproduce",
    );
  }

  const rate = reproducedCount / attempts;
  return { attempts, reproducedCount, rate, label: rate === 1 ? "reproducible" : "flaky", fingerprint, firstFailureAt };
}
