import { readFileSync } from "node:fs";
import {
  InvariantSpecError,
  invariantAuthSecretRefs,
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
  /** #147: the registered observer actors (every `--actor` but the primary) cross-actor checks may name. */
  readonly observers?: readonly string[];
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

/**
 * Resolves every `authFrom.secret` ref (#135, `env:VAR`) a spec's probes use, from `env` — the ONE
 * place this ever happens (the CLI dispatch), matching `--secret-field`'s own `env:VAR` resolution.
 * Throws `InvariantsFileError` (naming the ref, never a value) for an unset/empty variable. Returns
 * a map keyed by the ref itself (`"env:APP_TOKEN"` → its value) for `InvariantMonitorOptions.authTokens`.
 */
export function resolveInvariantAuthTokens(
  spec: InvariantSpec,
  env: Readonly<Record<string, string | undefined>>,
): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const ref of invariantAuthSecretRefs(spec)) {
    const name = ref.slice("env:".length);
    const value = env[name];
    if (value === undefined || value === "") {
      throw new InvariantsFileError(`--invariants: authFrom.secret ${ref}: environment variable ${name} is not set`);
    }
    tokens.set(ref, value);
  }
  return tokens;
}
