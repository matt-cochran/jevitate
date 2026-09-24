import { readFileSync } from "node:fs";
import {
  InvariantSpecError,
  mergeInvariantSpecs,
  validateInvariantSpec,
  type InvariantSpec,
} from "@jevitate/recording";

/**
 * `--invariants <file.json>` (repeatable, #86): loads the app team's declared-invariant files,
 * validates each against the closed schema, merges them, and authorizes every probe against the
 * run's allowlist — all BEFORE any browser opens. A bad file refuses the dispatch with a precise
 * path (`a.json: invariants[2].require: unknown observable "balanse"`), never mid-run.
 */

export class InvariantsFileError extends Error {
  readonly code = "E_EXPLORE_INVARIANTS" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvariantsFileError";
  }
}

export interface LoadInvariantsOptions {
  /** The run's authorized origins: every probe must resolve onto one. */
  readonly allowlist: readonly string[];
  /** What relative probe paths resolve against (the run's start URL). */
  readonly baseUrl: string;
}

/** Loads, validates and merges invariant files. Returns undefined for no files. Throws `InvariantsFileError`. */
export function loadInvariantFiles(paths: readonly string[], opts: LoadInvariantsOptions): InvariantSpec | undefined {
  if (paths.length === 0) return undefined;
  const specs: InvariantSpec[] = [];
  for (const path of paths) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new InvariantsFileError(`cannot read invariants file ${path}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
    try {
      specs.push(validateInvariantSpec(raw, opts));
    } catch (e) {
      if (e instanceof InvariantSpecError) throw new InvariantsFileError(`${path}: ${e.problems.join("; ")}`);
      throw e;
    }
  }
  try {
    return mergeInvariantSpecs(specs);
  } catch (e) {
    if (e instanceof InvariantSpecError) throw new InvariantsFileError(e.problems.join("; "));
    throw e;
  }
}
