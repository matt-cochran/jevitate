import type { Journey } from "@jevitate/journey";
import type { BrowserPort, BrowserSession } from "@jevitate/playwright";
import { inMcpInvocation, noteMcpRefusal } from "./approval-provenance.js";
import { resolveRunTarget, runModeRefusal, type RunTarget, type RunTargetRequest } from "./journey-run-mode-gate.js";
import { prepareMcpRunGuard, RunGuardRefusedError, type McpRunGuard, type McpRunGuardRequest } from "./mcp-run-guard.js";
import type { RunMode, TargetTrust } from "./run-mode.js";

/**
 * 0.30.0 Contract 4 (docs/design/0.30.0-evidence-and-trust.md §5): the run mode on the run surfaces that do
 * not replay through `runJourneyProgrammatically` and its run hooks: a load test (`load run`, MCP
 * `run_load_test`), an exploration (`explore`, MCP `run_exploration`, and the later run of a mission
 * `queue_exploration` queued), `regression run|capture`, `verify-fix` (MCP `verify_fix`) and `source run`.
 *
 * Each decides the mode the same way the run-mode hook does (`resolveRunTarget`): from the person-written
 * `.jevitate/environments.json` and `~/.jevitate/targets.json` only, never from an argument, and an origin
 * nothing declares is `unknown`, automation mode. Where the surface runs a Journey (a load test), the
 * Journey refusals of the mode apply as on `journey run` (`runModeRefusal`): over MCP an automation-mode
 * target needs a Journey a person approved (`E_APPROVAL_CHANNEL_FOR_MODE`), and a test-mode target never
 * runs a Journey with a human step (`E_HUMAN_STEP_IN_TEST_MODE`). Under an MCP call the #789 guard
 * (`prepareMcpRunGuard`) is given the mode, so test mode gets a3a98bb's relaxation (decided again by the
 * guard from the same files) and automation mode keeps 0.29.0's refusals.
 *
 * The decided mode is recorded on the surface's result as `run.mode` and `run.target.trust`.
 */

export type RunSurface = "load" | "explore" | "queue" | "mission" | "regression" | "verify-fix" | "source";

/** What a surface's result records of its mode: `run.mode`, `run.target.trust` (as `RunEvidence.run`). */
export interface RunModeRecord {
  readonly mode: RunMode;
  readonly target: { readonly origin: string; readonly trust: TargetTrust };
  /** Test mode's relaxations the run used (code-templated: a rule or an origin, a step; never a value). */
  readonly notes?: readonly string[];
}

export interface SurfaceRunMode extends RunTarget {
  readonly surface: RunSurface;
}

export interface SurfaceRunModeRequest extends RunTargetRequest {
  readonly surface: RunSurface;
  /** The Journey the surface runs, if it runs one: the mode's Journey refusals apply to it. */
  readonly journey?: Journey | undefined;
}

type Observer = (decided: SurfaceRunMode) => void;
const observers = new Set<Observer>();

/** Told of every mode a surface decides (before its refusal, if any). For tests and diagnostics; returns the unsubscription. */
export function observeSurfaceRunModes(fn: Observer): () => void {
  observers.add(fn);
  return () => {
    observers.delete(fn);
  };
}

/**
 * Decides a surface's run mode from the target configuration, and refuses what the mode forbids of the
 * Journey it runs (if any). Throws `RunModeRefusedError` (noted on the MCP call, so its tool result is the
 * refusal whatever the command made of it).
 */
export function resolveSurfaceRunMode(req: SurfaceRunModeRequest): SurfaceRunMode {
  const decided: SurfaceRunMode = { ...resolveRunTarget(req), surface: req.surface };
  for (const fn of observers) fn(decided);
  if (req.journey !== undefined) {
    const mcp = inMcpInvocation();
    const refusal = runModeRefusal(req.journey, decided, { mcp });
    if (refusal !== undefined) {
      if (mcp) noteMcpRefusal(refusal);
      throw refusal;
    }
  }
  return decided;
}

/** The `run` record of a decided mode. */
export function runModeRecord(decided: RunTarget, notes: readonly string[] = []): RunModeRecord {
  return { mode: decided.mode, target: { origin: decided.origin, trust: decided.trust }, ...(notes.length === 0 ? {} : { notes: [...notes] }) };
}

/** The #789 guard request of a surface, with its mode: test mode's relaxation is collected into `notes`. */
export function guardRequestWithMode(req: McpRunGuardRequest, decided: RunTarget, notes: string[]): McpRunGuardRequest {
  return { ...req, mode: decided.mode, onRelaxed: (note) => void (notes.includes(note) ? undefined : notes.push(note)) };
}

/**
 * A browser port factory whose every session is armed with a fresh #789 guard before its first request
 * (`guardFor` returns undefined outside an MCP call, and then the port is the inner one). For an
 * exploration, whose writes the model chooses: a write the guard refuses is aborted at the context and ends
 * the MCP call refused.
 */
export function guardedPortFactory(inner: () => BrowserPort, guardFor: () => McpRunGuard | undefined): () => BrowserPort {
  return () => {
    const port = inner();
    return {
      open: async (opts) => {
        const session: BrowserSession = await port.open(opts);
        const guard = guardFor();
        try {
          await guard?.arm(session, {});
        } catch (err) {
          await session.close().catch(() => undefined);
          throw err;
        }
        return session;
      },
    };
  };
}

/**
 * Over MCP an exploration asked to click destructive controls (`allowDestructive`, an argument the agent
 * chose): automation mode refuses it unless the operator's `targets.json` `mcpRun.allowDestructive` lifts it
 * for the origin, as a Journey's destructive click is refused (#789). Test mode allows it (§5.1) and the
 * relaxation is noted. Outside MCP the person at the terminal decides. Session-ending and paid controls, and
 * a target's own `safety.deny`, stay refused by the exploration's own policy either way.
 */
export function exploreDestructiveRefusal(decided: RunTarget, asked: boolean, notes: string[]): RunGuardRefusedError | undefined {
  if (!asked || !inMcpInvocation()) return undefined;
  if (decided.mode === "test") {
    const note = "test mode allowed the exploration's destructive controls (allowDestructive), which automation mode refuses over MCP";
    if (!notes.includes(note)) notes.push(note);
    return undefined;
  }
  if (decided.targetConfig?.mcpRun?.allowDestructive === true) return undefined;
  const setting = `targets.json["${decided.origin}"].mcpRun.allowDestructive`;
  const err = new RunGuardRefusedError(
    "E_RUN_REFUSED_DESTRUCTIVE",
    `an MCP exploration asked to click destructive controls on ${decided.origin}, an automation-mode target (trust "${decided.trust}"), and an MCP run refuses that by default; nothing ran. ` +
      `A person allows it with ${setting}: true, or declares the target "trust": "test" in .jevitate/environments.json. This is not a failed run to retry: it is refused the same way until a person changes that setting.`,
    setting,
  );
  noteMcpRefusal(err);
  return err;
}
