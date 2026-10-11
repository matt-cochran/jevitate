import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * #498: an `upload` fixture must be a file INSIDE the project root (the folder holding `.jevitate/`).
 * A Journey (or a mission) names the path, so without this rule an absolute path, a `../` path or a
 * symlink could attach any file the user can read — `~/.ssh/id_ed25519`, `~/.jevitate/` secrets —
 * to an allowed origin. The check runs on REAL paths (after `realpath`), so a symlink that escapes
 * counts as outside and a symlinked root component cannot hide one. There is no override flag.
 *
 * Shared by the interpreter's `upload` step (every Journey run), explore's `upload` op (mission
 * fixtures) and `journey lint` (`upload-outside-project`). Lives here, not in @jevitate/journey,
 * because @jevitate/recording is the lowest package all three already depend on.
 */

export type FixturePathErrorCode = "fixture-not-found" | "fixture-outside-project" | "fixture-no-root" | "fixture-sensitive";

/** #498: why a fixture path was refused — `code` is stable; the message names the path (and the root). */
export class FixturePathError extends Error {
  constructor(
    readonly code: FixturePathErrorCode,
    readonly path: string,
    readonly root: string | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FixturePathError";
  }
}

/** The fixture is not an existing regular file (`fixture not found: <path>`, as #488 reported it). */
export function fixtureNotFound(path: string, root: string | null, cause?: unknown): FixturePathError {
  return new FixturePathError("fixture-not-found", path, root, `fixture not found: ${path}`, cause === undefined ? undefined : { cause });
}

/** The fixture resolves outside the project root. */
export function fixtureOutsideProject(path: string, root: string): FixturePathError {
  return new FixturePathError(
    "fixture-outside-project",
    path,
    root,
    `upload fixture ${path} is outside the project root ${root} — move the fixture into the project`,
  );
}

/** No project root is known, so nothing can be confined to it: refused (fail-closed). */
export function fixtureNoRoot(path: string): FixturePathError {
  return new FixturePathError(
    "fixture-no-root",
    path,
    null,
    `upload fixture ${path} refused: no project root to confine it to — run from a project (a folder holding .jevitate/) and move the fixture into the project`,
  );
}

/** The root confines nothing (`/`, the home directory, `~/.jevitate`): refused like no root. */
export function fixtureUnsafeRoot(path: string, root: string, why: string): FixturePathError {
  return new FixturePathError(
    "fixture-no-root",
    path,
    root,
    `upload fixture ${path} refused: ${root} is not a project root (${why}) — run from a project (a folder holding .jevitate/) and move the fixture into the project`,
  );
}

/** The fixture is inside the root but looks like a secret or run evidence. */
export function fixtureSensitive(path: string, root: string, reason: string): FixturePathError {
  return new FixturePathError("fixture-sensitive", path, root, `upload fixture ${path} looks sensitive (${reason}) — use a dedicated test fixture file`);
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * 0.12.0 review: why `root` cannot confine a fixture — it is the filesystem root, the home
 * directory or jevitate's home data folder (`~/.jevitate`), where "inside the root" would admit
 * `~/.ssh/` or stored credentials — else null. Compared as named and after realpath.
 */
export function fixtureRootRefusal(root: string): string | null {
  const home = homedir();
  const named: ReadonlyArray<readonly [string, string]> = [
    [resolve(sep), "the filesystem root"],
    [resolve(home), "your home directory"],
    [resolve(join(home, ".jevitate")), "jevitate's home data folder"],
  ];
  const forms = new Set([resolve(root), realOrResolved(root)]);
  for (const [path, why] of named) {
    if (forms.has(path) || forms.has(realOrResolved(path))) return why;
  }
  return null;
}

const KEY_EXTENSIONS: ReadonlySet<string> = new Set([".pem", ".key", ".p12", ".pfx"]);
const SSH_KEY = /^id_(rsa|ed25519|ecdsa)/i;
const STORAGE_STATE = /storage-?state/i;

/**
 * 0.12.0 review: why fixture `file` (a path inside `root`) looks like a secret or run evidence —
 * judged on its path RELATIVE to the root — else null. Refused: any segment starting with `.`
 * (`.env*`, `.git/`, `.jevitate/`, `.ssh/`), private keys and certificates (`*.pem`, `*.key`,
 * `*.p12`, `*.pfx`), SSH keys (`id_rsa*`, `id_ed25519*`, `id_ecdsa*`), network captures (`*.har`),
 * a `*.zip` trace under `logs/`, and a Playwright storage state (`*storage-state*.json`).
 */
export function fixtureSensitiveReason(file: string, root: string): string | null {
  const segments = relative(root, file).split(sep).filter((s) => s !== "");
  const hidden = segments.find((s) => s.startsWith("."));
  if (hidden !== undefined) return `hidden path segment "${hidden}"`;
  const name = basename(file);
  const ext = extname(name).toLowerCase();
  if (KEY_EXTENSIONS.has(ext)) return `private key or certificate (${ext})`;
  if (SSH_KEY.test(name)) return "SSH private key";
  if (ext === ".har") return "network capture (.har)";
  if (ext === ".zip" && (segments.slice(0, -1).some((s) => s.toLowerCase() === "logs") || /trace/i.test(name))) return "run trace (.zip)";
  if (ext === ".json" && STORAGE_STATE.test(name)) return "browser storage state";
  return null;
}

/** `raw` made absolute: a relative path resolves against `root`, never the process cwd. */
export function fixtureCandidatePath(raw: string, root: string): string {
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

/** True when real path `file` is strictly inside real path `root`. */
export function isInsideRoot(file: string, root: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * #498: the real absolute path of fixture `raw`, which must be an existing regular file inside
 * `root` once both are `realpath`ed. Throws `FixturePathError` (`fixture-not-found` /
 * `fixture-outside-project`; `fixture-no-root` when `root` is undefined or confines nothing — `/`,
 * the home directory, `~/.jevitate`; `fixture-sensitive` for a secret-looking file) otherwise.
 */
export async function confineFixture(raw: string, root: string | undefined): Promise<string> {
  if (root === undefined) throw fixtureNoRoot(raw);
  const unsafe = fixtureRootRefusal(root);
  if (unsafe !== null) throw fixtureUnsafeRoot(raw, root, unsafe);
  const candidate = fixtureCandidatePath(raw, root);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw fixtureNoRoot(raw);
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    // A path that is not there and would land outside the root is refused as outside (no probing).
    if (!isInsideRoot(candidate, resolve(root)) && !isInsideRoot(candidate, realRoot)) throw fixtureOutsideProject(candidate, root);
    throw fixtureNotFound(candidate, root, err);
  }
  if (!isInsideRoot(real, realRoot)) throw fixtureOutsideProject(candidate === real ? candidate : `${candidate} (→ ${real})`, root);
  let isFile: boolean;
  try {
    isFile = (await stat(real)).isFile();
  } catch (err) {
    throw fixtureNotFound(candidate, root, err);
  }
  if (!isFile) throw fixtureNotFound(candidate, root);
  // The name as written and the file it really is: a harmless-looking link to `.env` is refused too.
  const sensitive = fixtureSensitiveReason(real, realRoot) ?? (isInsideRoot(candidate, resolve(root)) ? fixtureSensitiveReason(candidate, resolve(root)) : null);
  if (sensitive !== null) throw fixtureSensitive(candidate, root, sensitive);
  return real;
}

/**
 * #498: the synchronous outside-the-root test `journey lint` uses: the candidate path's real
 * location (or, for a path that is not there, its lexical one) is outside `root`. A missing file is
 * not "outside" when it would land inside — that is `upload-file-missing`'s report.
 */
export function fixtureEscapesRoot(raw: string, root: string): { escapes: boolean; candidate: string; real: string } {
  const candidate = fixtureCandidatePath(raw, root);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = resolve(root);
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    // Not there: judge the lexical path against both the root as named and its real location.
    real = candidate;
    return { escapes: !isInsideRoot(candidate, resolve(root)) && !isInsideRoot(candidate, realRoot), candidate, real };
  }
  return { escapes: !isInsideRoot(real, realRoot), candidate, real };
}
