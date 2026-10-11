import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

export type FixturePathErrorCode = "fixture-not-found" | "fixture-outside-project" | "fixture-no-root";

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
 * `fixture-outside-project`; `fixture-no-root` when `root` is undefined) otherwise.
 */
export async function confineFixture(raw: string, root: string | undefined): Promise<string> {
  if (root === undefined) throw fixtureNoRoot(raw);
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
