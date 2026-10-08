import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findGitRoot, findProjectDir, homeDataRoot, type LayoutDeps } from "./project-dir.js";

/**
 * #213: which runs belong to THIS project — so a bare `jevitate report`/`diff` reads the current
 * project's runs, never every app's `~/.jevitate/logs` (a fresh project merged 167 unrelated runs),
 * and still finds the runs written to an `--out` dir.
 *
 * Mechanism: every persisted result is recorded, best-effort, as one line
 * `{"project": <key>, "path": <absolute result path>, "tags"?: {…}}` (#426: the run's `--tag`s) in the per-user index `~/.jevitate/run-index.jsonl`
 * (machine-local, like the logs themselves; never in a repo). The project key is the directory that
 * holds the project's `.jevitate/`, else the git root of the working directory, else the working
 * directory itself. A bare report reads: the project's own `.jevitate/logs` (only this project writes
 * there) plus every indexed result of this project that still exists — wherever it was written.
 *
 * `JEVITATE_RUN_INDEX=off` turns recording off (the test suite does, so it never touches the real index).
 */
export interface RunIndexDeps extends LayoutDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: the index file (default `~/.jevitate/run-index.jsonl`). */
  readonly indexPath?: string;
}

export function runIndexPath(deps: RunIndexDeps = {}): string {
  return deps.indexPath ?? join(homeDataRoot(deps), "run-index.jsonl");
}

/** The current project's key: the dir holding its `.jevitate/`, else the git root, else the cwd. */
export function projectKey(deps: LayoutDeps = {}): string {
  const project = findProjectDir(deps);
  if (project !== null) return dirname(project);
  const cwd = resolve((deps.cwd ?? (() => process.cwd()))());
  return findGitRoot(cwd) ?? cwd;
}

/** Records one persisted result for the current project. Never throws: an index is a convenience. */
export function recordRun(resultPath: string, deps: RunIndexDeps & { readonly tags?: Readonly<Record<string, string>> } = {}): void {
  if ((deps.env ?? process.env)["JEVITATE_RUN_INDEX"] === "off") return;
  try {
    const path = runIndexPath(deps);
    mkdirSync(dirname(path), { recursive: true });
    // #426: the run's tags ride on its index line, so an external tool attributes a run without opening it.
    const tags = deps.tags !== undefined && Object.keys(deps.tags).length > 0 ? { tags: deps.tags } : {};
    appendFileSync(path, `${JSON.stringify({ project: projectKey(deps), path: resolve(resultPath), ...tags })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort: a run's result is never replaced by an index failure
  }
}

/** Every indexed result of the current project that still exists, oldest first, each once. */
export function indexedRunsFor(deps: RunIndexDeps = {}): string[] {
  const path = runIndexPath(deps);
  if (!existsSync(path)) return [];
  const key = projectKey(deps);
  const out = new Set<string>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as { project?: unknown; path?: unknown };
      if (e.project === key && typeof e.path === "string" && existsSync(e.path)) out.add(e.path);
    } catch {
      continue; // a torn line names nothing
    }
  }
  return [...out];
}

/** The current project's own dated logs dirs (`<repo>/.jevitate/logs/<date>`) — none outside a project. */
export function projectLogDirs(deps: LayoutDeps = {}): string[] {
  const project = findProjectDir(deps);
  if (project === null) return [];
  const root = join(project, "logs");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse()
    .map((d) => join(root, d));
}
