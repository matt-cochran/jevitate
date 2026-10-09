/**
 * #453 change-aware self-heal: read a git range read-only and build a `ChangeScope`.
 * The only IO is `git rev-parse` / `git merge-base` / `git diff`, always via an argv array, never a
 * shell, and only resolved 40-hex SHAs ever reach `diff`. Raw diff text leaves only as `ChangeEvidence`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractChangeEvidence, isSkippedChangePath, type ChangeScope } from "@jevitate/runtime";

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_BYTES = 4_000_000;
const MAX_NOTES = 20;
const MAX_NOTE_LENGTH = 2000;
const SHA_RE = /^[0-9a-f]{40}$/;
// The whole range must be ref-safe characters; the separator, if any, is exactly `..` or `...`.
const RANGE_RE = /^([A-Za-z0-9._\/~^@{}-]{1,200})(?:(\.\.\.?)([A-Za-z0-9._\/~^@{}-]{1,200}))?$/;

/** The caller supplied a syntactically invalid range or note set. */
export class ChangesArgsError extends Error {
  readonly code = "E_CHANGES_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChangesArgsError";
  }
}

/** Git could not resolve the range, or the diff is too large to surface. */
export class ChangesInputError extends Error {
  readonly code = "E_CHANGES_INPUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChangesInputError";
  }
}

/** Runs one read-only git command. Injected in tests; never uses a shell. */
export type GitExec = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

/** The production git runner: argv only, no shell, optional locks and prompts disabled. */
export const execGitReadOnly: GitExec = async (args, opts) => {
  const result = await execFileAsync("git", args, {
    cwd: opts.cwd,
    env: { ...opts.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { stdout: result.stdout };
};

/** Parse `a..b`, `a...b` (symmetric) or a single `X` (meaning `X..HEAD`) into its resolved ends. */
export function parseChangeRange(s: string): { from: string; to: string; symmetric: boolean } {
  if (typeof s !== "string" || !RANGE_RE.test(s)) throw new ChangesArgsError(`invalid change range: ${JSON.stringify(s)}`);

  const triple = s.indexOf("...");
  const double = triple >= 0 ? -1 : s.indexOf("..");
  let from: string;
  let to: string;
  let symmetric: boolean;
  if (triple >= 0) {
    from = s.slice(0, triple);
    to = s.slice(triple + 3);
    symmetric = true;
  } else if (double >= 0) {
    from = s.slice(0, double);
    to = s.slice(double + 2);
    symmetric = false;
  } else {
    from = s;
    to = "HEAD";
    symmetric = false;
  }

  for (const side of [from, to]) {
    if (side === "" || side.startsWith("-") || side.includes("..") || side.includes("@{-")) {
      throw new ChangesArgsError(`unsafe change range: ${JSON.stringify(s)}`);
    }
  }
  return { from, to, symmetric };
}

/** Validate human change notes: at most 20, each 1-2000 chars, no NUL. Returns a copy. */
export function validateChangeNotes(notes: readonly string[]): string[] {
  if (notes.length > MAX_NOTES) throw new ChangesArgsError(`at most ${MAX_NOTES} change notes are allowed`);
  for (const note of notes) {
    if (note.length < 1 || note.length > MAX_NOTE_LENGTH || note.includes("\u0000")) {
      throw new ChangesArgsError(`each change note must be 1-${MAX_NOTE_LENGTH} characters and contain no NUL`);
    }
  }
  return [...notes];
}

/** Read a git range (and/or notes) and build the `ChangeScope` the healer consumes. */
export async function readChangeScope(o: {
  cwd: string;
  range?: string;
  notes: readonly string[];
  exec?: GitExec;
  limits?: { maxFiles?: number; maxBytes?: number };
}): Promise<ChangeScope> {
  const exec = o.exec ?? execGitReadOnly;
  const notes = validateChangeNotes(o.notes);
  const maxFiles = o.limits?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = o.limits?.maxBytes ?? DEFAULT_MAX_BYTES;

  if (o.range === undefined) {
    return { evidence: extractChangeEvidence("", notes), scanned: { files: 0, hunks: 0, skipped: [] } };
  }

  const { from, to, symmetric } = parseChangeRange(o.range);
  const fromSha = await resolveCommit(exec, o.cwd, from);
  const toSha = await resolveCommit(exec, o.cwd, to);
  const baseSha = symmetric ? await mergeBase(exec, o.cwd, fromSha, toSha) : fromSha;
  const headSha = toSha;
  assertSha(baseSha);
  assertSha(headSha);

  const diffArgs = [
    "-c",
    "core.fsmonitor=",
    "-c",
    "diff.external=",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "-M",
    "--unified=0",
    `${baseSha}..${headSha}`,
    "--",
  ];

  let stdout: string;
  try {
    ({ stdout } = await exec(diffArgs, { cwd: o.cwd, env: process.env }));
  } catch (error) {
    throw new ChangesInputError(`git diff failed: ${messageOf(error)}`);
  }

  if (Buffer.byteLength(stdout, "utf8") > maxBytes) {
    throw new ChangesInputError(`change diff exceeds ${maxBytes} bytes`);
  }
  const files = countDiffSections(stdout);
  if (files > maxFiles) {
    throw new ChangesInputError(`change diff touches ${files} files (max ${maxFiles})`);
  }

  return {
    range: o.range,
    baseSha,
    headSha,
    evidence: extractChangeEvidence(stdout, notes),
    scanned: { files, hunks: countHunks(stdout), skipped: skippedPaths(stdout) },
  };
}

async function resolveCommit(exec: GitExec, cwd: string, rev: string): Promise<string> {
  const args = ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`];
  let stdout: string;
  try {
    ({ stdout } = await exec(args, { cwd, env: process.env }));
  } catch (error) {
    throw new ChangesInputError(`cannot resolve change revision ${JSON.stringify(rev)}: ${messageOf(error)}`);
  }
  const sha = stdout.trim();
  if (!SHA_RE.test(sha)) throw new ChangesInputError(`cannot resolve change revision ${JSON.stringify(rev)}`);
  return sha;
}

async function mergeBase(exec: GitExec, cwd: string, shaA: string, shaB: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await exec(["merge-base", shaA, shaB], { cwd, env: process.env }));
  } catch (error) {
    throw new ChangesInputError(`cannot find merge base: ${messageOf(error)}`);
  }
  const sha = stdout.trim();
  if (!SHA_RE.test(sha)) throw new ChangesInputError(`cannot find merge base for ${shaA}...${shaB}`);
  return sha;
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new ChangesInputError(`resolved revision is not a commit SHA: ${JSON.stringify(sha)}`);
}

function countDiffSections(diff: string): number {
  let count = 0;
  for (const line of diff.split(/\r?\n/)) if (line.startsWith("diff --git ")) count++;
  return count;
}

function countHunks(diff: string): number {
  let count = 0;
  for (const line of diff.split(/\r?\n/)) if (line.startsWith("@@ ")) count++;
  return count;
}

function skippedPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (!header) continue;
    const newPath = unquotePath(header[2]);
    if (isSkippedChangePath(newPath)) paths.push(newPath);
  }
  return paths;
}

function unquotePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
