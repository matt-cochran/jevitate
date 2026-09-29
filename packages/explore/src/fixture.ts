import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The mission fixture: a local file the `upload` op attaches to a file input.
 * It is chosen by whoever launches the mission (CLI `--fixture`), never by the
 * model. It is validated ONCE at mission start so a typo'd path fails fast —
 * before any browser/model work — instead of surfacing mid-run as a failed act.
 */

/** Thrown when a mission's fixture path does not name an existing regular file. */
export class FixtureNotFoundError extends Error {
  constructor(readonly path: string, options?: { cause?: unknown }) {
    super(`fixture not found: ${path}`, options);
    this.name = "FixtureNotFoundError";
  }
}

/**
 * Resolves `path` to an absolute path (so the recorded upload replays from any
 * working directory) and asserts it is an existing regular file. Throws
 * `FixtureNotFoundError` otherwise — a directory is not a fixture.
 */
export async function resolveMissionFixture(path: string): Promise<string> {
  const absolute = resolve(path);
  let isFile: boolean;
  try {
    isFile = (await stat(absolute)).isFile();
  } catch (err) {
    throw new FixtureNotFoundError(path, { cause: err });
  }
  if (!isFile) throw new FixtureNotFoundError(path);
  return absolute;
}
