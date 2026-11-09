import { AsyncLocalStorage } from "node:async_hooks";
import {
  envCredentialStore,
  JevJudgmentGateway,
  jevProviderOverride,
  realJevClientCall,
  redactModelPayload,
  resolveJevRoute,
  RetryingJudgmentPort,
  UsageTracker,
  type CredentialKey,
  type JevClientCall,
  type JudgmentPort,
  type UsagePricing,
  type UsageSink,
} from "@jevitate/ai-core";
import { flatJourneySteps } from "@jevitate/journey";
import { WriteSentinel, type SentinelGateway } from "@jevitate/runtime";
import { resolveCatalogDir } from "./catalog-api.js";
import { CatalogLoader } from "./catalog.js";
import { loadLocalCredentials } from "./credentials-file.js";
import { writePathShape } from "./journey-run-record.js";
import { resolveUsagePricing } from "./usage-config.js";
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
/** GAPS 17 (x-sentinel-measure): at 0.5 on max(destructive, outside-intent), P 0.93-1.00 and 0 clean false stops. */
export const SENTINEL_WOULD_HOLD_THRESHOLD = 0.5;
/** The explicit opt-in for the real gateway: only the value `shadow` turns it on (0.30.0 has no enforcing mode). */
export const WRITE_SENTINEL_ENV = "JEVITATE_WRITE_SENTINEL";

export interface SentinelShadowOptions {
  readonly gateway: SentinelGateway;
  /** The job's title, from the catalog (default: the shadow gateway's own lookup, else the job's id). */
  readonly jobTitle?: (jobId: string) => string | undefined | Promise<string | undefined>;
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
  const shadowGateway = opts.gateway as Partial<SentinelShadowGateway>;
  const titleOf = async (jobId: string): Promise<string | undefined> => {
    try {
      return await (opts.jobTitle ?? shadowGateway.jobTitle)?.(jobId);
    } catch {
      return undefined;
    }
  };
  const result = { wouldHaveHeld: 0, judged: 0 };
  const off = registerRunHooks(SENTINEL_HOOK_OWNER, {
    async beforeWrite(ctx) {
      if (ctx.mode === "test" || ctx.evidence === undefined) return undefined;
      const jobId = ctx.journey.metadata.job ?? ctx.journey.metadata.id;
      const title = (await titleOf(jobId)) ?? jobId;
      const judge = () => sentinel.judge({ control: controlOf(ctx), method: "UNKNOWN", pathShape: pathShapeOf(ctx), job: { id: jobId, title } });
      // GAPS 17: the Jev calls this write's judgment made, recorded into the run's evidence (shadow gateway only).
      const withUsage = shadowGateway.withUsage;
      const writeUsage = withUsage === undefined ? undefined : new UsageTracker(shadowGateway.pricing ?? {});
      const out = withUsage === undefined || writeUsage === undefined ? await judge() : await withUsage(writeUsage, judge);
      if (writeUsage !== undefined && writeUsage.calls().length > 0) ctx.evidence.note(`write sentinel (step ${ctx.step}): ${usageNote(writeUsage)}`);
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

// ── GAPS 17: the real gateway, opt-in, shadow only ────────────────────────────────────────────────

function usageNote(u: UsageTracker): string {
  const s = u.snapshot();
  const n = s.judgments;
  const cost = s.totalUsd === undefined ? "unpriced" : `$${s.totalUsd.toFixed(7)}`;
  return `${n} Jev call${n === 1 ? "" : "s"}, ${s.inputTokens} input tokens, ${cost} (priced ${s.priced})`;
}

/** A `SentinelGateway` that also carries the run-side pieces the hook reads: job titles and usage. */
export interface SentinelShadowGateway extends SentinelGateway {
  /** Every Jev call the sentinel made in this process (all runs). */
  readonly usage: UsageTracker;
  /** The pricing the per-write trackers use (the same as `usage`'s). */
  readonly pricing: UsagePricing;
  /** The job's title from the project catalog (its `motivation`), when the catalog names the job. */
  jobTitle(jobId: string): Promise<string | undefined>;
  /** Runs `fn` with `sink` also receiving every call `fn` makes (one write's usage, for its run). */
  withUsage<T>(sink: UsageSink, fn: () => Promise<T>): Promise<T>;
}

export interface SentinelShadowGatewayDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The local credentials file (read only). A test seam. */
  readonly loadCredentials?: () => Partial<Record<CredentialKey, string>>;
  /** Builds the Jev client call, recording into `usage` (default: `realJevClientCall`). A test seam. */
  readonly clientCall?: (usage: UsageSink) => Promise<JevClientCall>;
  /** The catalog seam (`CliDeps.catalogDir`); default: the project's `.jevitate/`, resolved at lookup. */
  readonly catalogDir?: string | undefined;
}

/**
 * GAPS 17: the write sentinel's real Jev gateway, or undefined (nothing registered, no note written) unless
 * `JEVITATE_WRITE_SENTINEL=shadow` is set AND a Jev route resolves. Lazy: `registerRunSurfaceHooks` is
 * synchronous and `realJevClientCall` is async, so the port is built on the first write and memoized. A
 * failed build or call degrades to `jev-unavailable` (WriteSentinel never throws); the run is unaffected.
 * Advisory only: the hook records "would hold" and never holds a write in 0.30.0.
 */
export function sentinelShadowGateway(deps: SentinelShadowGatewayDeps = {}): SentinelShadowGateway | undefined {
  const env = deps.env ?? process.env;
  if (env[WRITE_SENTINEL_ENV]?.trim() !== "shadow") return undefined;
  let store: ReturnType<typeof envCredentialStore>;
  let provider: ReturnType<typeof jevProviderOverride>;
  try {
    store = envCredentialStore({ ...env }, (deps.loadCredentials ?? loadLocalCredentials)());
    provider = jevProviderOverride({ ...env });
    resolveJevRoute(store, provider);
  } catch {
    return undefined;
  }
  let pricing: UsagePricing;
  try {
    pricing = resolveUsagePricing(env);
  } catch {
    pricing = {};
  }
  const usage = new UsageTracker(pricing);
  const scope = new AsyncLocalStorage<UsageSink>();
  const sink: UsageSink = {
    recordJudgment(u) {
      usage.recordJudgment(u);
      scope.getStore()?.recordJudgment(u);
    },
    recordGeneration(u) {
      usage.recordGeneration(u);
      scope.getStore()?.recordGeneration(u);
    },
  };
  const build = deps.clientCall ?? ((u: UsageSink) => realJevClientCall(undefined, u));
  let port: Promise<JudgmentPort> | undefined;
  const portOf = (): Promise<JudgmentPort> => (port ??= build(sink).then((call) => new RetryingJudgmentPort(new JevJudgmentGateway(store, call, provider))));
  return {
    usage,
    pricing,
    async systemOne(args) {
      return (await portOf()).systemOne(args);
    },
    async jobTitle(jobId) {
      const catalogDir = resolveCatalogDir(deps.catalogDir);
      if (catalogDir === null) return undefined;
      const { jobs } = await new CatalogLoader({ catalogDir, journeysDir: catalogDir }).loadJobs();
      return jobs.find((j) => j.id === jobId)?.job.motivation;
    },
    withUsage: (s, fn) => scope.run(s, fn),
  };
}
