import { Command } from "commander";
import { MissingCredentialError } from "@jevitate/ai-core";
import { ok, fail } from "./envelope.js";
import { logsDirFor } from "./project-dir.js";
import {
  addMissionTarget,
  listMissionTargets,
  promoteMissionTarget,
  missionTargetContext,
  missionTargetAuth,
  updateMissionTargetAuth,
  withMissionTargetAuthFlags,
  UnknownMissionTargetError,
  type MissionTargetAuthFlags,
} from "./mission-api.js";
import { FsMissionQueueStore } from "@jevitate/missions";
import { drainMissionQueue, needsModel, realQueuedMissionExecutor, type DrainReport } from "./mission-queue-runner.js";
import { loadTargetsFile } from "./target-config.js";
import { withEngine } from "./engine.js";
import { EXIT_CODES } from "./exit-codes.js";
import { positiveIntArg } from "./cli-args.js";
import { resolveDataDir } from "./data-dir.js";
import {
  type CliDeps,
  resolveMissionTargetsDir,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserLaunchFromFlags,
  emitJson,
  GatewaySelectionError,
  buildExploreGateways,
} from "./cli-shared.js";

/** Registers `jevitate mission`: `target add|update|list|promote` and `run` (drains the mission queue). */
export function registerMissionCommands(program: Command, deps: CliDeps): void {
  // Additive: `mission target` — register/list/promote exploration mission
  // targets (Ticket #21). Wires the real fs-backed `@jevitate/missions`
  // store/registry (the SAME store `queue_exploration` resolves promoted
  // targets from). SECURITY: `add` registers UNPROMOTED — the promoted-only
  // gate stays intact, so a registered target is not resolvable by
  // `queue_exploration` until a separate `promote` flips it.
  const mission = program.command("mission").description("manage exploration mission targets and drain the mission queue");
  const missionTarget = mission.command("target");

  const missionTargetAdd = missionTarget
    .command("add <id>")
    .description("register an exploration mission target (UNPROMOTED — not usable by queue_exploration until promoted)")
    .option("--name <name>", "human-readable target name")
    .option("--authorized-origin <origin>", "the target's app origin (a bare http(s) origin); --base-url must be on it")
    .option(
      "--api-origin <origin>",
      "a further origin the app talks to, e.g. its API on another origin (repeatable) — the queued-mission analogue of a second `explore --allow`",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--base-url <url>", "the base URL a mission starts navigation from")
    .option("--description <text>", "optional human-readable description");
  withMissionTargetAuthFlags(missionTargetAdd)
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { name, authorizedOrigin, apiOrigin, baseUrl, description, dir, json, ...authFlags } = this.opts<
        {
          name?: string;
          authorizedOrigin?: string;
          apiOrigin: string[];
          baseUrl?: string;
          description?: string;
          dir?: string;
          json?: boolean;
        } & MissionTargetAuthFlags
      >();
      // Validate in-action + fail envelope (not commander's hard-exiting
      // `.requiredOption`), matching this CLI's convention.
      if (!name || !authorizedOrigin || !baseUrl) {
        emitJson(program, fail("E_MISSION_TARGET_ARGS", "--name, --authorized-origin and --base-url are all required"));
        return;
      }
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const auth = missionTargetAuth(authFlags);
        const target = await addMissionTarget(ctx, {
          id,
          name,
          authorizedOrigin,
          apiOrigins: apiOrigin,
          baseUrl,
          ...(description === undefined ? {} : { description }),
          ...(auth === undefined ? {} : { auth }),
        });
        const envelope = ok(target);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `registered mission target '${target.id}' (unpromoted — run 'jevitate mission target promote ${target.id}' to make it resolvable)\n`,
          );
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_MISSION_TARGET_ADD", String(err instanceof Error ? err.message : err)));
      }
    });

  withMissionTargetAuthFlags(
    missionTarget
      .command("update <id>")
      .description("set a registered target's operator-declared auth for queued missions (#175); keeps its promotion state")
      .option("--clear-auth", "drop the target's storage state, save-back and secret fields first"),
  )
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json, clearAuth, ...authFlags } = this.opts<{ dir?: string; json?: boolean; clearAuth?: boolean } & MissionTargetAuthFlags>();
      const auth = missionTargetAuth(authFlags);
      if (auth === undefined && clearAuth !== true) {
        emitJson(program, fail("E_MISSION_TARGET_ARGS", "nothing to update: pass --storage-state, --save-storage-state, --secret-field or --clear-auth"));
        return;
      }
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const target = await updateMissionTargetAuth(ctx, id, { ...(auth ?? {}), ...(clearAuth === true ? { clear: true } : {}) });
        if (json) {
          emitJson(program, ok(target));
        } else {
          program.configureOutput().writeOut?.(`updated mission target '${target.id}'\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownMissionTargetError) {
          emitJson(program, fail("E_UNKNOWN_MISSION_TARGET", err.message));
          return;
        }
        emitJson(program, fail("E_MISSION_TARGET_UPDATE", String(err instanceof Error ? err.message : err)));
      }
    });

  missionTarget
    .command("list")
    .description("list ALL mission targets (promoted and unpromoted) — a local/dev-facing listing")
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const targets = await listMissionTargets(ctx);
        const envelope = ok(targets);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const t of targets) {
            const origins = [t.authorizedOrigin, ...(t.apiOrigins ?? [])].join(",");
            out?.(`${t.id}\t${t.name}\t${origins}${t.promoted ? "" : " (unpromoted)"}\n`);
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_MISSION_TARGET_LIST", String(err instanceof Error ? err.message : err)));
      }
    });

  missionTarget
    .command("promote <id>")
    .description("promote a registered target so queue_exploration can resolve it")
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const target = await promoteMissionTarget(ctx, id);
        const envelope = ok(target);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`promoted mission target '${target.id}'\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownMissionTargetError) {
          emitJson(program, fail("E_UNKNOWN_MISSION_TARGET", err.message));
        } else {
          emitJson(program, fail("E_MISSION_TARGET_PROMOTE", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // `mission run` (#117) — drains the queue `queue_exploration` (MCP) fills: each queued mission runs
  // through its strategy's CLI runner, its typed result lands in the recordings dir `jevitate mcp`
  // reads, and its queue record moves queued → running → done (resultId) | failed, so
  // `get_mission_result {id: missionId}` resolves it. `--once` (default) drains what is queued now
  // and exits; `--watch` keeps polling.
  withBrowserLaunchFlags(
    mission
      .command("run")
      .description("run queued missions (queue_exploration) through their strategy's runner; get_mission_result {id: missionId} then reads the result"),
  )
    .option("--once", "drain the missions queued now, then exit (default)")
    .option("--watch", "keep draining: poll the queue every --interval ms until interrupted")
    .option("--interval <ms>", "--watch poll interval in ms (default 5000)", positiveIntArg, 5000)
    .option("--dir <path>", "mission queue directory (default: ~/.jevitate/missions/queue)")
    .option("--targets-dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--out <dir>", "where results are written (default: .jevitate/logs/<date> in the project, else ~/.jevitate/logs/<date> — where `jevitate mcp` reads them)")
    .option("--real", "use live Jev + OpenRouter gateways for model-driven missions (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<
        {
          once?: boolean;
          watch?: boolean;
          interval: string;
          dir?: string;
          targetsDir?: string;
          out?: string;
          real?: boolean;
          fakeAi?: boolean;
          json?: boolean;
        } & BrowserLaunchFlags
      >();
      if (o.once && o.watch) {
        emitJson(program, fail("E_MISSION_RUN_ARGS", "--once and --watch are mutually exclusive"));
        return;
      }
      const intervalMs = Number(o.interval);
      if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
        emitJson(program, fail("E_MISSION_RUN_ARGS", `--interval must be a positive integer (got ${JSON.stringify(o.interval)})`));
        return;
      }
      // Model-driven missions need a gateway selection; without one they stay queued (reported as
      // skipped), never run against a silently-substituted fake. Feature missions are model-free.
      let gatewayRefusal: string | undefined;
      try {
        await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false });
      } catch (err) {
        if (!(err instanceof MissingCredentialError || err instanceof GatewaySelectionError)) throw err;
        gatewayRefusal = err.message;
      }
      const queue = new FsMissionQueueStore(o.dir ?? resolveDataDir(["missions", "queue"]));
      const targets = missionTargetContext(resolveMissionTargetsDir(deps, o.targetsDir)).registry;
      // #142 follow-up: ~/.jevitate/targets.json's per-origin logSources/logDefect/allowLogCmd — a
      // queued mission never carries its own (never an MCP argument); this is the operator's only
      // way to declare one for a mission drained here.
      const targetConfigs = loadTargetsFile(deps.explore?.targetsConfigPath);
      const execute =
        deps.missions?.execute ??
        realQueuedMissionExecutor({
          outDir: o.out ?? logsDirFor(),
          gateways: () => buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }),
          ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
          ...(browserLaunchFromFlags(o) === undefined ? {} : { browser: browserLaunchFromFlags(o)! }),
          targets: targetConfigs,
        });
      const drainOnce = () =>
        drainMissionQueue({
          queue,
          targets,
          execute,
          accepts: (m) => (gatewayRefusal !== undefined && needsModel(m) ? `needs a model gateway: ${gatewayRefusal}` : true),
        });
      const emit = (report: DrainReport) => {
        const data = withEngine(report);
        if (o.json) {
          emitJson(program, ok(data));
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(data)}\n`);
        }
        // Every claimed mission ran (whatever its own outcome); 2 only when one could not run at all —
        // it proves nothing, so never 1 (defects) — exit-codes.ts.
        process.exitCode = report.ran.some((m) => m.status === "failed") ? EXIT_CODES.inconclusive : EXIT_CODES.ok;
      };
      try {
        if (!o.watch) {
          emit(await drainOnce());
          return;
        }
        // --watch: one envelope per pass that ran something; interrupted by SIGINT/SIGTERM (the kill
        // switch still writes a killed mission's partial result).
        for (;;) {
          const report = await drainOnce();
          if (report.ran.length > 0) emit(report);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      } catch (err) {
        emitJson(program, fail("E_MISSION_RUN", String(err instanceof Error ? err.message : err)));
      }
    });
}
