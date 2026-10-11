import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { confineFixture, FixturePathError } from "@jevitate/recording";

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
 * Resolves `path` (against the working directory, as the CLI flag names it) to an absolute path
 * (so the recorded upload replays from any working directory) and asserts it is an existing
 * regular file. Throws `FixtureNotFoundError` otherwise — a directory is not a fixture.
 *
 * #498: with `root` (the project root), the fixture must also lie INSIDE it once realpath'd — an
 * absolute path, `../` or a symlink that escapes throws `FixturePathError`
 * (`fixture-outside-project`). The mission loop always passes its `fixtureRoot`; without one the
 * loop refuses the fixture (`fixture-no-root`).
 */
export async function resolveMissionFixture(path: string, root?: string): Promise<string> {
  const absolute = resolve(path);
  if (root !== undefined) {
    try {
      await confineFixture(absolute, root);
    } catch (err) {
      if (err instanceof FixturePathError && err.code === "fixture-not-found") throw new FixtureNotFoundError(path, { cause: err });
      throw err;
    }
    return absolute;
  }
  let isFile: boolean;
  try {
    isFile = (await stat(absolute)).isFile();
  } catch (err) {
    throw new FixtureNotFoundError(path, { cause: err });
  }
  if (!isFile) throw new FixtureNotFoundError(path);
  return absolute;
}
