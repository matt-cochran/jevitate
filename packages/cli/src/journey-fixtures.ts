import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { FixtureFlags } from "./fixture-cli.js";
import { FixtureSpecError, fixtureSpecHash, loadFixtureFile, type FixtureBounds } from "./mission-fixtures.js";
import { journeyFixtureBaseDir } from "./journey-api.js";
import type { LayoutDeps } from "./project-dir.js";

/**
 * #544: a Journey authored under `--fixtures` records the file (relative to the repository root, POSIX
 * separators) and the spec's content hash in `metadata.fixtures`; `journey run`/`verify`/`annotate`
 * load it when no `--fixtures` flag is given. Precedence: the flag, then the Journey's recorded
 * fixtures, then the environment's. Shell hooks are never recorded.
 */

export interface RecordedFixtures {
  readonly file: string;
  readonly specHash: string;
  /** The recorded file, resolved against the repository root. */
  readonly path: string;
}

/** What a run says when the recorded fixtures file changed since the Journey was authored. */
export interface FixtureDrift {
  readonly file: string;
  readonly recordedSpecHash: string;
  readonly currentSpecHash: string;
  readonly message: string;
}

function root(deps: LayoutDeps): string {
  return journeyFixtureBaseDir(deps) ?? resolve((deps.cwd ?? (() => process.cwd()))());
}

/** The `metadata.fixtures` value for a Journey authored under the fixtures file at `fixturesFile`. */
export function recordedFixturesFor(fixturesFile: string, bounds: FixtureBounds, deps: LayoutDeps = {}): { file: string; specHash: string } {
  const base = root(deps);
  const abs = resolve((deps.cwd ?? (() => process.cwd()))(), fixturesFile);
  const file = relative(base, abs).split(sep).join("/");
  return { file, specHash: fixtureSpecHash(loadFixtureFile(abs, bounds, { openRefs: true })) };
}

/** The hash of the fixture spec currently in the file (hooks never count: they are not recorded). */
export function currentSpecHash(path: string, bounds: FixtureBounds): string {
  return fixtureSpecHash(loadFixtureFile(path, bounds, { openRefs: true }));
}

/**
 * The fixture flags a Journey replay uses: unchanged when `--fixtures` is given or the Journey records
 * none; otherwise with `fixtures` set to the recorded file. A missing file is refused here, before any
 * browser. An unknown Journey id is left for the run itself to report.
 */
export async function withRecordedFixtures(
  flags: FixtureFlags,
  opts: { dir: string; id: string; deps?: LayoutDeps },
): Promise<{ flags: FixtureFlags; recorded?: RecordedFixtures }> {
  if (flags.fixtures !== undefined) return { flags };
  let journey: Journey | null;
  try {
    journey = await new FsJourneyStore(opts.dir).get(opts.id);
  } catch {
    return { flags };
  }
  const rec = journey?.metadata.fixtures;
  if (rec === undefined) return { flags };
  const path = isAbsolute(rec.file) ? rec.file : resolve(root(opts.deps ?? {}), rec.file);
  if (!existsSync(path)) {
    throw new FixtureSpecError(
      `journey '${opts.id}' was authored with fixtures ${rec.file}, which is missing (${path}); restore the file or pass --fixtures <file> to use another`,
    );
  }
  return { flags: { ...flags, fixtures: path }, recorded: { file: rec.file, specHash: rec.specHash, path } };
}

/** A drift note when the recorded file's spec no longer matches the hash recorded with the Journey. */
export function fixtureDriftFor(recorded: RecordedFixtures | undefined, bounds: FixtureBounds): FixtureDrift | undefined {
  if (recorded === undefined) return undefined;
  const current = currentSpecHash(recorded.path, bounds);
  if (current === recorded.specHash) return undefined;
  return {
    file: recorded.file,
    recordedSpecHash: recorded.specHash,
    currentSpecHash: current,
    message: `fixtures ${recorded.file} changed since this Journey was authored (spec hash ${recorded.specHash} -> ${current}); running with the current file — re-author or re-verify the Journey if the fixture changes what it expects`,
  };
}
