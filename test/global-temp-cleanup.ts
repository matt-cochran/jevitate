import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where Playwright keeps its browsers by default, which it finds from `HOME`: read before `HOME` moves. */
function browserCacheOf(home: string): string {
  if (process.platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  return join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "ms-playwright");
}

/**
 * Vitest global setup/teardown: give THIS run its own temp directory and its own home.
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
 *
 * `HOME` moves under it the same way, for workers and every CLI they spawn, so a test neither writes
 * to the real `~/.jevitate` (logs, proof progress, its key) nor reads the person's targets file. A
 * test that really needs the real home reads `JEVITATE_TEST_REAL_HOME`, and passes it on as `HOME` to
 * what it spawns. `findProjectDir` reads it too, so a checkout under the real home doesn't take the real
 * `~/.jevitate` for a project, in the workers and in every CLI they spawn. Pinned by
 * `packages/cli/src/test-home-isolated.test.ts`.
 *
 * The run dir is also the ceiling of every upward search for a project or a repo (see
 * `testRunCeiling` in `packages/cli/src/project-dir.ts`): a stray `/tmp/.jevitate` or `/tmp/.git` on the
 * machine must not turn a "no project here" fixture into one. Pinned by `project-dir-git-root.test.ts`.
 *
 * Vitest runs this once per workspace project, in one process: the second call keeps the first's home.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const base = process.env.TMPDIR ?? tmpdir();
  const runDir = mkdtempSync(join(base, "jvt-run-"));
  process.env.TMPDIR = runDir;
  process.env.JEVITATE_TEST_RUN_TMPDIR = runDir;
  // Nothing above the run dir is a fixture's repo or project. `findProjectDir`/`findGitRoot` stop at
  // JEVITATE_TEST_RUN_TMPDIR; this tells every `git` a test spawns the same, so a sandbox's `/tmp/.git`
  // (or a checkout, when TMPDIR is inside one) is never the repo of a fixture that has none.
  process.env.GIT_CEILING_DIRECTORIES = runDir;
  if (process.env.JEVITATE_TEST_REAL_HOME === undefined) {
    const realHome = homedir();
    process.env.JEVITATE_TEST_REAL_HOME = realHome;
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= browserCacheOf(realHome);
    const runHome = join(runDir, "home");
    mkdirSync(runHome);
    process.env.HOME = runHome;
    process.env.USERPROFILE = runHome;
  }
  return async () => {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  };
}
