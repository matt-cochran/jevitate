import { ReplayRefusal, type ReplayActionGuard } from "@jevitate/interpreter";
import type { Journey } from "@jevitate/journey";
import type { RunEvidence } from "@jevitate/adjudicator";
import type { JourneyRunResult } from "@jevitate/runtime";
import type { Locator, Page } from "playwright";
import type { EvidenceChannel, JourneyRunEvidenceWriter } from "./journey-run-evidence.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";

/**
 * 0.30.0 (docs/design/0.30.0-evidence-and-trust.md §3–§5): the points in `runJourneyProgrammatically`
 * where later modules attach run mode, the job done check, typed parameters and holds, without each one
 * editing the run. A module calls `registerRunHooks(owner, hooks)` once, at import; every run then calls
 * the hooks of each point in registration order. With nothing registered a run is unchanged.
 *
 * A hook that throws fails the run with a `RunHookError` (`E_RUN_HOOK`, never retried); it is never
 * swallowed the way a `StepObserver`'s error is. The error names the owner and the point, and carries
 * the hook's own error as `cause`; the run's usual redaction still applies to its message.
 */

export type RunMode = RunEvidence["run"]["mode"];

/** What every hook is told about the run. `params` are the run's own (secret ones included): never to be stored or sent. */
export interface RunHookContext {
  /** The stored Journey, as read before any environment or prefix. */
  readonly journey: Journey;
  readonly params: Readonly<Record<string, string>>;
  /** Absent for a run no surface started (a proof's replay, `journey annotate`). */
  readonly channel: EvidenceChannel | undefined;
  /** The mode `resolveMode` decided; absent before it ran, or when no hook decided one. */
  readonly mode: RunMode | undefined;
  /** The run's evidence writer, when the run writes evidence. */
  readonly evidence: JourneyRunEvidenceWriter | undefined;
  /** Where the run goes: the origin, the named environment (if any) and the operator's targets file seam. Absent for a caller that does not say. */
  readonly target?: RunHookTarget;
}

/** The target a run goes to, as `runJourneyProgrammatically` resolved it (§5: what the run mode is decided from). */
export interface RunHookTarget {
  /** The origin the replay runs on (the environment's `baseUrl`, else the recorded site). */
  readonly origin: string;
  readonly environment?: ResolvedJourneyEnvironment | undefined;
  /** `targets.json` (default: `~/.jevitate/targets.json`). */
  readonly targetsFile?: string | undefined;
}

/** The action a step is about to take: a click or a key press, which may send a write. */
export interface PendingAction {
  /** 1-based, as `StepEvidence.index`. */
  readonly step: number;
  /** The recorded step kind. */
  readonly kind: string;
  readonly locator: Locator;
  readonly key?: string;
}

/** A `beforeWrite` hook's answer that the run must stop and wait for a person (§5.4). */
export interface RunHoldRequest {
  readonly kind: "approval" | "handback" | "secret";
  /** Code-templated, never page text or a value. */
  readonly reason: string;
}

export interface RunHooks {
  /** Before the parameters are checked. The first hook to answer decides the mode; it lands in the evidence. */
  resolveMode?(ctx: RunHookContext): RunMode | undefined | Promise<RunMode | undefined>;
  /** After the Journey's own parameter schema accepted the parameters, before any fixture or browser. Throws to refuse. */
  validateParams?(ctx: RunHookContext): void | Promise<void>;
  /** Right before a click or key press acts. Returns a hold to stop the run there (`onHold` hooks are told first). */
  beforeWrite?(ctx: RunHookContext & PendingAction): RunHoldRequest | undefined | void | Promise<RunHoldRequest | undefined | void>;
  /** A `beforeWrite` hook asked for a hold: persist it. The run then ends with `RunHeldError`. */
  onHold?(ctx: RunHookContext & PendingAction & { readonly hold: RunHoldRequest }): void | Promise<void>;
  /** The replay finished (its end state judged) and the page is still open: read the job's done check into the evidence. */
  readDoneCheck?(ctx: RunHookContext & { readonly page: Page; readonly result: JourneyRunResult }): void | Promise<void>;
}

export type RunHookPoint = keyof RunHooks;

/** A run hook threw: the run fails, typed, and is not retried. */
export class RunHookError extends ReplayRefusal {
  override readonly name = "RunHookError";
  readonly code = "E_RUN_HOOK" as const;
  readonly retryable = false;
  constructor(
    readonly owner: string,
    readonly point: RunHookPoint,
    cause: unknown,
  ) {
    super(`run hook ${owner}.${point} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** A `beforeWrite` hook held the run at a step: it stops there, for a person to answer. */
export class RunHeldError extends ReplayRefusal {
  override readonly name = "RunHeldError";
  readonly code = "E_RUN_HELD" as const;
  readonly retryable = false;
  constructor(
    readonly owner: string,
    readonly hold: RunHoldRequest,
    readonly extra: { readonly at: number },
  ) {
    super(`the run is held at step ${extra.at} (${hold.kind}): ${hold.reason}`);
  }
}

interface Registered {
  readonly owner: string;
  readonly hooks: RunHooks;
}

let registered: readonly Registered[] = [];

/** Registers one module's hooks; they run after every earlier registration's. Returns the unregistration. */
export function registerRunHooks(owner: string, hooks: RunHooks): () => void {
  const entry: Registered = { owner, hooks };
  registered = [...registered, entry];
  return () => {
    registered = registered.filter((r) => r !== entry);
  };
}

/** Whether `owner` has a registration (so a central registrar can register once). */
export function hasRunHookOwner(owner: string): boolean {
  return registered.some((r) => r.owner === owner);
}

/** Test-only: forget every registration. */
export function resetRunHooksForTests(): void {
  registered = [];
}

/** Whether any registration has a hook at `point`. */
export function hasRunHooks(point: RunHookPoint): boolean {
  return registered.some((r) => r.hooks[point] !== undefined);
}

async function each<P extends RunHookPoint>(point: P, call: (hook: NonNullable<RunHooks[P]>, owner: string) => unknown): Promise<void> {
  // A snapshot: a hook that registers or unregisters mid-run changes the next run, not this one.
  for (const r of registered) {
    const hook = r.hooks[point];
    if (hook === undefined) continue;
    try {
      await call(hook as NonNullable<RunHooks[P]>, r.owner);
    } catch (err) {
      if (err instanceof RunHookError || err instanceof RunHeldError) throw err;
      throw new RunHookError(r.owner, point, err);
    }
  }
}

/** Runs every `resolveMode` hook; the first answer wins. */
export async function resolveRunMode(ctx: RunHookContext): Promise<RunMode | undefined> {
  let mode: RunMode | undefined;
  await each("resolveMode", async (hook) => {
    const answer = await hook(ctx);
    mode ??= answer;
  });
  return mode;
}

export function runValidateParamsHooks(ctx: RunHookContext): Promise<void> {
  return each("validateParams", (hook) => hook(ctx));
}

export function runReadDoneCheckHooks(ctx: RunHookContext & { readonly page: Page; readonly result: JourneyRunResult }): Promise<void> {
  return each("readDoneCheck", (hook) => hook(ctx));
}

/** Runs every `beforeWrite` hook; the first hold stops the rest, tells every `onHold` hook, and ends the run. */
export async function runBeforeWriteHooks(ctx: RunHookContext & PendingAction): Promise<void> {
  let held: { readonly owner: string; readonly hold: RunHoldRequest } | undefined;
  await each("beforeWrite", async (hook, owner) => {
    if (held !== undefined) return;
    const answer = await hook(ctx);
    if (answer !== undefined && answer !== null) held = { owner, hold: answer };
  });
  if (held === undefined) return;
  await holdRunAt(held.owner, ctx, held.hold);
}

/**
 * Holds the run at `ctx.step` for `owner`: tells every `onHold` hook (which make it durable), then ends
 * the run with `RunHeldError`. For a step that waits for a person without a write (a handback, §5.3).
 */
export async function holdRunAt(owner: string, ctx: RunHookContext & PendingAction, hold: RunHoldRequest): Promise<never> {
  await each("onHold", (hook) => hook({ ...ctx, hold }));
  throw new RunHeldError(owner, hold, { at: ctx.step });
}

/**
 * The replay's action guard: `inner` (the #789 MCP run guard) first, as the refusal floor, then the
 * `beforeWrite` hooks. With no `beforeWrite` hook registered this is `inner` itself, so a run is unchanged.
 */
export function withRunHookGuard(inner: ReplayActionGuard | undefined, ctx: () => RunHookContext): ReplayActionGuard | undefined {
  if (!hasRunHooks("beforeWrite")) return inner;
  return {
    beforeAction: async (a) => {
      await inner?.beforeAction(a);
      await runBeforeWriteHooks({ ...ctx(), step: a.index + 1, kind: a.recorded.step.kind, locator: a.locator, ...(a.key === undefined ? {} : { key: a.key }) });
    },
    noteExtracted: (value) => inner?.noteExtracted?.(value),
    afterStep: (a) => inner?.afterStep(a),
  };
}
