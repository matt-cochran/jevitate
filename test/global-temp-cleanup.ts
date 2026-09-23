import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global teardown: sweep throwaway temp dirs the suite leaks.
 *
 * Fixtures across this repo create disposable dirs via `mkdtemp(join(tmpdir(),
 * "<prefix>"))` — CLI homes, journey stores, profile dirs, and Playwright
 * user-data dirs — and not every test removes its own. A full run can leak
 * hundreds of MB into `os.tmpdir()`. This teardown removes ONLY our own
 * prefixes, and ONLY dirs that appeared DURING this run (snapshotted at setup),
 * so a concurrent run's dirs are never touched. It is a safety net; production
 * CLI sessions are pooled browser contexts with no on-disk profile at all.
 */
const PREFIXES = ["jevitate-"] as const;

async function snapshotMatching(): Promise<Set<string>> {
  const out = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(tmpdir());
  } catch {
    return out;
  }
  for (const name of entries) {
    if (PREFIXES.some((p) => name.startsWith(p))) out.add(name);
  }
  return out;
}

export default async function setup(): Promise<() => Promise<void>> {
  const before = await snapshotMatching();
  return async () => {
    const after = await snapshotMatching();
    for (const name of after) {
      if (before.has(name)) continue; // pre-existing / another run — never touch
      await rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => {});
    }
  };
}
