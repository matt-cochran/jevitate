import type { Recording } from "@jevitate/recording";
import type { ActivityRepository, BudgetRepository, SitePolicyRepository } from "@jevitate/application";
import { Pacer, evaluateGate, makeRng, resolveThrottle, seedFrom } from "@jevitate/domain";
import { PaceInteractions } from "@jevitate/screenplay";
import { flattenRecording, isWriteStep } from "./self-heal.js";

/**
 * The site-policy gate for a Journey run (recovered from the removed ActionRunner, see approach.md).
 * An operator's `jevitate site policy set <origin>` declares, per site and account:
 *
 *  - `interaction` — human-like pacing (think time, typing speed, reading time) applied to every
 *    click and keystroke through the actor's `PaceInteractions` ability;
 *  - `throttles.<class>` — `minIntervalSeconds`, `hourlyLimit`, `dailyLimit` per throttle class
 *    (`read` for a Journey with no write step, `write` otherwise);
 *  - `quietHours` — windows (in a timezone) during which no run may start.
 *
 * Code decides, before any browser opens: a run inside quiet hours, too soon after the last one,
 * or over its hourly/daily budget is refused with the reason and when to retry. A short min-interval
 * shortfall (up to `maxInlineWaitMs`) is waited out instead. With no policy for the site, nothing
 * changes.
 */

export type ThrottleClass = "read" | "write";

export interface SiteGateDeps {
  readonly policies: SitePolicyRepository;
  readonly budgets: BudgetRepository;
  readonly activity: ActivityRepository;
  readonly nowIso?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The longest min-interval shortfall waited out inline instead of refused (default 5s). */
  readonly maxInlineWaitMs?: number;
}

export interface SiteGateRequest {
  /** The site id: the Journey's origin (`https://app.example.com`). */
  readonly site: string;
  readonly account: string;
  readonly throttleClass: ThrottleClass;
  /** Seeds the pacing RNG, so a run's pacing is reproducible from its id. */
  readonly runId: string;
  /**
   * False for a load test: only pacing applies. A load run is the operator's deliberate burst, so
   * throttles, budgets and quiet hours (which exist to keep ordinary runs polite) do not refuse it.
   */
  readonly enforceLimits: boolean;
}

export type SiteGateRefusal = "quiet_hours" | "min_interval" | "budget";

export type SiteGateResult =
  | {
      readonly ok: true;
      /** The pacing ability to give the run's actor, or null when the policy declares no pacing. */
      readonly pace: PaceInteractions | null;
      /** Record the run against the throttle class (call once the run has executed, pass or fail). */
      readonly done: () => Promise<void>;
    }
  | { readonly ok: false; readonly reason: SiteGateRefusal; readonly retryAfter: string };

export class SiteGateRefusedError extends Error {
  readonly code = "E_SITE_THROTTLED" as const;
  constructor(
    readonly site: string,
    readonly reason: SiteGateRefusal,
    readonly retryAfter: string,
  ) {
    super(`refused by the site policy for ${site}: ${describeRefusal(reason)}; retry after ${retryAfter}`);
    this.name = "SiteGateRefusedError";
  }
}

function describeRefusal(reason: SiteGateRefusal): string {
  return reason === "quiet_hours" ? "inside its quiet hours" : reason === "min_interval" ? "too soon after the last run (min interval)" : "its hourly/daily run budget is spent";
}

const DEFAULT_MAX_INLINE_WAIT_MS = 5_000;

/** `write` when any step of the Journey writes (a click, a fill, a submit), else `read`. */
export function throttleClassOf(recording: Recording): ThrottleClass {
  return flattenRecording(recording).some((e) => isWriteStep(e.step)) ? "write" : "read";
}

/** Midnight UTC after `nowIso`: by then both the hourly and the daily windows have reset. */
function nextUtcMidnightAfter(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

const OPEN: SiteGateResult = { ok: true, pace: null, done: async () => undefined };

export async function enterSiteGate(deps: SiteGateDeps, req: SiteGateRequest): Promise<SiteGateResult> {
  const policy = await deps.policies.get(req.site, req.account);
  if (policy === null) return OPEN;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (req.enforceLimits) {
    const resolved = resolveThrottle([policy.throttles?.[req.throttleClass] ?? {}]);
    const lastAtIso = await deps.activity.lastAt(req.site, req.account, req.throttleClass);
    const decision = evaluateGate({
      nowIso: nowIso(),
      resolved,
      lastAtIso,
      ...(policy.quietHours === undefined ? {} : { quietHours: policy.quietHours }),
      maxInlineWaitMs: deps.maxInlineWaitMs ?? DEFAULT_MAX_INLINE_WAIT_MS,
    });
    if (decision.kind === "throttled") return { ok: false, reason: decision.reason, retryAfter: decision.retryAfter };
    if (decision.kind === "wait") await sleep(decision.ms);
    const { allowed } = await deps.budgets.reserve(
      req.site,
      req.account,
      req.throttleClass,
      {
        ...(resolved.hourlyLimit === undefined ? {} : { hourlyLimit: resolved.hourlyLimit }),
        ...(resolved.dailyLimit === undefined ? {} : { dailyLimit: resolved.dailyLimit }),
      },
      nowIso(),
    );
    if (!allowed) return { ok: false, reason: "budget", retryAfter: nextUtcMidnightAfter(nowIso()) };
  }

  const pace = policy.interaction === undefined ? null : new PaceInteractions(policy.interaction, new Pacer(makeRng(seedFrom(req.runId, policy.version))), sleep);
  return {
    ok: true,
    pace,
    done: req.enforceLimits ? () => deps.activity.stamp(req.site, req.account, req.throttleClass, nowIso()) : async () => undefined,
  };
}
