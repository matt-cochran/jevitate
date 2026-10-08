import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { MISSION_STRATEGIES, QUEUED_SCREENSHOT_MODES } from "@jevitate/missions";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";
import { EXIT_CODES } from "./exit-codes.js";
import { positiveIntArg } from "./cli-args.js";
import { parseAssertionSpec } from "./explore-specs.js";
import { type CliDeps, type EmulationFlags, emulationFromFlags, resolveMissionTargetsDir, withEmulationFlags } from "./cli-shared.js";
import { callMcpTool, mcpErrorOf, mcpToolDeps, refusalFor } from "./mcp-cli-bridge.js";

/**
 * `jevitate mission queue` / `mission result` (#254) — MCP `queue_exploration` / `get_mission_result`
 * from the CLI, through the SAME served handlers (mcp-cli-bridge.ts) over the SAME stores. `queue`
 * only enqueues (`jevitate mission run` drains); `result` prints exactly MCP's status body
 * (status, exitCode, isError, goalOutcome, coverage, result) and exits with its contract code.
 */

const QUEUE_DIR_HELP = "mission queue directory (default: ~/.jevitate/missions/queue — the queue `jevitate mcp` and `mission run` use)";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

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
      .option("--persona <name>", "run as this persona: its session in ~/.jevitate/targets.json (personas) for the target's origin — a name, never a path"),
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
    .description("a mission's status and typed result, by result id or queued missionId (MCP get_mission_result); exits with its contract code")
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
