import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Recording } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import type { ReproductionReport } from "./reproduce.js";

export class FlakyNotCommittableError extends Error {}

export interface RegressionMeta {
  id: string;
  capturedAtIso: string;
  fingerprint: { stepSignature: string };
  reproduction: { attempts: number; reproducedCount: number; rate: number };
  bugSummary?: string;
}

/**
 * Commits a minimized, reproducible Recording as a regression artifact:
 * `<dir>/<id>.recording.json` (schema-valid Recording) + `<dir>/<id>.meta.json`
 * (RegressionMeta). Refuses (fail-closed) to commit a `"flaky"`-labeled
 * report — flaky failures are labeled, never promoted.
 */
export async function commitRegression(
  dir: string,
  id: string,
  minimized: Recording,
  report: ReproductionReport,
  bugSummary?: string,
): Promise<{ recordingPath: string; metaPath: string }> {
  if (report.label === "flaky") {
    throw new FlakyNotCommittableError(
      `refusing to commit '${id}': reproduction rate ${report.rate} (${report.reproducedCount}/${report.attempts}) is flaky, not reproducible`,
    );
  }
  const validated = RecordingSchema.parse(minimized);

  await mkdir(dir, { recursive: true });
  const recordingPath = join(dir, `${id}.recording.json`);
  const metaPath = join(dir, `${id}.meta.json`);
  const meta: RegressionMeta = {
    id,
    capturedAtIso: new Date().toISOString(),
    fingerprint: report.fingerprint,
    reproduction: { attempts: report.attempts, reproducedCount: report.reproducedCount, rate: report.rate },
    bugSummary,
  };
  await writeFile(recordingPath, JSON.stringify(validated, null, 2) + "\n");
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { recordingPath, metaPath };
}
