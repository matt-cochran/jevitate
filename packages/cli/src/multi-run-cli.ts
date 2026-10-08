import { join } from "node:path";
import type { Command } from "commander";
import { logsDirFor } from "./project-dir.js";
import { resolveDataDir } from "./data-dir.js";
import { artifactStamp } from "./mission-journal.js";
import { runMultiRun, type MultiRunPlan, type MultiRunResult, type Persona, type RunEnvelope } from "./multi-run.js";
import { setKillSummary } from "./kill-signal.js";
import { clock } from "@jevitate/domain";
import { withRunMetadata } from "./run-metadata.js";

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
    } else if (opt.optional && value === true) {
      // #290: an optional-value option given bare (`--screenshots`, `--record-video`) stores `true`;
      // forward it bare so each run resolves its own default (next to its result), never `"true"`.
      argv.push(opt.long);
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
  /**
   * #220: what a SIGTERM/SIGINT prints for the whole multi-run (the command's own output rule: the
   * envelope with --json, else the human summary) — instead of the killed run's own envelope.
   * Absent: a kill prints the multi-run nothing (a library caller that owns stdout).
   */
  readonly killOutput?: (partial: MultiRunResult) => string;
  /**
   * #427: the pre-flight auth check, run by the orchestrator before EACH run (a persona's session,
   * or the mission's own `--storage-state`): the result a run ends with when the session is expired
   * (and could not be refreshed), else undefined. The runs themselves then skip it (`--auth-check off`).
   */
  readonly authPreflight?: (persona: Persona | undefined) => Promise<unknown>;
}

export async function runExploreMultiRun(args: ExploreMultiRunArgs): Promise<MultiRunResult> {
  const { cmd, plan } = args;
  const outDir = args.out ?? join(logsDirFor((args.nowIso ?? (() => clock.nowIso()))()), `multi-${artifactStamp((args.nowIso ?? (() => clock.nowIso()))())}`);
  // With personas, each run's --storage-state is the persona's; otherwise the mission's own is kept.
  const omit = new Set([...(plan.personas === null ? [] : ["storageState"]), ...(args.authPreflight === undefined ? [] : ["authCheck"])]);
  const base = [...forwardedArgv(cmd, omit), ...(args.authPreflight === undefined ? [] : ["--auth-check", "off"])];
  return runMultiRun({
    plan,
    strategy: args.strategy,
    outDir,
    // #220: a kill writes (and prints) the multi-run's partial aggregate — the interrupted run
    // included — synchronously, then the process exits 130/143 like a single run.
    armKill: (onKill) =>
      setKillSummary(({ signal, exitCode, missions }) => {
        const partial = onKill({ signal, exitCode, ...(missions[0] === undefined ? {} : { partial: missions[0].partial }) });
        return args.killOutput?.(partial);
      }),
    runOnce: async ({ storageState, persona, outDir: runDir }) => {
      // #427: an expired session ends this run fast (auth-expired) — the login page is never explored.
      const expired = await args.authPreflight?.(persona);
      if (expired !== undefined) return { ok: true, data: expired };
      const lines: string[] = [];
      const child = args.newProgram();
      child.exitOverride();
      child.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
      const argv = ["explore", ...base, ...(storageState === undefined ? [] : ["--storage-state", storageState]), "--out", runDir, "--json"];
      let envelope: RunEnvelope;
      try {
        // #426: the persona's name rides in the run's metadata scope (its result's `target.persona`).
        await withRunMetadata(persona === undefined ? {} : { persona: persona.name }, () => child.parseAsync(argv, { from: "user" }));
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
