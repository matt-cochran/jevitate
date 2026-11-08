import { flatJourneySteps, FsJourneyStore, type ApprovalChannel, type Journey } from "@jevitate/journey";
import { inMcpInvocation, noteMcpRefusal } from "./approval-provenance.js";
import { environmentsFilePath, loadEnvironmentsFile, type EnvironmentDef, type ResolvedJourneyEnvironment } from "./environments.js";
import { EXIT_CODES } from "./exit-codes.js";
import { hasRunHookOwner, registerRunHooks, RunHookError, type RunHookContext } from "./journey-run-hooks.js";
import { resolveTargetTrust, runModeFor, stricterTrust, type RunMode, type TargetTrust } from "./run-mode.js";
import { canonicalOrigin, loadTargetsFile, type TargetConfig } from "./target-config.js";

/**
 * 0.30.0 Contract 4 (docs/design/0.30.0-evidence-and-trust.md §5): the run mode, wired into every run
 * that goes through `runJourneyProgrammatically` (CLI `journey run`, MCP `run_journey`, and in process
 * `chain_journeys`, `verify_journey`, `journey_readiness`). `registerRunModeHooks()` adds a `resolveMode`
 * run hook that, before any fixture or browser:
 *
 *  - resolves the target's trust from human-written configuration only (the named environment's
 *    `trust`/`production` in `.jevitate/environments.json`, the origin's `trust` in
 *    `~/.jevitate/targets.json`, any environment that calls the origin production) and writes
 *    `run.mode` and `run.target.trust` into the evidence. Nothing a caller passes chooses it; a target
 *    nothing declares is `unknown`, which is automation mode;
 *  - in test mode, refuses a Journey with a human step (a `handback`) with `E_HUMAN_STEP_IN_TEST_MODE`:
 *    a test-mode run never waits for a person;
 *  - in automation mode over MCP, refuses a Journey whose approval a person did not make
 *    (`provenance.channel` other than `tty` or `pr-review`) with `E_APPROVAL_CHANNEL_FOR_MODE`
 *    (owner decision 5: an MCP promotion authorises test-mode runs only).
 *
 * A refusal is never retried, carries no parameter value, and names the setting a person changes.
 */

export const RUN_MODE_HOOK_OWNER = "run-mode";

export const E_APPROVAL_CHANNEL_FOR_MODE = "E_APPROVAL_CHANNEL_FOR_MODE" as const;
export const E_HUMAN_STEP_IN_TEST_MODE = "E_HUMAN_STEP_IN_TEST_MODE" as const;
/** §5.3 (journey-secret-mode.ts): a secret the operator bound to another origin than the run's. */
export const E_SECRET_ORIGIN_REFUSED = "E_SECRET_ORIGIN_REFUSED" as const;
/** §5.3 (journey-secret-mode.ts): `--secret-mode` asked for a mode this run's target cannot give. */
export const E_SECRET_MODE_UNAVAILABLE = "E_SECRET_MODE_UNAVAILABLE" as const;
export type RunModeRefusalCode = typeof E_APPROVAL_CHANNEL_FOR_MODE | typeof E_HUMAN_STEP_IN_TEST_MODE | typeof E_SECRET_ORIGIN_REFUSED | typeof E_SECRET_MODE_UNAVAILABLE;

/** The approval channels that authorise an automation-mode run: a person made them. */
export const AUTOMATION_APPROVAL_CHANNELS: readonly ApprovalChannel[] = Object.freeze(["tty", "pr-review"]);

const DO_NOT_RETRY = "This is not a failed run to retry: it is refused the same way until a person changes that.";

/** The run mode refused the run. A subclass of `RunHookError` so the hook runner rethrows it as is. */
export class RunModeRefusedError extends RunHookError {
  constructor(
    /** The refusal's code (also `code` at run time; the type of `code` is `RunHookError`'s). */
    readonly refusalCode: RunModeRefusalCode,
    message: string,
    /** What a person changes to lift it. */
    readonly setting: string,
    readonly mode: RunMode,
    readonly trust: TargetTrust,
  ) {
    super(RUN_MODE_HOOK_OWNER, "resolveMode", new Error(message));
    Object.defineProperty(this, "name", { value: "RunModeRefusedError", enumerable: false });
    Object.defineProperty(this, "code", { value: refusalCode, enumerable: true, writable: false });
    this.message = message;
  }
}

/** The MCP error body of a run-mode refusal: `outcome: refused`, never a pass, never to be retried. */
export function runModeRefusalBody(err: RunModeRefusedError): Record<string, unknown> {
  return { error: "refused", outcome: "refused", code: err.refusalCode, setting: err.setting, mode: err.mode, trust: err.trust, message: err.message, retryable: false, exitCode: EXIT_CODES.inconclusive };
}

export interface RunTargetRequest {
  /** The origin the run goes to (the environment's `baseUrl`, else the recorded site). */
  readonly origin: string;
  readonly environment?: ResolvedJourneyEnvironment | undefined;
  /** `.jevitate/environments.json` (default: the named environment's own file, else the project's). */
  readonly environmentsFile?: string | null | undefined;
  /** `~/.jevitate/targets.json` (default). */
  readonly targetsFile?: string | undefined;
}

export interface RunTarget {
  readonly origin: string;
  readonly trust: TargetTrust;
  readonly mode: RunMode;
  /** The operator's `targets.json` entry for the origin, if any (its `secretFields`, `mcpRun`). */
  readonly targetConfig?: TargetConfig;
}

/** The file a named environment was read from (`resolveJourneyEnvironment` records `<file>[<name>]`). */
function environmentFileOf(env: ResolvedJourneyEnvironment | undefined): string | undefined {
  if (env?.name === undefined) return undefined;
  const suffix = `[${env.name}]`;
  return env.source.endsWith(suffix) ? env.source.slice(0, -suffix.length) : undefined;
}

function targetEntry(targets: Readonly<Record<string, TargetConfig>>, origin: string): TargetConfig | undefined {
  return Object.entries(targets).find(([key]) => canonicalOrigin(key) === origin)?.[1];
}

function ownOrigins(def: EnvironmentDef): (string | undefined)[] {
  return [def.baseUrl, ...Object.values(def.origins ?? {})].map((o) => canonicalOrigin(o));
}

/**
 * The trust and mode of the target a run goes to. Reads only human-written files. A file that cannot
 * be read could hold a stricter declaration, so the trust is then at least `unknown` (automation mode);
 * the #789 guard refuses an MCP run on a config it cannot read on its own.
 */
export function resolveRunTarget(req: RunTargetRequest): RunTarget {
  const origin = canonicalOrigin(req.origin) ?? req.origin;
  let targetConfig: TargetConfig | undefined;
  /** A file that cannot be read may hold a stricter declaration: the run is never looser than `unknown` then. */
  let unreadable = false;
  try {
    targetConfig = targetEntry(req.targetsFile === undefined ? loadTargetsFile() : loadTargetsFile(req.targetsFile), origin);
  } catch {
    targetConfig = undefined;
    unreadable = true;
  }
  let envs: Readonly<Record<string, EnvironmentDef>> = {};
  try {
    const file = environmentFileOf(req.environment) ?? (req.environmentsFile === undefined ? environmentsFilePath() : req.environmentsFile);
    envs = file === null || file === undefined ? {} : loadEnvironmentsFile(file);
  } catch {
    envs = {};
    unreadable = true;
  }
  const named = req.environment?.name === undefined ? undefined : envs[req.environment.name];
  let trust = resolveTargetTrust({
    origin,
    ...(named === undefined ? {} : { environment: named }),
    ...(targetConfig === undefined ? {} : { targetConfig }),
  });
  if (unreadable) trust = stricterTrust(trust, "unknown");
  // The resolved environment says production even when its file could not be re-read.
  if (req.environment?.production === true) trust = stricterTrust(trust, "production");
  // Any environment that calls this origin production holds it, named or not: a declaration only tightens here.
  for (const def of Object.values(envs)) {
    if ((def.production === true || def.trust === "production") && ownOrigins(def).includes(origin)) trust = stricterTrust(trust, "production");
  }
  return { origin, trust, mode: runModeFor(trust), ...(targetConfig === undefined ? {} : { targetConfig }) };
}

/** The channel a Journey's approval was made over, if recorded. */
export function approvalChannelOf(journey: Journey): ApprovalChannel | undefined {
  return journey.metadata.approval?.provenance?.channel;
}

/** Owner decision 5: an automation-mode run needs an approval a person made (`tty` or `pr-review`). */
export function approvalAuthorisesAutomation(journey: Journey): boolean {
  const channel = approvalChannelOf(journey);
  return channel !== undefined && AUTOMATION_APPROVAL_CHANNELS.includes(channel);
}

/** The 1-based index of the first step that waits for a person, if any. */
export function firstHumanStep(journey: Journey): number | undefined {
  const at = flatJourneySteps(journey).findIndex(({ recorded: { step } }) => step.kind === "handback");
  return at === -1 ? undefined : at + 1;
}

/**
 * The refusal the run mode makes of this run, if any. PURE apart from what it is given. `mcp`: the run
 * is part of an MCP tool call (the approval-channel rule applies there only; a CLI run warns instead).
 */
export function runModeRefusal(journey: Journey, target: RunTarget, opts: { readonly mcp: boolean }): RunModeRefusedError | undefined {
  const id = journey.metadata.id;
  if (target.mode === "test") {
    const at = firstHumanStep(journey);
    if (at === undefined) return undefined;
    return new RunModeRefusedError(
      E_HUMAN_STEP_IN_TEST_MODE,
      `${E_HUMAN_STEP_IN_TEST_MODE}: journey '${id}' has a human step (a handback, step ${at}), and ${target.origin} is a test-mode target (trust "${target.trust}"), where a run never waits for a person; nothing ran. ` +
        `Run it on an automation-mode target, or take the handback out of the Journey. ${DO_NOT_RETRY}`,
      `journey '${id}' step ${at}`,
      target.mode,
      target.trust,
    );
  }
  if (!opts.mcp || approvalAuthorisesAutomation(journey)) return undefined;
  const channel = approvalChannelOf(journey);
  const made = channel === undefined ? "has no recorded approval channel" : `was approved over channel "${channel}"`;
  return new RunModeRefusedError(
    E_APPROVAL_CHANNEL_FOR_MODE,
    `${E_APPROVAL_CHANNEL_FOR_MODE}: journey '${id}' ${made}, and ${target.origin} is an automation-mode target (trust "${target.trust}"), which runs only a Journey a person approved (channel tty or pr-review); nothing ran. ` +
      `An approval over MCP authorises test-mode runs only. A person approves it at a terminal: jevitate journey promote ${id}. Or a person declares the target "trust": "test" in .jevitate/environments.json. ${DO_NOT_RETRY}`,
    `jevitate journey promote ${id}`,
    target.mode,
    target.trust,
  );
}

/** The target's trust for a run's hook context (`unknown` when the run does not say where it goes). For the hold record. */
export function trustOfRunContext(ctx: RunHookContext): TargetTrust {
  return ctx.target === undefined ? "unknown" : resolveRunTarget({ origin: ctx.target.origin, environment: ctx.target.environment, targetsFile: ctx.target.targetsFile }).trust;
}

/** The `resolveMode` hook: decides the mode from the target, notes it, and refuses what the mode forbids. */
function resolveModeHook(ctx: RunHookContext): RunMode | undefined {
  if (ctx.target === undefined) return undefined;
  const target = resolveRunTarget({ origin: ctx.target.origin, environment: ctx.target.environment, targetsFile: ctx.target.targetsFile });
  ctx.evidence?.noteTrust(target.trust);
  // The refusal is recorded too, so its run reports `run.mode` (the runner notes it only after the hook returns).
  ctx.evidence?.noteMode(target.mode);
  const mcp = inMcpInvocation();
  const refusal = runModeRefusal(ctx.journey, target, { mcp });
  if (refusal !== undefined) {
    if (mcp) noteMcpRefusal(refusal);
    throw refusal;
  }
  return target.mode;
}

/** Registers the run-mode hook; returns the unregistration. The central registrar calls it once. */
export function registerRunModeHooks(): () => void {
  return registerRunHooks(RUN_MODE_HOOK_OWNER, { resolveMode: resolveModeHook });
}

/** Whether the run-mode hook is registered (the central registrar registers it once). */
export function runModeHooksRegistered(): boolean {
  return hasRunHookOwner(RUN_MODE_HOOK_OWNER);
}

/**
 * §5.7: the one stderr line a CLI `journey run` adds for a draft (an unpromoted Journey) on an
 * automation-mode target. Undefined for a promoted Journey, a test-mode target or an unknown id.
 */
export async function draftOnAutomationTargetWarning(req: { readonly journeysDir: string; readonly id: string; readonly environment?: ResolvedJourneyEnvironment | undefined; readonly targetsFile?: string | undefined }): Promise<string | undefined> {
  let journey: Journey | null;
  try {
    journey = await new FsJourneyStore(req.journeysDir).get(req.id);
  } catch {
    return undefined;
  }
  if (journey === null || journey.metadata.promoted === true) return undefined;
  const target = resolveRunTarget({ origin: req.environment?.baseUrl ?? journey.recording.site, environment: req.environment, targetsFile: req.targetsFile });
  if (target.mode !== "automation") return undefined;
  return `warning: journey '${req.id}' is a draft, running on ${target.origin}, an automation-mode target (trust "${target.trust}"); a target a person can reset is declared "trust": "test" in .jevitate/environments.json\n`;
}
