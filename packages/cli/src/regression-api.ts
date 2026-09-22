import { readFile } from "node:fs/promises";
import type { Actor } from "@jevitate/screenplay";
import { RecordingSchema } from "@jevitate/recording";
import { reproduceFailure } from "@jevitate/regression";
import { minimizeRecording, makeSingleShotReproduces } from "@jevitate/regression";
import { commitRegression } from "@jevitate/regression";

export interface RunRegressionCaptureOptions {
  failingRecordingPath: string;
  id: string;
  regressionsDir: string;
  attempts?: number;
  bugSummary?: string;
  makeActor: () => Promise<Actor>;
}

export type RunRegressionCaptureResult =
  | { recordingPath: string; metaPath: string }
  | { skipped: "flaky"; rate: number };

export async function runRegressionCapture(opts: RunRegressionCaptureOptions): Promise<RunRegressionCaptureResult> {
  const raw = JSON.parse(await readFile(opts.failingRecordingPath, "utf8"));
  const recording = RecordingSchema.parse(raw);

  const report = await reproduceFailure(recording, opts.makeActor, opts.attempts ?? 3);
  if (report.label === "flaky") return { skipped: "flaky", rate: report.rate };

  const reproduces = makeSingleShotReproduces(opts.makeActor, report.fingerprint);
  const minimized = await minimizeRecording(recording, reproduces);

  return commitRegression(opts.regressionsDir, opts.id, minimized, report, opts.bugSummary);
}
