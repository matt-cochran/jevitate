import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { findGitRoot } from "./project-dir.js";
import { SkillsBlockMarkerError, mergeMarkedBlock, type BlockMarkers } from "./init-skills.js";

/**
 * #437 — `jevitate init --codeowners <owners>`: a marked CODEOWNERS block that makes the approval
 * records (`.jevitate/journeys/`, `.jevitate/personas.json`, `.jevitate/jobs.json`) need a code
 * owner's review. With branch protection requiring code-owner review on the forge, no approval
 * change — a promoted Journey, an approved persona or job, a waiver — merges without a person.
 * That is the enforcement layer; provenance and the TTY confirmation only detect and add friction.
 *
 * The block follows #431's marker rules (init-skills.ts `mergeMarkedBlock`): replaced in place on a
 * re-run (idempotent), appended otherwise, refused when its markers are malformed.
 */

export const CODEOWNERS_BLOCK_BEGIN = "# BEGIN JEVITATE CODEOWNERS v1";
export const CODEOWNERS_BLOCK_END = "# END JEVITATE CODEOWNERS v1";
const MARKERS: BlockMarkers = { begin: /# BEGIN JEVITATE CODEOWNERS v\d+[^\n]*/, end: /# END JEVITATE CODEOWNERS v\d+/, label: "JEVITATE CODEOWNERS" };

/** Where GitHub and GitLab look for CODEOWNERS, in GitHub's order; a new file goes in the first. */
export const CODEOWNERS_LOCATIONS: readonly string[] = [join(".github", "CODEOWNERS"), "CODEOWNERS", join("docs", "CODEOWNERS"), join(".gitlab", "CODEOWNERS")];

/** A bad `--codeowners` value, or no git repository to write it in. Exit 64. */
export class CodeownersArgsError extends Error {
  readonly code = "E_INIT_CODEOWNERS_ARGS";
}

/** `@user`, `@org/team`, or an email — what a CODEOWNERS line takes. */
const OWNER_RE = /^(@[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)?|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

/** `--codeowners "@org/team @alice"` (spaces or commas) → the owners; refused when empty or malformed. */
export function parseOwners(value: string): string[] {
  const owners = value
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter((o) => o !== "");
  if (owners.length === 0) throw new CodeownersArgsError('--codeowners needs at least one owner: "@user", "@org/team" or an email');
  for (const o of owners) {
    if (!OWNER_RE.test(o)) throw new CodeownersArgsError(`--codeowners: '${o}' is not a code owner ("@user", "@org/team" or an email)`);
  }
  return [...new Set(owners)];
}

/** The block's lines for a `.jevitate/` at `dataDir` (repo-relative, `/`-separated, anchored at the root). */
export function renderCodeownersBlock(owners: readonly string[], dataDir: string): string {
  const base = dataDir === "" ? "/.jevitate" : `/${dataDir}/.jevitate`;
  const who = owners.join(" ");
  return [
    CODEOWNERS_BLOCK_BEGIN,
    "# jevitate approvals (#437): promoted Journeys, catalog personas and jobs, and their approval",
    "# records need a code owner's review. Enable branch protection with \"Require review from Code",
    "# Owners\" on the forge, or this block is advisory. Later rules in this file override these.",
    `${base}/journeys/ ${who}`,
    `${base}/personas.json ${who}`,
    `${base}/jobs.json ${who}`,
    CODEOWNERS_BLOCK_END,
  ].join("\n");
}

export interface CodeownersReport {
  /** The CODEOWNERS file written (or that would be, with --dry-run). */
  readonly path: string;
  readonly action: "create" | "update" | "unchanged";
  readonly owners: readonly string[];
  /** Always set: CODEOWNERS only enforces with branch protection on the forge. */
  readonly note: string;
}

export const BRANCH_PROTECTION_NOTE =
  'CODEOWNERS enforces nothing alone: enable branch protection on the default branch with "Require a pull request" and "Require review from Code Owners" (GitHub; GitLab: "Code owner approval" on protected branches), and run `jevitate check --require-approvals` in CI';

/**
 * Writes or merges the block into the repository's CODEOWNERS (an existing one in `.github/`, the
 * root, `docs/` or `.gitlab/`; else `.github/CODEOWNERS`). `cwd` must be inside a git repository;
 * the `.jevitate/` it covers is the one `jevitate init` creates in `cwd`.
 */
export async function installCodeowners(cwd: string, ownersValue: string, opts: { readonly dryRun?: boolean } = {}): Promise<CodeownersReport> {
  const owners = parseOwners(ownersValue);
  const root = findGitRoot(cwd);
  if (root === null) throw new CodeownersArgsError("--codeowners needs a git repository: run `jevitate init --codeowners` inside the repository whose .jevitate/ it covers");
  const rel = relative(root, cwd).split(sep).filter((p) => p !== "").join("/");
  if (rel.startsWith("..")) throw new CodeownersArgsError(`--codeowners: ${cwd} is not inside ${root}`);
  const existing = CODEOWNERS_LOCATIONS.map((l) => join(root, l)).find((p) => existsSync(p));
  const path = existing ?? join(root, CODEOWNERS_LOCATIONS[0] as string);
  const before = existing === undefined ? "" : await readFile(existing, "utf8");
  let after: string;
  try {
    after = mergeMarkedBlock(before, renderCodeownersBlock(owners, rel), MARKERS);
  } catch (err) {
    if (err instanceof SkillsBlockMarkerError) throw new CodeownersArgsError(`${path}: ${err.reason}`);
    throw err;
  }
  if (!after.endsWith("\n")) after += "\n";
  const action = existing === undefined ? "create" : after === before ? "unchanged" : "update";
  if (opts.dryRun !== true && action !== "unchanged") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, after, "utf8");
  }
  return { path, action, owners, note: BRANCH_PROTECTION_NOTE };
}

// ── Reading CODEOWNERS (#469: is a pull-request reviewer a code owner of a path?) ──────────────

/** Where GitHub looks for CODEOWNERS, in its order (the first file found is the one it uses). */
export const GITHUB_CODEOWNERS_LOCATIONS: readonly string[] = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** One CODEOWNERS rule: the pattern as written, its matcher, and its owners (`@user`, `@org/team`, emails). */
export interface CodeownersRule {
  readonly pattern: string;
  readonly matches: (path: string) => boolean;
  readonly owners: readonly string[];
}

function globToRegexBody(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a bare `**` anything.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * A gitignore-style CODEOWNERS pattern as GitHub reads it: a leading `/` or a `/` inside anchors it
 * to the repository root (else it matches at any depth); a trailing `/` matches a directory's
 * contents; a pattern naming a directory also matches everything under it; `*` stays within one
 * path segment, `**` crosses them.
 */
export function codeownersMatcher(pattern: string): (path: string) => boolean {
  const dirOnly = pattern.endsWith("/");
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  const anchored = pattern.startsWith("/") || trimmed.includes("/");
  const body = globToRegexBody(trimmed);
  const re = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${dirOnly ? "/.*" : "(?:/.*)?"}$`);
  return (path) => re.test(path.replace(/^\/+/, ""));
}

/** The rules of a CODEOWNERS file, in file order. Comments, blank lines and section headers are skipped. */
export function parseCodeownersFile(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "" || line.startsWith("[") || line.startsWith("^[")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern === undefined) continue;
    rules.push({ pattern, matches: codeownersMatcher(pattern), owners });
  }
  return rules;
}

/** The owners of a repository-relative path: the LAST matching rule wins (none: no owners). */
export function codeownersOf(rules: readonly CodeownersRule[], path: string): readonly string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i] as CodeownersRule;
    if (r.matches(path)) return r.owners;
  }
  return [];
}
