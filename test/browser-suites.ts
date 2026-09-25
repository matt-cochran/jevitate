import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Which test files launch a REAL browser. They run in the vitest `browser`
 * project (limited file parallelism, browser-sized timeouts); everything else
 * runs in `unit` at full parallelism. Detected from file CONTENT so a new
 * browser suite is classified automatically — no list to keep in sync:
 *
 *  - uses the explore testkit's `withSession(` (a pooled real context), or
 *  - constructs a `PlaywrightBrowserPort(` without injecting a fake `launch`
 *    / `launchPersistentContext` (fake-launcher tests stay in `unit`), or
 *  - calls Playwright's `chromium.launch` directly.
 */
const REAL_BROWSER = /withSession\(|new PlaywrightBrowserPort\((?!\{[^}]*\blaunch)|chromium\.launch(?:PersistentContext)?\(/;

const ROOTS = ["packages", "apps"];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
}

/** Repo-relative, `/`-separated paths of every browser-launching test file. */
export function browserSuites(repoRoot: string): string[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(join(repoRoot, root), files);
  return files
    .filter((f) => REAL_BROWSER.test(readFileSync(f, "utf8")))
    .map((f) => relative(repoRoot, f).split(sep).join("/"))
    .sort();
}
