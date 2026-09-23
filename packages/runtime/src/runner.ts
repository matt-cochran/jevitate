import { access } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserPort } from "@jevitate/playwright";
import type { ActionRegistry } from "@jevitate/site-sdk";
import { CastActor, BrowseTheWeb, PaceInteractions, type Ability } from "@jevitate/screenplay";
import { evaluateGate, resolveThrottle, seedFrom, makeRng, Pacer } from "@jevitate/domain";
import type { SitePolicyRepository, BudgetRepository, ActivityRepository } from "@jevitate/application";

/** True when `path` exists; any error other than "not found" is thrown, never read as absence. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return false;
    throw err;
  }
}

export interface RunRequest {
  site: string;
  account: string;
  actionId: string;
  version: string;
  input: unknown;
  /**
   * Playwright storageState file carrying this account's auth across runs:
   * loaded into the run's fresh browser context when it exists, and written
   * back after the action (success or failure) so a login survives into the
   * next run.
   */
  storageStatePath: string;
  baseUrl: string;
  headless: boolean;
  allowedOrigins: string[];
  traceDir?: string;
  runId: string;
  sleep?: (ms: number) => Promise<void>;
}

export type RunResult =
  | { outcome: "ok"; output: unknown }
  | { outcome: "throttled"; reason: string; retryAfter: string }
  | { outcome: "denied"; reason: string; retryAfter: string };

export interface ActionRunnerOptions {
  policies?: SitePolicyRepository;
  budgets?: BudgetRepository;
  activity?: ActivityRepository;
  maxInlineWaitMs?: number;
  clock?: { nowIso(): string };
}

type ResolvedAction = ReturnType<ActionRegistry["resolve"]>;

const DEFAULT_MAX_INLINE_WAIT_MS = 5000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Midnight UTC of the day after `nowIso`. A simple, safe conservative upper bound
 * for "when might this budget denial have cleared" — see call site in `run()`. */
function nextUtcMidnightAfter(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/** Thrown when a site policy declares a hard limit (min-interval or a budget cap)
 * for an action's throttle class, but the ActionRunner was not constructed with the
 * repository that enforces it. We fail closed: an unenforceable hard limit must never
 * be silently treated as "no limit" and allowed to run. */
export class PolicyEnforcementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyEnforcementError";
  }
}

export class ActionRunner {
  constructor(
    private readonly browser: BrowserPort,
    private readonly registry: ActionRegistry,
    private readonly opts: ActionRunnerOptions = {},
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const action = this.registry.resolve(req.site, req.actionId, req.version);
    const input = action.input.parse(req.input);

    // Fast path: no policies repo configured at all, or the repo has no policy for
    // this site/account. Zero added latency and zero extra repo calls beyond the
    // one `policies.get()` lookup (and none at all if no repo was provided).
    const policy = this.opts.policies ? await this.opts.policies.get(req.site, req.account) : null;
    if (!policy) {
      return this.execute(req, action, input, []);
    }

    const sleep = req.sleep ?? defaultSleep;
    const nowIso = () => (this.opts.clock ? this.opts.clock.nowIso() : new Date().toISOString());

    const resolved = resolveThrottle([policy.throttles?.[action.throttleClass] ?? {}]);

    // Fail closed: a declared, repo-backed hard limit that we cannot enforce must
    // never be silently skipped and treated as "no limit" (see PolicyEnforcementError).
    if (typeof resolved.minIntervalSeconds === "number" && resolved.minIntervalSeconds > 0 && !this.opts.activity) {
      throw new PolicyEnforcementError(
        `Policy for ${req.site}/${req.account} class "${action.throttleClass}" declares a min-interval limit but no ActivityRepository was provided (refusing to run — fail closed).`,
      );
    }
    if ((resolved.hourlyLimit !== undefined || resolved.dailyLimit !== undefined) && !this.opts.budgets) {
      const limitKind = resolved.dailyLimit !== undefined ? "daily limit" : "hourly limit";
      throw new PolicyEnforcementError(
        `Policy for ${req.site}/${req.account} class "${action.throttleClass}" declares a ${limitKind} but no BudgetRepository was provided (refusing to run — fail closed).`,
      );
    }

    const lastAtIso = this.opts.activity
      ? await this.opts.activity.lastAt(req.site, req.account, action.throttleClass)
      : null;

    const decision = evaluateGate({
      nowIso: nowIso(),
      resolved,
      lastAtIso,
      quietHours: policy.quietHours,
      maxInlineWaitMs: this.opts.maxInlineWaitMs ?? DEFAULT_MAX_INLINE_WAIT_MS,
    });

    if (decision.kind === "throttled") {
      return { outcome: "throttled", reason: decision.reason, retryAfter: decision.retryAfter };
    }
    if (decision.kind === "wait") {
      await sleep(decision.ms);
    }

    if (this.opts.budgets) {
      const { allowed } = await this.opts.budgets.reserve(
        req.site,
        req.account,
        action.throttleClass,
        { hourlyLimit: resolved.hourlyLimit, dailyLimit: resolved.dailyLimit },
        nowIso(),
      );
      if (!allowed) {
        // We don't currently know whether the hourly or the daily window caused the
        // denial (that would require expanding BudgetRepository's return contract,
        // out of scope here), so use a simple, safe conservative bound: the start of
        // the next UTC calendar day. By then BOTH the hourly and daily windows will
        // have reset, so this is always correct-by-the-time-it-arrives.
        return { outcome: "denied", reason: "budget", retryAfter: nextUtcMidnightAfter(nowIso()) };
      }
    }

    const seed = seedFrom(req.runId, policy.version);
    const pacer = new Pacer(makeRng(seed));
    const pace = new PaceInteractions(policy.interaction ?? {}, pacer, sleep);
    const result = await this.execute(req, action, input, [pace]);

    if (this.opts.activity) {
      await this.opts.activity.stamp(req.site, req.account, action.throttleClass, nowIso());
    }

    return result;
  }

  /** Shared browser-open/execute/trace-on-error/finally-close logic for both the fast
   * and paced paths. `extraAbilities` is empty on the fast path and `[pace]` on the
   * paced path — this is the only difference between the two. */
  private async execute(
    req: RunRequest,
    action: ResolvedAction,
    input: unknown,
    extraAbilities: Ability[],
  ): Promise<RunResult> {
    const priorState = await pathExists(req.storageStatePath);
    const session = await this.browser.open({
      ...(priorState ? { storageState: req.storageStatePath } : {}),
      headless: req.headless,
      allowedOrigins: req.allowedOrigins,
      baseUrl: req.baseUrl,
    });
    try {
      if (req.traceDir) await session.startTracing();
      const actor = CastActor.named(req.account).whoCan(
        new BrowseTheWeb(session, req.allowedOrigins),
        ...extraAbilities,
      );
      const raw = await action.execute(actor, input);
      const output = action.output.parse(raw);
      await session.saveStorageState(req.storageStatePath);
      return { outcome: "ok", output };
    } catch (err) {
      try {
        await session.saveStorageState(req.storageStatePath);
      } catch {
        /* don't mask the original error */
      }
      if (req.traceDir) {
        try {
          await session.stopTracingToFile(join(req.traceDir, `trace-${req.actionId}.zip`));
        } catch {
          /* don't mask the original error */
        }
      }
      throw err;
    } finally {
      await session.close();
    }
  }
}
