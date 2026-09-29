import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup/teardown: give THIS run its own temp directory.
 *
 * Fixtures across this repo create disposable dirs via `mkdtemp(join(tmpdir(), "<prefix>"))` —
 * CLI homes, journey stores, profile dirs, Playwright user-data dirs — and not every test removes
 * its own. The run's workers inherit `TMPDIR` pointing at a run-private directory, so:
 *  - everything a test creates in `os.tmpdir()` lives under it and is removed in one sweep at the
 *    end of the run;
 *  - a CONCURRENT run (another checkout, another agent) can never delete this run's fixtures, and
 *    this run can never delete theirs — the old shared-`/tmp` sweep removed any `jevitate-*` dir
 *    that appeared during a run, including a concurrent run's live fixtures (a load-dependent
 *    flake).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const base = process.env.TMPDIR ?? tmpdir();
  const runDir = mkdtempSync(join(base, "jvt-run-"));
  process.env.TMPDIR = runDir;
  process.env.JEVITATE_TEST_RUN_TMPDIR = runDir;
  return async () => {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  };
}
