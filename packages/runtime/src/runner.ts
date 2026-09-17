import { join } from "node:path";
import type { BrowserPort } from "@doit/playwright";
import type { ActionRegistry } from "@doit/site-sdk";
import { CastActor, BrowseTheWeb, PaceInteractions, type Ability } from "@doit/screenplay";
import { evaluateGate, resolveThrottle, seedFrom, makeRng, Pacer } from "@doit/domain";
import type { SitePolicyRepository, BudgetRepository, ActivityRepository } from "@doit/application";

export interface RunRequest {
  site: string;
  account: string;
  actionId: string;
  version: string;
  input: unknown;
  profileDir: string;
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
        // No dedicated "next budget window" computation at M2.5; `nowIso()` is an
        // acceptable minimal placeholder for retryAfter on a budget denial (unlike
        // quiet-hours/min-interval, which have a well-defined next-open instant).
        return { outcome: "denied", reason: "budget", retryAfter: nowIso() };
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
    const session = await this.browser.open({
      profileDir: req.profileDir,
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
      return { outcome: "ok", output: action.output.parse(raw) };
    } catch (err) {
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
