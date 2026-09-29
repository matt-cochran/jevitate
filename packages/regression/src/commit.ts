import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { InvariantSpec, Recording } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import type { ReproductionReport } from "./reproduce.js";
import type { NetworkCheckOracle } from "./oracle.js";

export class FlakyNotCommittableError extends Error {}

/**
 * How `regression run <id>` replays this regression, when it is not the default (#119/#129): the
 * committed Recording's OWN final `assert` step — absent `oracle`, the original/default — is
 * replayed by `@jevitate/regression`'s `replayRegression` (its `expect` failing/holding IS the
 * verdict). A `network`/`invariant` oracle has no such step; `regression run` re-evaluates it the
 * SAME way capture did (see `@jevitate/cli`'s `regression-api.ts`, which owns both).
 */
export type RegressionOracle =
  | { readonly kind: "network"; readonly check: NetworkCheckOracle }
  | {
      readonly kind: "invariant";
      readonly invariantId: string;
      readonly invariantSpec: InvariantSpec;
      /** Flat index (page-then-step) of the recorded step the invariant was evaluated after. */
      readonly recordingStepIndex: number;
      readonly allowlist: readonly string[];
      readonly baseUrl: string;
      /** The declared invariant's own defect fingerprint (never a Recording step signature). */
      readonly defectFingerprint: string;
    };

export interface RegressionMeta {
  id: string;
  capturedAtIso: string;
  fingerprint: { stepSignature: string };
  reproduction: { attempts: number; reproducedCount: number; rate: number };
  bugSummary?: string;
  /** Present only for a non-step oracle (#119/#129); absent means "the Recording's own final `assert` step". */
  oracle?: RegressionOracle;
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
  oracle?: RegressionOracle,
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
    ...(oracle === undefined ? {} : { oracle }),
  };
  await writeFile(recordingPath, JSON.stringify(validated, null, 2) + "\n");
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { recordingPath, metaPath };
}
