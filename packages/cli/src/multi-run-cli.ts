import { join } from "node:path";
import type { Command } from "commander";
import { logsDirFor } from "./project-dir.js";
import { resolveDataDir } from "./data-dir.js";
import { artifactStamp } from "./mission-journal.js";
import { runMultiRun, type MultiRunPlan, type MultiRunResult, type RunEnvelope } from "./multi-run.js";

/**
 * The `explore --repeat/--persona` CLI glue (#141/#143): each run is the SAME `explore` command,
 * re-parsed in a fresh program with the multi-run flags removed and `--out` (plus a persona's
 * `--storage-state`) set per run — so every run goes through exactly the validation, gateways,
 * invariants and checks a single run does, and opens its own fresh browser context.
 */

/** Flags the orchestrator owns: never forwarded to an individual run. */
const MULTI_RUN_ATTRS = new Set(["repeat", "minAgreement", "persona", "personas", "out", "json"]);

/**
 * The command line a single run is re-invoked with: every option the user actually gave (source
 * `cli`), minus the orchestrator's own and `omit`. Values are forwarded as given; storage-state
 * CONTENTS are never read here (only their paths travel).
 */
export function forwardedArgv(cmd: Command, omit: ReadonlySet<string> = new Set()): string[] {
  const opts = cmd.opts<Record<string, unknown>>();
  const argv: string[] = [];
  for (const opt of cmd.options) {
    const attr = opt.attributeName();
    if (opt.long === undefined || MULTI_RUN_ATTRS.has(attr) || omit.has(attr)) continue;
    if (cmd.getOptionValueSource(attr) !== "cli") continue;
    const value = opts[attr];
    if (opt.negate) {
      if (value === false) argv.push(opt.long);
    } else if (opt.isBoolean()) {
      if (value === true) argv.push(opt.long);
    } else if (Array.isArray(value)) {
      for (const v of value) argv.push(opt.long, String(v));
    } else if (value !== undefined) {
      argv.push(opt.long, String(value));
    }
  }
  return argv;
}

/** A run's own command failed before its mission could run (bad args, missing keys, …): stop the multi-run. */
export class MultiRunAbortedError extends Error {
  constructor(readonly envelope: Extract<RunEnvelope, { ok: false }>) {
    super(envelope.error.message);
    this.name = "MultiRunAbortedError";
  }
}

/** The last JSON envelope a run wrote (`{v, ok, …}`), or a typed failure when it wrote none. */
export function lastEnvelope(lines: readonly string[]): RunEnvelope {
  const text = lines.join("");
  const candidates = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(candidates[i]!);
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { ok?: unknown }).ok === "boolean") {
        return parsed as RunEnvelope;
      }
    } catch {
      // not an envelope line
    }
  }
  return { ok: false, error: { code: "E_EXPLORE_RUN", message: "the run wrote no result envelope" } };
}

export interface ExploreMultiRunArgs {
  /** The `explore` command being run (its parsed options are forwarded). */
  readonly cmd: Command;
  /** A fresh, unparsed program built from the same deps. */
  readonly newProgram: () => Command;
  readonly plan: MultiRunPlan;
  readonly strategy: string;
  /** `--out`: the multi-run directory (default `~/.jevitate/multi-runs/multi-<stamp>`). */
  readonly out?: string;
  readonly nowIso?: () => string;
}

export async function runExploreMultiRun(args: ExploreMultiRunArgs): Promise<MultiRunResult> {
  const { cmd, plan } = args;
  const outDir = args.out ?? join(logsDirFor((args.nowIso ?? (() => new Date().toISOString()))()), `multi-${artifactStamp((args.nowIso ?? (() => new Date().toISOString()))())}`);
  // With personas, each run's --storage-state is the persona's; otherwise the mission's own is kept.
  const base = forwardedArgv(cmd, plan.personas === null ? new Set() : new Set(["storageState"]));
  return runMultiRun({
    plan,
    strategy: args.strategy,
    outDir,
    runOnce: async ({ storageState, outDir: runDir }) => {
      const lines: string[] = [];
      const child = args.newProgram();
      child.exitOverride();
      child.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
      const argv = ["explore", ...base, ...(storageState === undefined ? [] : ["--storage-state", storageState]), "--out", runDir, "--json"];
      let envelope: RunEnvelope;
      try {
        await child.parseAsync(argv, { from: "user" });
        envelope = lastEnvelope(lines);
      } catch (err) {
        envelope = { ok: false, error: { code: "E_EXPLORE_RUN", message: String(err instanceof Error ? err.message : err) } };
      }
      // A command-level failure (arguments, AI setup, an unauthorized target) repeats identically on
      // every run: stop instead of recording N copies of it. A run that broke mid-mission is kept.
      if (!envelope.ok && envelope.error.code !== "E_EXPLORE_RUN") throw new MultiRunAbortedError(envelope);
      return envelope;
    },
  });
}
