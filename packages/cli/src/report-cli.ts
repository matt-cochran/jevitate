import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import {
  ReportInputError,
  buildReport,
  defaultResultDirs,
  diffRunRefs,
  listBaselines,
  readBaseline,
  resolveRunRefs,
  summarizeRun,
  tagBaseline,
} from "./report-api.js";

/**
 * `jevitate report` (#139), `jevitate diff` and `jevitate baseline` (#138). Read-only over persisted
 * results (already redacted); `baseline tag` writes a findings snapshot under `~/.jevitate/baselines`.
 */

export interface ReportCliDeps {
  /** Mission targets dir used to resolve `--target <name>` (default `~/.jevitate/missions/targets`). */
  readonly missionTargetsDir: string;
  /** Baselines dir (default `~/.jevitate/baselines`). */
  readonly baselinesDir?: string;
}

function emit(program: Command, envelope: JsonEnvelope<unknown>, exitCode?: number): void {
  program.configureOutput().writeOut?.(`${JSON.stringify(envelope)}\n`);
  process.exitCode = exitCode ?? (envelope.ok ? 0 : 1);
}

function failure(program: Command, err: unknown, code: string): void {
  if (err instanceof ReportInputError) emit(program, fail(err.code, err.message));
  else emit(program, fail(code, err instanceof Error ? err.message : String(err)));
}

const collect = (v: string, prev: string[]): string[] => [...prev, v];

export function registerReportCommands(program: Command, deps: ReportCliDeps): void {
  program
    .command("report")
    .description("one deduped defect list for a target across every mode and run (markdown + JSON envelope)")
    .option("--target <origin|name>", "the target: an origin (or URL on it), a suite target name, or a registered mission target")
    .option("--since <run|date>", "only runs that started at/after this ISO date or this run")
    .option("--dir <dir>", "results dir to read (repeatable; default ~/.jevitate/recordings and ~/.jevitate/ux-reports)", collect, [] as string[])
    .option("--baseline <run|tag|last>", "add a diff section against a baseline: a run, a `baseline tag`, or `last` (the previous run per target+mode)")
    .option("--out <dir>", "also write report.md and report.json here")
    .option("--json", "emit the JSON envelope instead of markdown")
    .action(async function (this: Command) {
      const o = this.opts<{ target?: string; since?: string; dir: string[]; baseline?: string; out?: string; json?: boolean }>();
      try {
        const report = await buildReport({
          missionTargetsDir: deps.missionTargetsDir,
          dirs: o.dir,
          ...(o.target === undefined ? {} : { target: o.target }),
          ...(o.since === undefined ? {} : { since: o.since }),
          ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
          ...(deps.baselinesDir === undefined ? {} : { baselinesDir: deps.baselinesDir }),
        });
        if (o.out !== undefined) {
          await mkdir(o.out, { recursive: true });
          await writeFile(join(o.out, "report.md"), report.markdown, "utf8");
          await writeFile(join(o.out, "report.json"), `${JSON.stringify(ok(report), null, 2)}\n`, "utf8");
        }
        if (o.json) emit(program, ok(report), 0);
        else {
          program.configureOutput().writeOut?.(report.markdown);
          process.exitCode = 0;
        }
      } catch (err) {
        failure(program, err, "E_REPORT");
      }
    });

  program
    .command("diff <runA> <runB>")
    .description("classify findings new / resolved / still-present / flaky / not-rerun between two runs (runA = baseline)")
    .option("--dir <dir>", "results dir to look run ids up in (repeatable)", collect, [] as string[])
    .option("--json", "emit the JSON envelope instead of markdown")
    .action(async function (this: Command, runA: string, runB: string) {
      const o = this.opts<{ dir: string[]; json?: boolean }>();
      try {
        const r = diffRunRefs(runA, runB, {
          dirs: o.dir.length > 0 ? o.dir : defaultResultDirs(),
          ...(deps.baselinesDir === undefined ? {} : { baselinesDir: deps.baselinesDir }),
        });
        if (o.json) emit(program, ok({ baseline: r.baseline, current: r.current, summary: r.diff.summary, entries: r.diff.entries }), 0);
        else {
          program.configureOutput().writeOut?.(r.markdown);
          process.exitCode = 0;
        }
      } catch (err) {
        failure(program, err, "E_DIFF");
      }
    });

  const baseline = program.command("baseline").description("named baselines for `diff`, `report --baseline` and `check --baseline`");
  baseline
    .command("tag <name> <runs...>")
    .description("snapshot runs (result files, run ids, check records or other tags) as a named baseline")
    .option("--dir <dir>", "results dir to look run ids up in (repeatable)", collect, [] as string[])
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string, runs: string[]) {
      const o = this.opts<{ dir: string[]; json?: boolean }>();
      try {
        const dirs = o.dir.length > 0 ? o.dir : defaultResultDirs();
        const resolved = resolveRunRefs(runs, { dirs, ...(deps.baselinesDir === undefined ? {} : { baselinesDir: deps.baselinesDir }) });
        const { tag, path } = await tagBaseline({ name, runs: resolved, ...(deps.baselinesDir === undefined ? {} : { dir: deps.baselinesDir }) });
        emit(program, ok({ name: tag.name, path, createdAt: tag.createdAt, runs: tag.runs.map(summarizeRun) }), 0);
      } catch (err) {
        failure(program, err, "E_BASELINE");
      }
    });
  baseline
    .command("list")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      try {
        emit(program, ok(await listBaselines(deps.baselinesDir)), 0);
      } catch (err) {
        failure(program, err, "E_BASELINE");
      }
    });
  baseline
    .command("show <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      try {
        const tag = readBaseline(name, deps.baselinesDir);
        if (tag === null) emit(program, fail("E_BASELINE", `no baseline tag named ${JSON.stringify(name)}`));
        else emit(program, ok({ name: tag.name, createdAt: tag.createdAt, sources: tag.sources, runs: tag.runs.map(summarizeRun) }), 0);
      } catch (err) {
        failure(program, err, "E_BASELINE");
      }
    });
}
