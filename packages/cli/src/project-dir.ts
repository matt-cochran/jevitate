import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Where jevitate keeps things (0.2.0 layout):
 *
 *  - the app repo's own `.jevitate/` — found by walking up from the working directory, created by
 *    `jevitate init` — holds what belongs with the app's code: `journeys/` (named Journeys, shared
 *    ones as git submodules under `journeys/<shared>/`), `regressions/`, `baselines/`, and `logs/`
 *    (run output, dated, .gitignored, pruned by retention);
 *  - the per-user `~/.jevitate/` keeps everything secret or machine-local (credentials, config,
 *    targets.json, profiles, storage states, the inbox, the mission queue, trust, source clones,
 *    the policy database) and never goes in a repo. Outside a repo, `journeys/` and `logs/` live
 *    there too.
 */
export interface LayoutDeps {
  readonly cwd?: () => string;
  readonly homedir?: () => string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The per-user data dir, `~/.jevitate`. */
export function homeDataRoot(deps: LayoutDeps = {}): string {
  return join((deps.homedir ?? osHomedir)(), ".jevitate");
}

/** The nearest `.jevitate/` walking up from the working directory — never the per-user one. */
export function findProjectDir(deps: LayoutDeps = {}): string | null {
  const home = homeDataRoot(deps);
  let dir = resolve((deps.cwd ?? (() => process.cwd()))());
  for (;;) {
    const candidate = join(dir, ".jevitate");
    if (candidate !== home && isDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `<repo>/.jevitate/<segments>` inside a project, else `~/.jevitate/<segments>`. */
export function projectDataDir(segments: readonly string[], deps: LayoutDeps = {}): string {
  return join(findProjectDir(deps) ?? homeDataRoot(deps), ...segments);
}

/** The UTC date (`YYYY-MM-DD`) of an ISO time or an artifact stamp (`explore-2026-09-25T01-26-29-787Z`). */
export function logDateOf(isoOrStamp: string): string | null {
  return /(\d{4}-\d{2}-\d{2})T/.exec(isoOrStamp)?.[1] ?? null;
}

/** The logs root: `<project or home>/.jevitate/logs`. */
export function logsRoot(deps: LayoutDeps = {}): string {
  return projectDataDir(["logs"], deps);
}

/** Where a run started at `iso` writes its output: `logs/<UTC date>`. */
export function logsDirFor(iso: string = new Date().toISOString(), deps: LayoutDeps = {}): string {
  return join(logsRoot(deps), logDateOf(iso) ?? new Date().toISOString().slice(0, 10));
}

/** The 0.1.0 locations results were written to — still read, never written. */
export function legacyResultDirs(deps: LayoutDeps = {}): string[] {
  return [join(homeDataRoot(deps), "recordings"), join(homeDataRoot(deps), "ux-reports")];
}

function dayShift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The directories a result id's files may be in, most likely first: its dated logs dir (and the
 * day either side, for a run that crossed midnight) in the project, then under `~/.jevitate`, then
 * the 0.1.0 locations.
 */
export function resultDirsFor(resultId: string, deps: LayoutDeps = {}): string[] {
  const date = logDateOf(resultId);
  const roots = [...new Set([logsRoot(deps), join(homeDataRoot(deps), "logs")])];
  const dated = date === null ? [] : roots.flatMap((r) => [date, dayShift(date, -1), dayShift(date, 1)].map((d) => join(r, d)));
  return [...dated, ...legacyResultDirs(deps)];
}

/** Every directory results may be in (for `report`/`diff`): each dated logs dir, project and home, then the 0.1.0 ones. */
export function allResultDirs(deps: LayoutDeps = {}): string[] {
  const roots = [...new Set([logsRoot(deps), join(homeDataRoot(deps), "logs")])];
  const dated = roots.flatMap((r) =>
    existsSync(r)
      ? readdirSync(r)
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
          .sort()
          .reverse()
          .map((d) => join(r, d))
      : [],
  );
  return [...dated, ...legacyResultDirs(deps)];
}

/** The nearest directory holding `.git` (a directory, or a worktree's file), walking up from `cwd`. */
export function findGitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ProjectInitReport {
  /** The project data dir, or null when not in a git repository (then `~/.jevitate` is used). */
  readonly dir: string | null;
  readonly created: string[];
  readonly reason?: string;
}

const PROJECT_SUBDIRS = ["journeys", "regressions", "baselines", "logs"] as const;

const GITIGNORE_HEADER = "# jevitate: local run output and anything secret or machine-local never goes in the repo";

/**
 * What the repo's `.jevitate/.gitignore` keeps out of git: run output (`logs/`, pruned by
 * retention), and every secret or machine-local file jevitate keeps in `~/.jevitate`, in case one
 * is ever copied or written here — credentials, config, targets, the policy database, browser
 * profiles and sessions (storage states hold live cookies), the inbox, the mission queue, trust
 * decisions, source clones, env files, HAR captures and traces. Journeys, regressions and
 * baselines are committed.
 */
export const PROJECT_GITIGNORE: readonly string[] = [
  "logs/",
  "/credentials.json",
  "/config.json",
  "/targets.json",
  "/db.sqlite*",
  "/profiles/",
  "/inbox/",
  "/missions/",
  "/trust/",
  "/sources/",
  "/skills-install-state.json",
  "*.storage-state.json",
  "*storageState*.json",
  ".env",
  ".env.*",
  "*.har",
  "trace-*.zip",
];

/** A .gitignore line as git reads it for matching purposes: trimmed, a trailing comment-free pattern. */
function normalizeIgnoreLine(line: string): string {
  const t = line.trim();
  return t.startsWith("#") ? "" : t;
}

/**
 * Creates the repo's `.jevitate/` (`jevitate init`): `journeys/`, `regressions/`, `baselines/`,
 * `logs/`, and a `.gitignore` (`PROJECT_GITIGNORE`) that keeps run output and anything secret or
 * machine-local out of the repo. Idempotent and never overwriting: an existing `.gitignore` keeps
 * every line it has and gains only the entries it lacks, each once; a second run changes nothing.
 */
export function initProjectDir(cwd: string, opts: { readonly dryRun?: boolean } = {}): ProjectInitReport {
  const root = findGitRoot(cwd);
  if (root === null) return { dir: null, created: [], reason: "not in a git repository: Journeys and logs live under ~/.jevitate" };
  const dir = join(root, ".jevitate");
  const created: string[] = [];
  for (const sub of PROJECT_SUBDIRS) {
    const p = join(dir, sub);
    if (!existsSync(p)) {
      created.push(p);
      if (opts.dryRun !== true) mkdirSync(p, { recursive: true });
    }
  }
  const ignore = join(dir, ".gitignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : null;
  const present = new Set((current ?? "").split(/\r?\n/).map(normalizeIgnoreLine).filter((l) => l !== ""));
  const missing = PROJECT_GITIGNORE.filter((line) => !present.has(normalizeIgnoreLine(line)));
  if (missing.length > 0) {
    created.push(`${ignore} (${missing.join(" ")})`);
    if (opts.dryRun !== true) {
      const header = current !== null && current.includes(GITIGNORE_HEADER) ? "" : `${GITIGNORE_HEADER}\n`;
      const base = current === null || current === "" ? "" : current.replace(/\n?$/, "\n");
      writeFileSync(ignore, `${base}${header}${missing.join("\n")}\n`);
    }
  }
  return { dir, created };
}
