import { readdirSync } from "node:fs";

/**
 * Vitest global setup/teardown: fail the run when a test left a new entry in the directory vitest was
 * started from (the repo root, per AGENTS.md). A test writes under its own temp dir; a command's
 * default output (`jevitate check`'s `jevitate-check/`, a campaign's or explore's default dir) resolved
 * against the cwd lands in the checkout instead, and is then also outside what the test inspects.
 *
 * Only top-level names are compared, so this costs one `readdir` at each end. A file another process
 * creates in the root during the run (another agent in the same checkout) reads as a leak too: rerun,
 * or remove it first.
 */
export default function setup(): () => void {
  const root = process.cwd();
  const before = new Set(entries(root));
  return () => {
    const leaked = entries(root).filter((n) => !before.has(n));
    if (leaked.length > 0) {
      throw new Error(
        `test run left ${leaked.length} new entr${leaked.length === 1 ? "y" : "ies"} in ${root}: ${leaked.join(", ")} — ` +
          "a test wrote to the cwd (a command's default output dir?); give it an explicit path under its temp dir",
      );
    }
  };
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
