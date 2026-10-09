import { resolve } from "node:path";
import type { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { withEngine } from "./engine.js";
import { JEV_PROVIDER_FLAG_HELP, type CliDeps, emitCommandResult, environmentSeams, jevProviderArg } from "./cli-shared.js";
import { intArg, positiveIntArg } from "./cli-args.js";
import { forwardedArgv, lastEnvelope } from "./multi-run-cli.js";
import { withMissionFlags } from "./campaign-cli.js";
import { setKillSummary } from "./kill-signal.js";
import { environmentFromFlags, isEnvironmentError } from "./environments.js";
import { currentRunMetadata, withRunMetadata } from "./run-metadata.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "./run-tags-cli.js";
import {
  MAX_SWEEP_CONCURRENCY,
  SweepArgsError,
  SweepSpecError,
  defaultSweepOutDir,
  loadSweepTargets,
  runSweep,
  type SweepResult,
  type SweepRunOnce,
} from "./sweep-api.js";

/** `sweep`'s own options: everything else it declares is forwarded to every run (as `campaign run`'s). */
const SWEEP_OWNED: ReadonlySet<string> = new Set(["targets", "concurrency", "resume", "out", "stopOnEnvFailure", "hostStarvedRetry", "baseUrl", "env", "json", "tag"]);

/** The human summary: outcome, every target, the deduped defects and the grouped environment causes. */
export function formatSweepHuman(data: unknown): string {
  const r = data as SweepResult;
  const s = r.summary;
  const lines = [
    `SWEEP    ${r.targetsPath}`,
    `outcome  ${r.missionOutcome} (exit ${r.exitCode}) · ${s.targets} target(s): ${s.ran} ran, ${s.resumed} resumed, ${s.errors} error(s), ${s.skipped} skipped · ${s.defects} deduped defect(s)`,
    ...(r.aborted === undefined ? [] : [`STOPPED  ${r.aborted.reason}`]),
    ...r.targets.map(
      (t) =>
        `${t.status.toUpperCase().padEnd(9)}${t.id}${t.persona === undefined ? "" : ` (${t.persona})`} · ${t.strategy} → ${t.missionOutcome}` +
        `${t.environmentFailure === undefined ? (t.failure === undefined ? "" : ` (${t.failure.kind})`) : ` [environment: ${t.environmentFailure.kind}]`}`,
    ),
    ...r.defects.map((d) => `${d.advisory === true ? "ADVISORY" : "DEFECT  "} ${d.title ?? d.message ?? d.fingerprint} · ${d.kind} · ${d.sightingCount} target(s): ${d.targets.join(", ")}`),
    ...r.environment.failures.map((f) => `ENV      ${f.kind}: ${f.count} target(s) (${f.targets.join(", ")}) — ${f.message}`),
    ...r.environment.causes.map((c) => `DEGRADED ${c.ruleId === undefined ? "" : `${c.ruleId}: `}${c.message} · ${c.targets.length} target(s)`),
    `result   ${r.resultPath}`,
    ...(r.complete ? [] : [`next: jevitate sweep --targets ${r.targetsPath} --out ${r.outDir} --resume`]),
  ];
  return `${lines.join("\n")}\n`;
}

/** Every command in a fresh program, writing only to `write` and never exiting the process. */
function captureTree(cmd: Command, write: (s: string) => void): void {
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: write, writeErr: () => undefined, outputError: () => undefined });
  for (const sub of cmd.commands) captureTree(sub, write);
}

/** The real run of one target: the `explore` command, re-parsed in a fresh program, in process. */
export function exploreRunOnce(newProgram: () => Command): SweepRunOnce {
  return async ({ target, argv }) => {
    const lines: string[] = [];
    const child = newProgram();
    captureTree(child, (s) => lines.push(s));
    try {
      // #426: the persona's name rides in the run's metadata scope (its result's `target.persona`).
      await withRunMetadata(target.persona === undefined ? {} : { persona: target.persona.name }, () => child.parseAsync([...argv], { from: "user" }));
      return lastEnvelope(lines);
    } catch (err) {
      return { ok: false, error: { code: "E_SWEEP_RUN", message: err instanceof Error ? err.message : String(err) } };
    }
  };
}

/** Registers `jevitate sweep` (#425). */
export function registerSweepCommand(program: Command, deps: CliDeps, buildProgram: (deps: CliDeps) => Command): void {
  withMissionFlags(
    program
      .command("sweep")
      .description(
        "run many explore missions — one per target in a targets file (.tsv or .json: id, url|route, persona, strategy, goal, tags, explore options) — " +
          "with bounded concurrency, resumable, and write ONE sweep.result.json: per-target outcomes and depth, defects deduped by fingerprint across targets, environment causes grouped. " +
          "Every run is tagged target=<id> plus the sweep's and the target's tags",
      ),
  )
    .requiredOption("--targets <file>", "the targets file (.tsv with a header row, or .json: an array or {baseUrl?, defaults?, targets})")
    .option("--concurrency <n>", `runs at once (default 1, at most ${MAX_SWEEP_CONCURRENCY}; the machine-wide browser cap still applies)`, intArg({ min: 1, max: MAX_SWEEP_CONCURRENCY }))
    .option("--resume", "skip every target whose run already finished in --out (its run.envelope.json); re-run the rest", false)
    .option("--out <dir>", "the sweep directory: <id>/ per target and sweep.result.json (default .jevitate/logs/<date>/sweep-<stamp>; required with --resume)")
    .option("--stop-on-env-failure <k>", "stop starting runs when the first K runs ALL failed for environment/setup reasons (auth expired, target unreachable, crash, a run that could not start)", positiveIntArg)
    .option("--no-host-starved-retry", "record a target whose run stalled on a starved host (failure.kind host-starved) as is; by default it is retried ONCE after the host's load drops (bounded wait, #452)")
    .option("--base-url <url>", "resolve each target's route against this origin (wins over --env and the file's baseUrl; else JEVITATE_BASE_URL)")
    .option("--env <name>", "resolve each target's route against this named environment's base URL (.jevitate/environments.json)")
    .option("--real", "use live Jev + OpenRouter gateways for every run (requires keys)")
    .option("--fake-ai", "use deterministic fake gateways for every run (pipeline smoke only)")
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--json", "emit the JSON envelope (default: a human summary)")
    .option(TAG_FLAG, TAG_HELP, collectTag, [])
    .action(
      taggedAction(program, "sweep", async function (this: Command) {
        const o = this.opts<{ targets: string; concurrency?: number; resume?: boolean; out?: string; stopOnEnvFailure?: number; hostStarvedRetry?: boolean; baseUrl?: string; env?: string; json?: boolean }>();
        const emit = (envelope: Parameters<typeof emitCommandResult>[1], exitCode?: number): void =>
          emitCommandResult(program, envelope, { json: o.json === true, command: "sweep", human: formatSweepHuman, ...(exitCode === undefined ? {} : { exitCode }) });
        try {
          if (o.resume === true && o.out === undefined) throw new SweepArgsError("--resume needs --out <dir> (the sweep directory to resume)");
          let baseUrl = o.baseUrl;
          if (baseUrl === undefined && o.env !== undefined) baseUrl = environmentFromFlags({ env: o.env }, environmentSeams(deps))?.baseUrl;
          const targets = loadSweepTargets(o.targets, { ...(baseUrl === undefined ? {} : { baseUrl }) });
          const result = await runSweep({
            plan: {
              targetsPath: resolve(o.targets),
              targets,
              concurrency: o.concurrency ?? 1,
              resume: o.resume === true,
              outDir: resolve(o.out ?? defaultSweepOutDir()),
              ...(o.stopOnEnvFailure === undefined ? {} : { stopOnEnvFailure: o.stopOnEnvFailure }),
              ...(o.hostStarvedRetry === false ? { retryHostStarved: false } : {}),
              tags: currentRunMetadata()?.tags ?? {},
              runArgs: forwardedArgv(this, SWEEP_OWNED),
            },
            runOnce: exploreRunOnce(() => buildProgram(deps)),
            // A kill writes (and prints) the sweep's partial aggregate synchronously, then exits 130/143.
            armKill: (onKill) =>
              setKillSummary(({ signal, exitCode }) => {
                const partial = onKill(signal, exitCode);
                return o.json === true ? `${JSON.stringify(ok(withEngine(partial)))}\n` : formatSweepHuman(partial);
              }),
          });
          emit(ok(withEngine(result)), result.exitCode);
        } catch (err) {
          if (err instanceof SweepSpecError || err instanceof SweepArgsError) emit(fail(err.code, err.message));
          else if (isEnvironmentError(err)) emit(fail(err.code, err.message));
          else emit(fail("E_SWEEP_RUN", String(err instanceof Error ? err.message : err)));
        }
      }),
    );
}
