import { Command } from "commander";
import { type CliDeps, emitCommandResult } from "../cli-shared.js";
import { ok, fail, type JsonEnvelope } from "../envelope.js";
import { formatMissionHuman, formatMultiRunHuman } from "../cli-output.js";
import { withEngine } from "../engine.js";
import { setKillSwitchOutput } from "../kill-signal.js";
import { MultiRunArgsError, projectPersonaFor, resolveMultiRunPlan, wantsMultiRun, type Persona } from "../multi-run.js";
import { MultiRunAbortedError, runExploreMultiRun } from "../multi-run-cli.js";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import { type ExploreOpts } from "./shared.js";
import { validateExploreRun } from "./run-options-validate.js";
import { buildExploreRunContext, type ExploreRunPreparation } from "./run-options-context.js";

/** The pre-run resolution of the explore command: everything the action needs before it dispatches a strategy. */
export type { ExploreRunPreparation } from "./run-options-context.js";

/**
 * Parses, normalises and validates every explore flag (the action handler of registerExploreRun)
 * into the typed context the strategy runners take. Refusals are reported through the caller's
 * emitExplore and end the command with undefined.
 *
 * d04b moved its two stages out: flag validation/normalisation lives in `run-options-validate.ts`,
 * context/modeMeta building in `run-options-context.ts`. This file keeps the multi-run dispatch
 * (and the layout guard that keys on its `runExploreMultiRun` call) as the orchestrator.
 */
export async function resolveExploreRunOptions(
  program: Command,
  o: ExploreOpts,
  deps: CliDeps,
  buildProgram: (deps: CliDeps) => Command,
  command: Command,
): Promise<ExploreRunPreparation | undefined> {
  // #210: one output rule for every strategy — the envelope with --json, a human summary without.
  const emitExplore = (envelope: JsonEnvelope<unknown>, exitCode?: number, human: (data: unknown) => string = formatMissionHuman): void =>
    emitCommandResult(program, envelope, { json: o.json === true, command: "explore", human, ...(exitCode === undefined ? {} : { exitCode }) });

  const validated = await validateExploreRun(program, o, deps, buildProgram, command, emitExplore);
  if (validated === undefined) return;
  const { strategy, authCheck, sessionPreflight } = validated;
  // Repeat-and-vote (#141) / persona matrix (#143): the same command, run sequentially and aggregated.
  if (wantsMultiRun(o)) {
    try {
      const plan = resolveMultiRunPlan(o);
      const result = await runExploreMultiRun({
        cmd: command,
        newProgram: () => buildProgram(deps),
        plan,
        strategy,
        ...(o.out === undefined ? {} : { out: o.out }),
        // #220: a killed multi-run prints ITS partial summary, by this command's own output rule.
        killOutput: (partial) => (o.json === true ? `${JSON.stringify(ok(withEngine(partial)))}\n` : formatMultiRunHuman(partial)),
        // #427: each run's session (its persona's, or the mission's own) is checked before it starts.
        ...(authCheck.mode === "off"
          ? {}
          : {
              authPreflight: async (p: Persona | undefined) => {
                const state = p?.storageState ?? o.storageState;
                if (state === undefined) return undefined;
                const r = await sessionPreflight(state, p ?? projectPersonaFor(state));
                return r === undefined ? undefined : withEngine(r);
              },
            }),
      });
      emitExplore(ok(withEngine(result)), result.exitCode, formatMultiRunHuman);
    } catch (err) {
      if (err instanceof MultiRunArgsError) emitExplore(fail(err.code, err.message));
      else if (err instanceof UnauthorizedExploreTargetError) emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
      else if (err instanceof MultiRunAbortedError) emitExplore(fail(err.envelope.error.code, err.envelope.error.message));
      else emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
    }
    return;
  }
  // #120: a killed run prints what this command would have printed — the envelope with --json,
  // else the human summary (#210) — before it exits.
  setKillSwitchOutput(o.json === true ? "envelope" : "human");
  return buildExploreRunContext(program, o, deps, emitExplore, validated);
}
