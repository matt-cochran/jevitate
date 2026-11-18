import type { Recording } from "@jevitate/recording";
import type { ActivityRepository, BudgetRepository, SitePolicyRepository } from "@jevitate/application";
import { Pacer, evaluateGate, makeRng, resolveThrottle, seedFrom, clock, timePhase, type SitePolicy, type ThrottlePolicy } from "@jevitate/domain";
import { PaceInteractions } from "@jevitate/screenplay";
import { flattenRecording, isWriteStep } from "./self-heal.js";

/**
 * The site-policy gate for a Journey run (recovered from the removed ActionRunner, see docs/design/approach.md).
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

/** #854: the account key site-wide throttles and budgets are kept under (never a real account name). */
export const SITE_WIDE_ACCOUNT = "*";

type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: SiteGateRefusal; readonly retryAfter: string };

/**
 * One throttle scope (an account, or the whole site): quiet hours, then the min interval, claimed
 * ATOMICALLY (#854) so two concurrent runs that read the same old `lastAt` cannot both pass it, then
 * the hourly/daily budget (already a conditional, transactional reserve).
 */
async function admit(
  deps: SiteGateDeps,
  req: SiteGateRequest,
  account: string,
  throttle: ThrottlePolicy | undefined,
  quietHours: SitePolicy["quietHours"],
  nowIso: () => string,
  sleep: (ms: number) => Promise<void>,
): Promise<Admission> {
  const resolved = resolveThrottle([throttle ?? {}]);
  const maxInlineWaitMs = deps.maxInlineWaitMs ?? DEFAULT_MAX_INLINE_WAIT_MS;
  // A lost claim means another run started in between: re-read and decide again (once is enough to
  // turn the race into the ordinary wait-or-refuse decision; a second loss refuses).
  for (let attempt = 0; ; attempt++) {
    const lastAtIso = await deps.activity.lastAt(req.site, account, req.throttleClass);
    const decision = evaluateGate({ nowIso: nowIso(), resolved, lastAtIso, ...(quietHours === undefined ? {} : { quietHours }), maxInlineWaitMs });
    if (decision.kind === "throttled") return { ok: false, reason: decision.reason, retryAfter: decision.retryAfter };
    if (decision.kind === "wait") await sleep(decision.ms);
    if (resolved.minIntervalSeconds === undefined) break;
    const now = nowIso();
    const notBefore = new Date(Date.parse(now) - resolved.minIntervalSeconds * 1000).toISOString();
    if (await deps.activity.claim(req.site, account, req.throttleClass, now, notBefore)) break;
    if (attempt >= 1) {
      const latest = (await deps.activity.lastAt(req.site, account, req.throttleClass)) ?? now;
      return { ok: false, reason: "min_interval", retryAfter: new Date(Date.parse(latest) + resolved.minIntervalSeconds * 1000).toISOString() };
    }
  }
  const { allowed } = await deps.budgets.reserve(
    req.site,
    account,
    req.throttleClass,
    {
      ...(resolved.hourlyLimit === undefined ? {} : { hourlyLimit: resolved.hourlyLimit }),
      ...(resolved.dailyLimit === undefined ? {} : { dailyLimit: resolved.dailyLimit }),
    },
    nowIso(),
  );
  if (!allowed) return { ok: false, reason: "budget", retryAfter: nextUtcMidnightAfter(nowIso()) };
  return { ok: true };
}

export async function enterSiteGate(deps: SiteGateDeps, req: SiteGateRequest): Promise<SiteGateResult> {
  const policy = await deps.policies.get(req.site, req.account);
  if (policy === null) return OPEN;
  const nowIso = deps.nowIso ?? (() => clock.nowIso());
  const sleep = deps.sleep ?? ((ms: number) => clock.sleep(ms));
  const siteWide = policy.siteThrottles?.[req.throttleClass];

  if (req.enforceLimits) {
    const own = await admit(deps, req, req.account, policy.throttles?.[req.throttleClass], policy.quietHours, nowIso, sleep);
    if (!own.ok) return own;
    // #854: the site-wide scope, shared by every account on the site.
    if (siteWide !== undefined) {
      const shared = await admit(deps, req, SITE_WIDE_ACCOUNT, siteWide, undefined, nowIso, sleep);
      if (!shared.ok) return shared;
    }
  }

  // #852: a human-like pause the policy asks for is charged to `stepPace`.
  const pacedSleep = (ms: number): Promise<void> => timePhase("stepPace", () => sleep(ms));
  const pace = policy.interaction === undefined ? null : new PaceInteractions(policy.interaction, new Pacer(makeRng(seedFrom(req.runId, policy.version))), pacedSleep);
  return {
    ok: true,
    pace,
    done: req.enforceLimits
      ? async () => {
          await deps.activity.stamp(req.site, req.account, req.throttleClass, nowIso());
          if (siteWide !== undefined) await deps.activity.stamp(req.site, SITE_WIDE_ACCOUNT, req.throttleClass, nowIso());
        }
      : async () => undefined,
  };
}
