import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 0.30.0 (#800, owner decision 3): a Journey run that passes with no done check reads
 * `job: {unverified, no-check}` and exits 2 under the default `doneCheckPolicy: "require"`.
 * A test about something else (selectors, waits, secrets, guards ...) that only wants a passing run
 * to exit 0 gives its project this catalog dir: a `project.json` with `doneCheckPolicy: "advisory"`.
 * Pass it as `catalogDir` to `buildProgram` / `buildMcpTools` / `realQueuedJourneyExecutor`.
 */
export function advisoryCatalogDir(parent: string): string {
  const dir = join(parent, ".jevitate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ doneCheckPolicy: "advisory" }));
  return dir;
}
