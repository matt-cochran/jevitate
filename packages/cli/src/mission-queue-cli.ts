import { readFileSync } from "node:fs";
import { isRecord } from "@jevitate/domain";
import { Command, Option } from "commander";
import { MISSION_STRATEGIES, QUEUED_SCREENSHOT_MODES } from "@jevitate/missions";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";
import { EXIT_CODES } from "./exit-codes.js";
import { positiveIntArg } from "./cli-args.js";
import { parseAssertionSpec } from "./explore-specs.js";
import { type CliDeps, type EmulationFlags, collectParam, emulationFromFlags, resolveMissionTargetsDir, withEmulationFlags } from "./cli-shared.js";
import { withEnvironmentFlags, type EnvironmentFlags } from "./environments.js";
import { callMcpTool, mcpErrorOf, mcpToolDeps, refusalFor } from "./mcp-cli-bridge.js";

/**
 * `jevitate mission queue` / `mission result` (#254) — MCP `queue_exploration` / `get_mission_result`
 * from the CLI, through the SAME served handlers (mcp-cli-bridge.ts) over the SAME stores. `queue`
 * only enqueues (`jevitate mission run` drains); `result` prints exactly MCP's status body
 * (status, exitCode, isError, goalOutcome, coverage, result) and exits with its contract code.
 */

const QUEUE_DIR_HELP = "mission queue directory (default: ~/.jevitate/missions/queue — the queue `jevitate mcp` and `mission run` use)";


/**
 * A `get_mission_result` body's exit code (exit-codes.ts): a finished mission's own `exitCode`; a
 * mission still queued/running, or one that could not run (`failed`), proves nothing yet — 2, never 0.
 */
export function missionResultExitCode(body: Record<string, unknown>): number {
  if (body.pending === true || body.status === "failed") return EXIT_CODES.inconclusive;
  return typeof body.exitCode === "number" ? body.exitCode : EXIT_CODES.inconclusive;
}

/** `server-log 2 · http-5xx 1`, or `none` (#423). */
function kindCounts(byKind: Record<string, unknown>): string {
  const parts = Object.entries(byKind).flatMap(([k, n]) => (typeof n === "number" && n > 0 ? [`${k} ${n}`] : []));
  return parts.length === 0 ? "none" : parts.join(" · ");
}

export function formatMissionResultHuman(data: unknown): string {
  if (!isRecord(data)) return "";
  const id = String(data.missionId ?? data.id);
  if (data.pending === true) {
    return `${String(data.status).toUpperCase()}  ${id}  (enqueued ${String(data.enqueuedAtIso)})\nnext: jevitate mission run — then jevitate mission result ${id}\n`;
  }
  if (data.kind === "journey") {
    // GAPS 19 (#797): a queued Journey call's stored record.
    const journey = isRecord(data.journey) ? String(data.journey.id) : "?";
    if (data.status === "failed") return `FAILED  ${id} (journey '${journey}')${typeof data.code === "string" ? ` ${data.code}` : ""}: ${String(data.error)} — the call could not run\n`;
    return `${String(data.outcome).toUpperCase()}  ${id} (journey '${journey}')${typeof data.runId === "string" ? ` → run ${data.runId}` : ""}  (exit ${String(data.exitCode)})${typeof data.code === "string" ? `\n  code: ${data.code}` : ""}\n`;
  }
  if (data.status === "failed") return `FAILED  ${id}: ${String(data.error)} — the mission could not run\n`;
  const lines = [`${String(data.status).toUpperCase()}  ${id}${data.resultId === undefined ? "" : ` → ${String(data.resultId)}`}  (exit ${String(data.exitCode)})`];
  if (data.goalOutcome !== undefined) lines.push(`  goal: ${String(data.goalOutcome)}${typeof data.goalReason === "string" ? ` (${data.goalReason})` : ""}`);
  const result = isRecord(data.result) ? data.result : undefined;
  // #423: the defect verdict by kind (structured), else (an older result) the defects' count.
  const byKind = isRecord(data.defectOutcome) && isRecord(data.defectOutcome.byKind) ? data.defectOutcome.byKind : undefined;
  if (byKind !== undefined) lines.push(`  defects: ${kindCounts(byKind)}`);
  else if (result !== undefined && Array.isArray(result.defects)) lines.push(`  defects: ${result.defects.length}`);
  if (data.coverage !== undefined) lines.push(`  coverage: ${JSON.stringify(data.coverage)}`);
  lines.push(`next: jevitate mission result ${id} --json for the full typed result`);
  return `${lines.join("\n")}\n`;
}

/** Registers `mission queue <target>` and `mission result <id>` under `jevitate mission`. */
export function registerMissionQueueCommands(program: Command, mission: Command, deps: CliDeps): void {
  withEmulationFlags(
    mission
      .command("queue <target>")
      .description("enqueue an exploration mission against a PROMOTED target — only queues; `mission run` drains (MCP queue_exploration)")
      .addOption(new Option("--strategy <strategy>", `${MISSION_STRATEGIES.join(" | ")} (required)`).choices(MISSION_STRATEGIES))
      .option("--goal <text>", "goal-based: the objective (exactly one of --goal/--feature/--route)")
      .option("--feature <name>", "feature: the capability to test (goal-based: the objective)")
      .option("--route <glob>", "coverage/exploratory/adversarial/feature: an in-scope route glob, e.g. /thread/** (goal-based: the objective)")
      .option("--success <spec>", "goal-based: the independent success check (required there), e.g. urlIncludes:/done — the `explore --success` page-check forms")
      .option("--max-actions <n>", "budget: max actions (bounded by the queue's ceiling)", positiveIntArg)
      .option("--max-decisions <n>", "budget: max decisions", positiveIntArg)
      .option("--max-candidates <n>", "budget: max candidates", positiveIntArg)
      .option("--min-actions <n>", "goal-based (#424): the minimum actions before the model may conclude (capped by the budget; `explore --min-actions`)", positiveIntArg)
      .option("--min-distinct-states <n>", "goal-based (#424): the minimum distinct page states before the model may conclude (`explore --min-distinct-states`)", positiveIntArg)
      .option("--invariants <file>", "app-declared invariants JSON file (the `explore --invariants` format; probes GET/HEAD on the target's origins; no authFrom.secret)")
      // #255 (MCP queue_exploration parity): media next to the result — never a path in a queued request.
      .option("--record-video", "record a video of the run (headless too), written next to its result; listed as videoPaths")
      .option("--screenshots [mode]", "masked screenshots + index.md next to the result: screens (default, one per distinct screen) | steps (one per step)")
      .option("--evidence-video", "per defect: a captioned evidence clip of its minimal repro + before/at screenshots (defects[].evidence)")
      .option("--persona <name>", "run as this persona: its session in ~/.jevitate/targets.json (personas) for the target's origin — a name, never a path")
      // #800 (GAPS 12): the `explore --job` / `run_exploration {job}` done check, for a queued goal mission.
      .option("--job <id>", "goal-based with --goal (#800): the catalog job (.jevitate/jobs.json) whose done check verifies the run, read in fresh contexts before the run and after each proposed done (`explore --job`)")
      .option("--require-done-check", "goal-based with --goal (#800): an unverified job (no done check, or one already true) exits 2 even when project.json doneCheckPolicy is advisory"),
    // #329: a queued mission persists only viewport/device; --geolocation is not offered here.
    { geolocation: false },
  )
    .option("--dir <path>", QUEUE_DIR_HELP)
    .option("--targets-dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, target: string) {
      const o = this.opts<
        {
          strategy?: string;
          goal?: string;
          feature?: string;
          route?: string;
          success?: string;
          maxActions?: number;
          maxDecisions?: number;
          maxCandidates?: number;
          minActions?: number;
          minDistinctStates?: number;
          invariants?: string;
          recordVideo?: boolean;
          screenshots?: boolean | string;
          evidenceVideo?: boolean;
          persona?: string;
          job?: string;
          requireDoneCheck?: boolean;
          dir?: string;
          targetsDir?: string;
          json?: boolean;
        } & EmulationFlags
      >();
      const refuse = (code: string, message: string): void => emitJsonOrRefusal(program, fail(code, message));
      if (o.strategy === undefined) {
        refuse("E_MISSION_QUEUE_ARGS", `--strategy is required (${MISSION_STRATEGIES.join(" | ")})`);
        return;
      }
      let successAssertion: unknown;
      if (o.success !== undefined) {
        try {
          successAssertion = parseAssertionSpec(o.success);
        } catch (e) {
          refuse("E_MISSION_QUEUE_ASSERTION", e instanceof Error ? e.message : String(e));
          return;
        }
      }
      let invariants: unknown;
      if (o.invariants !== undefined) {
        try {
          invariants = JSON.parse(readFileSync(o.invariants, "utf8"));
        } catch (e) {
          refuse("E_MISSION_QUEUE_INVARIANTS", `cannot read invariants file ${o.invariants}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
          return;
        }
      }
      const screenshots = o.screenshots === undefined ? undefined : o.screenshots === true ? "screens" : o.screenshots;
      if (screenshots !== undefined && !(QUEUED_SCREENSHOT_MODES as readonly string[]).includes(screenshots as string)) {
        refuse("E_MISSION_QUEUE_ARGS", `--screenshots takes a mode only (${QUEUED_SCREENSHOT_MODES.join(" | ")}): a queued mission writes next to its result, never to a chosen directory`);
        return;
      }
      let emulation;
      try {
        emulation = emulationFromFlags(o);
      } catch (e) {
        refuse("E_MISSION_QUEUE_ARGS", e instanceof Error ? e.message : String(e));
        return;
      }
      const budget = {
        ...(o.maxActions === undefined ? {} : { maxActions: o.maxActions }),
        ...(o.maxDecisions === undefined ? {} : { maxDecisions: o.maxDecisions }),
        ...(o.maxCandidates === undefined ? {} : { maxCandidates: o.maxCandidates }),
      };
      // Exactly the MCP request shape; `enqueueMission` (behind the handler) does every other check.
      const args: Record<string, unknown> = {
        target,
        strategy: o.strategy,
        ...(o.goal === undefined ? {} : { goal: o.goal }),
        ...(o.feature === undefined ? {} : { feature: o.feature }),
        ...(o.route === undefined ? {} : { route: o.route }),
        ...(successAssertion === undefined ? {} : { successAssertion }),
        ...(Object.keys(budget).length === 0 ? {} : { budget }),
        ...(o.minActions === undefined && o.minDistinctStates === undefined
          ? {}
          : {
              minEffort: {
                ...(o.minActions === undefined ? {} : { minActions: o.minActions }),
                ...(o.minDistinctStates === undefined ? {} : { minDistinctStates: o.minDistinctStates }),
              },
            }),
        ...(invariants === undefined ? {} : { invariants }),
        ...(emulation?.viewport === undefined ? {} : { viewport: emulation.viewport }),
        ...(emulation?.device === undefined ? {} : { device: emulation.device }),
        ...(o.recordVideo === true ? { recordVideo: true } : {}),
        ...(screenshots === undefined ? {} : { screenshots }),
        ...(o.evidenceVideo === true ? { evidenceVideo: true } : {}),
        ...(o.persona === undefined ? {} : { persona: o.persona }),
        ...(o.job === undefined ? {} : { job: o.job }),
        ...(o.requireDoneCheck === true ? { requireDoneCheck: true } : {}),
      };
      let envelope: JsonEnvelope<unknown>;
      try {
        const apiDeps = mcpToolDeps(deps, {
          missionTargetsDir: resolveMissionTargetsDir(deps, o.targetsDir),
          ...(o.dir === undefined ? {} : { missionQueueDir: o.dir }),
        });
        const { body } = await callMcpTool(apiDeps, "queue_exploration", args);
        const err = mcpErrorOf(body);
        // queue_exploration_refused: an unknown/unpromoted target, a bad shape, an over-ceiling budget
        // or an invalid invariant spec — the request was unusable, nothing was queued (64).
        envelope = err === undefined ? ok(body) : err.error === "queue_exploration_refused" ? fail("E_MISSION_QUEUE_REFUSED", err.message ?? "refused") : refusalFor(this, "MISSION_QUEUE", err, "refused");
      } catch (e) {
        envelope = fail("E_MISSION_QUEUE", e instanceof Error ? e.message : String(e));
      }
      if (!envelope.ok) {
        emitJsonOrRefusal(program, envelope);
        return;
      }
      emitEnvelope(program, envelope, {
        json: o.json === true,
        command: "mission queue",
        human: (data) => {
          const id = isRecord(data) ? String(data.missionId) : "?";
          return `queued mission ${id} (${o.strategy} on '${target}')\nnext: jevitate mission run — then jevitate mission result ${id}\n`;
        },
      });
    });

  mission
    .command("result <id>")
    .description("a mission's status and typed result, by result id or queued missionId, or a queued Journey call's record by callId (MCP get_mission_result); exits with its contract code")
    .option("--dir <path>", QUEUE_DIR_HELP)
    .option("--results-dir <path>", "read the result file from this directory only (default: where `mission run` writes — .jevitate/logs/<date>, then ~/.jevitate)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const o = this.opts<{ dir?: string; resultsDir?: string; json?: boolean }>();
      let envelope: JsonEnvelope<unknown>;
      let exitCode: number | undefined;
      try {
        const apiDeps = mcpToolDeps(deps, {
          ...(o.dir === undefined ? {} : { missionQueueDir: o.dir }),
          ...(o.resultsDir === undefined ? {} : { recordingsDir: o.resultsDir, resultDirsFor: () => [o.resultsDir!] }),
        });
        const { body } = await callMcpTool(apiDeps, "get_mission_result", { id });
        // A status body (finished, pending or failed) is the answer; any other typed error is a refusal.
        if (isRecord(body) && typeof body.status === "string") {
          envelope = ok(body);
          exitCode = missionResultExitCode(body);
        } else {
          envelope = refusalFor(this, "MISSION_RESULT", mcpErrorOf(body) ?? { error: "internal" }, `no mission result '${id}'`);
        }
      } catch (e) {
        envelope = fail("E_MISSION_RESULT", e instanceof Error ? e.message : String(e));
      }
      if (!envelope.ok) {
        emitJsonOrRefusal(program, envelope);
        return;
      }
      emitEnvelope(program, envelope, { json: o.json === true, command: "mission result", human: formatMissionResultHuman, ...(exitCode === undefined ? {} : { exitCode }) });
    });
}

/** `--param k=v` as `journey run` takes it. */
type ParamFlags = Record<string, string>;

/**
 * 0.30.0 #797 `jevitate journey queue <id> [--param k=v] [--env e | --base-url u]` — MCP `queue_journey`
 * from the CLI, through the SAME served handler over the SAME queue (`jevitate mission run` drains it,
 * exactly as run_journey runs a Journey). A secret-named param (or one the Journey declares secret) is
 * refused by name before anything is written: `E_SECRET_PARAM_IN_QUEUE`, exit 64. A queued call never
 * stores a secret value; the run meets a secret the Journey needs with its secret mode.
 */
export function registerJourneyQueueCommand(journey: Command, program: Command, deps: CliDeps): void {
  withEnvironmentFlags(
    journey
      .command("queue <id>")
      .description("queue a call of a PROMOTED Journey for `jevitate mission run` to run (MCP queue_journey) — id, its content hash, non-secret params, env; never a secret value"),
  )
    .option("--param <kv>", "a non-secret param as key=value (repeatable); a secret-named one is refused (E_SECRET_PARAM_IN_QUEUE): the run meets a secret with its secret mode", collectParam, {} as ParamFlags)
    .option("--no-done-check", "#800: the queued run skips the linked job's done check (as journey run --no-done-check); stored on the call")
    .option("--require-done-check", "#800: the queued run exits 2 on an unverified job even under the advisory policy (as journey run --require-done-check); stored on the call")
    .option("--dir <path>", QUEUE_DIR_HELP)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const o = this.opts<{ param: ParamFlags; dir?: string; json?: boolean; doneCheck: boolean; requireDoneCheck?: boolean } & EnvironmentFlags>();
      const args: Record<string, unknown> = {
        id,
        ...(Object.keys(o.param).length === 0 ? {} : { params: o.param }),
        ...(o.env === undefined ? {} : { env: o.env }),
        ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }),
        ...(o.doneCheck === false ? { noDoneCheck: true } : {}),
        ...(o.requireDoneCheck === true ? { requireDoneCheck: true } : {}),
      };
      let envelope: JsonEnvelope<unknown>;
      try {
        const apiDeps = mcpToolDeps(deps, o.dir === undefined ? {} : { missionQueueDir: o.dir });
        const { body } = await callMcpTool(apiDeps, "queue_journey", args);
        const err = mcpErrorOf(body);
        const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
        if (err === undefined) envelope = ok(body);
        // Nothing was written: the param is named, never its value (64, like any unusable input).
        else if (code === "E_SECRET_PARAM_OVER_MCP") {
          emitJsonOrRefusal(program, fail("E_SECRET_PARAM_IN_QUEUE", err.message ?? "a secret param is never queued"), EXIT_CODES.usage);
          return;
        } else envelope = code !== undefined ? fail(code, err.message ?? "refused") : refusalFor(this, "JOURNEY_QUEUE", err, "refused");
      } catch (e) {
        envelope = fail("E_JOURNEY_QUEUE", e instanceof Error ? e.message : String(e));
      }
      if (!envelope.ok) {
        emitJsonOrRefusal(program, envelope);
        return;
      }
      emitEnvelope(program, envelope, {
        json: o.json === true,
        command: "journey queue",
        human: (data) => {
          const callId = isRecord(data) ? String(data.callId) : "?";
          return `queued journey '${id}' as ${callId}\nnext: jevitate mission run — then jevitate mission result ${callId}\n`;
        },
      });
    });
}
