import { redactModelPayload } from "@jevitate/ai-core";
import { flatJourneySteps } from "@jevitate/journey";
import { WriteSentinel, type SentinelGateway } from "@jevitate/runtime";
import { writePathShape } from "./journey-run-record.js";
import { hasRunHookOwner, registerRunHooks, type PendingAction, type RunHookContext } from "./journey-run-hooks.js";

/**
 * #794 (design 0.30.0 §6): Jev's write sentinel in SHADOW mode. Before each write step of an automation-mode
 * run it asks Jev two questions and appends the answers to `evidence.judgments` as advisory. It holds
 * nothing: the hook never returns a hold, and `adjudicate` ignores judgments. A test-mode run is left alone.
 *
 * Owner decision: the payload is structure only: the control's role and name (from the stored step), the
 * method, the path shape of the page's URL, and the job's id and title. The hook never reads page text,
 * and redaction stays on as a second layer. The pending request is not yet sent, so the method is `UNKNOWN`.
 */

export const SENTINEL_HOOK_OWNER = "write-sentinel";
export const SENTINEL_WOULD_HOLD_THRESHOLD = 0.8;

export interface SentinelShadowOptions {
  readonly gateway: SentinelGateway;
  /** The job's title, from the catalog (default: its id). */
  readonly jobTitle?: (jobId: string) => string | undefined;
  readonly threshold?: number;
}

export interface SentinelShadow {
  /** Writes whose judgment reached the threshold: what an enforcing sentinel would have held. */
  readonly result: { wouldHaveHeld: number; judged: number };
  unregister(): void;
}

function controlOf(ctx: RunHookContext & PendingAction): { role: string; name: string } {
  const step = flatJourneySteps(ctx.journey)[ctx.step - 1]?.recorded.step as { target?: { role?: string; name?: string; label?: string; text?: string; testId?: string } } | undefined;
  const t = step?.target;
  return { role: t?.role ?? (ctx.kind === "press" ? "key" : "element"), name: (t?.name ?? t?.label ?? t?.text ?? t?.testId ?? "").slice(0, 120) };
}

function pathShapeOf(ctx: RunHookContext & PendingAction): string {
  try {
    const url = new URL(ctx.locator.page().url());
    return writePathShape(url.pathname, Object.values(ctx.params));
  } catch {
    return "/";
  }
}

export function registerSentinelShadowHook(opts: SentinelShadowOptions): SentinelShadow {
  const sentinel = new WriteSentinel(opts.gateway, (t) => redactModelPayload(t));
  const threshold = opts.threshold ?? SENTINEL_WOULD_HOLD_THRESHOLD;
  const result = { wouldHaveHeld: 0, judged: 0 };
  const off = registerRunHooks(SENTINEL_HOOK_OWNER, {
    async beforeWrite(ctx) {
      if (ctx.mode === "test" || ctx.evidence === undefined) return undefined;
      const jobId = ctx.journey.metadata.job ?? ctx.journey.metadata.id;
      const out = await sentinel.judge({
        control: controlOf(ctx),
        method: "UNKNOWN",
        pathShape: pathShapeOf(ctx),
        job: { id: jobId, title: opts.jobTitle?.(jobId) ?? jobId },
      });
      if (out.judgments.length === 0) {
        if (out.note !== undefined) ctx.evidence.note(`write sentinel (step ${ctx.step}): ${out.note}`);
        return undefined;
      }
      result.judged += 1;
      if (out.judgments.some((j) => j.probability >= threshold)) result.wouldHaveHeld += 1;
      ctx.evidence.noteJudgments(out.judgments.map((j) => ({ ...j, step: ctx.step, threshold })));
      // Shadow mode: never a hold.
      return undefined;
    },
  });
  return { result, unregister: off };
}

/** Registers once per owner; returns undefined when already registered. */
export function registerSentinelShadowHookOnce(opts: SentinelShadowOptions): SentinelShadow | undefined {
  return hasRunHookOwner(SENTINEL_HOOK_OWNER) ? undefined : registerSentinelShadowHook(opts);
}
