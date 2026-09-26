import type { Command } from "commander";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { resolveExploreAllowlist } from "./explore-api.js";
import { InvariantsFileError, loadInvariantFiles, type LoadInvariantsOptions } from "./invariants-file.js";

/**
 * `jevitate invariants validate <file…>` (#195): lints declared-invariant files WITHOUT a browser —
 * the exact loader `explore --invariants` runs before any browser opens (`loadInvariantFiles`: the
 * closed schema, expression/observable cross-references, probe and `deniedAs` origin authorization,
 * the cross-file merge), so CI can gate committed invariant files. No second implementation.
 *
 * Probe/`deniedAs` origins are authorized only against what the caller names (`--url`, `--allow`);
 * without `--url` a spec that makes network probes is refused, never assumed authorized.
 */

export interface InvariantsFileResult {
  readonly file: string;
  readonly valid: boolean;
  /** The file's declared invariants (when it validated). */
  readonly invariants?: number;
  /** Path-precise problems (`invariants[2].require: unknown observable "balanse"`). */
  readonly problems: string[];
}

export interface InvariantsValidation {
  readonly valid: boolean;
  readonly files: InvariantsFileResult[];
  /** Problems merging the (individually valid) files: a repeated id, an observable declared twice differently. */
  readonly merge: string[];
  /** How to fix an origin-authorization refusal, when one occurred. */
  readonly hint?: string;
}

const ORIGIN_HINT = "pass --url <start-url> (and --allow <origin>, repeatable) to authorize probe and deniedAs origins, as `explore --invariants` does";

/** Validates each file on its own (so every file's problems are reported), then their merge. */
export function validateInvariantFiles(files: readonly string[], opts: LoadInvariantsOptions): InvariantsValidation {
  const results = files.map((file): InvariantsFileResult => {
    try {
      const spec = loadInvariantFiles([file], opts);
      return { file, valid: true, invariants: spec?.invariants.length ?? 0, problems: [] };
    } catch (e) {
      if (!(e instanceof InvariantsFileError)) throw e;
      return { file, valid: false, problems: [...e.problems] };
    }
  });
  let merge: string[] = [];
  if (files.length > 1 && results.every((r) => r.valid)) {
    try {
      loadInvariantFiles(files, opts);
    } catch (e) {
      if (!(e instanceof InvariantsFileError)) throw e;
      merge = [...e.problems];
    }
  }
  const valid = merge.length === 0 && results.every((r) => r.valid);
  const needsOrigins = results.some((r) => r.problems.some((p) => p.includes("authorized origins to be checked against")));
  return { valid, files: results, merge, ...(needsOrigins ? { hint: ORIGIN_HINT } : {}) };
}

function emit(program: Command, envelope: JsonEnvelope<unknown>, exitCode: number): void {
  program.configureOutput().writeOut?.(`${JSON.stringify(envelope)}\n`);
  process.exitCode = exitCode;
}

const collect = (v: string, prev: string[]): string[] => [...prev, v];

export function registerInvariantsCommands(program: Command): void {
  const invariants = program.command("invariants").description("declared-invariant files (`explore --invariants`)");
  invariants
    .command("validate <files...>")
    .description("validate invariant files without a browser (the same pre-browser check `explore --invariants` runs); exit 1 when any is invalid")
    .option("--url <url>", "the run's start URL: relative probe/deniedAs paths resolve against it, and its origin is authorized")
    .option("--allow <origin>", "authorized origin (repeatable; needs --url); REPLACES the URL's own origin, as `explore --allow`", collect, [] as string[])
    .option("--observer <name>", "a registered observer actor a probe `as:` / `deniedAs.actor` may name (repeatable; `explore --actor` minus the primary)", collect, [] as string[])
    .option("--json", "emit a JSON envelope")
    .action(function (this: Command, files: string[]) {
      const o = this.opts<{ url?: string; allow: string[]; observer: string[]; json?: boolean }>();
      if (o.url === undefined && o.allow.length > 0) {
        emit(program, fail("E_INVARIANTS_ARGS", "--allow needs --url (relative probe paths resolve against it)"), 1);
        return;
      }
      // Without --url nothing is authorized: the loader refuses every probe/deniedAs origin itself.
      const opts: LoadInvariantsOptions =
        o.url === undefined
          ? { observers: o.observer }
          : { allowlist: resolveExploreAllowlist(o.url, o.allow), baseUrl: o.url, observers: o.observer };
      const result = validateInvariantFiles(files, opts);
      const exitCode = result.valid ? 0 : 1;
      if (o.json === true) {
        emit(program, ok(result), exitCode);
        return;
      }
      const lines: string[] = [];
      for (const f of result.files) {
        if (f.valid) lines.push(`valid    ${f.file} (${f.invariants ?? 0} invariants)`);
        else {
          lines.push(`invalid  ${f.file}`);
          for (const p of f.problems) lines.push(`  ${p}`);
        }
      }
      if (result.merge.length > 0) {
        lines.push("invalid  merge of the files above");
        for (const p of result.merge) lines.push(`  ${p}`);
      }
      if (result.hint !== undefined) lines.push(`hint: ${result.hint}`);
      program.configureOutput().writeOut?.(`${lines.join("\n")}\n`);
      process.exitCode = exitCode;
    });
}
