import { HostHealthSampler, degradedEnvironmentOutcome, hostStarvedFailure } from "@jevitate/explore";
import type { EnvironmentDegraded, HostHealthSummary, MissionFailure } from "@jevitate/domain";
import { sharedResourceGovernor, type ResourceGovernor } from "@jevitate/playwright";
import { clock } from "@jevitate/domain";

/** When each run's sampler started (#205: the window the governor's summary covers). */
const runStarts = new WeakMap<HostHealthSampler, number>();

/**
 * One host-health sampler per mission run (#203), shared by every strategy's runner: started (with
 * one sample taken) BEFORE the browser opens, fed every transcript entry, handed to the mission so a
 * hang/no-progress met on a starved host is marked `environment-degraded`, and summarised into the
 * result's `hostHealth`. `injected` is the test seam (a deterministic fake host).
 */
export async function startHostHealth(injected?: HostHealthSampler): Promise<HostHealthSampler> {
  const health = (injected ?? new HostHealthSampler()).start();
  runStarts.set(health, clock.now());
  await health.sample();
  return health;
}

/** The browser handle a run's CDP probe needs (structurally a Playwright `Page`). */
interface CdpPage {
  context(): { browser(): { newBrowserCDPSession(): Promise<{ send(method: string): Promise<unknown> }> } | null };
}

/**
 * #452: gives the run's sampler its CDP probe — the round-trip of a cheap browser-level command
 * (`Browser.getVersion`, answered by the browser process itself, so it measures the browser being
 * scheduled, not the page's JS). Measured in REAL time (`process.hrtime`): it is a latency of the real
 * pipe, so a skipped test clock must not inflate it. A browser that cannot give a CDP session simply
 * contributes no reading.
 */
export function attachCdpProbe(health: HostHealthSampler, page: CdpPage): void {
  let session: Promise<{ send(method: string): Promise<unknown> } | undefined> | undefined;
  health.attachCdpProbe(async () => {
    const browser = page.context().browser();
    if (browser == null) return undefined;
    session ??= browser.newBrowserCDPSession().catch(() => undefined);
    const s = await session;
    if (s === undefined) return undefined;
    const t0 = process.hrtime.bigint();
    await s.send("Browser.getVersion");
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });
}

/** The failure to report: a `host-starved` verdict (#452) explains the stall before the engine's own failure does. */
export function failureWithHostStarved<F extends { kind: string }>(host: { readonly failure?: F | undefined }, own: F | undefined): F | undefined {
  return host.failure !== undefined && host.failure.kind === "host-starved" ? host.failure : own;
}

/** What every result carries from the sampler, and the degraded-environment verdict rule applied. */
export interface HostHealthVerdict<O extends string> {
  readonly outcome: O | "inconclusive";
  /** Set when the rule turned the outcome `inconclusive` (reason `degraded-environment`). */
  readonly failure?: MissionFailure;
  readonly fields: { readonly hostHealth: HostHealthSummary; readonly environmentDegraded: EnvironmentDegraded[] };
}

/**
 * Takes the closing sample and applies the run-level rule: most steps starved → `inconclusive`
 * (`degraded-environment`), never `clean` (see `degradedEnvironmentOutcome`).
 */
export async function finishHostHealth<O extends string>(
  health: HostHealthSampler,
  outcome: O,
  opts: Parameters<typeof degradedEnvironmentOutcome>[2] & {
    /** #452: the run's own engine failure, so a stall on a starved host is classified `host-starved`. */
    readonly failure?: { readonly kind: string; readonly message: string };
  } = {},
  governor: ResourceGovernor = sharedResourceGovernor(),
): Promise<HostHealthVerdict<O>> {
  await health.sample();
  // #205: what resource governance did during this run (cap, slot, throttling, memory) rides along.
  const hostHealth: HostHealthSummary = { ...health.summary(), resources: governor.snapshot(runStarts.get(health) ?? 0) };
  // #452: a run that STALLED while the host showed starvation is `inconclusive` / `host-starved`, with the
  // measurements; a confirmed finding (defects-found, a hang) keeps its outcome.
  const starved = hostStarvedFailure(opts.failure, hostHealth);
  if (starved !== undefined) {
    const keeps = outcome === "defects-found" || outcome === "hang" || outcome === "intermittent";
    return {
      outcome: keeps ? outcome : "inconclusive",
      failure: starved,
      fields: { hostHealth, environmentDegraded: health.findings() },
    };
  }
  const verdict = degradedEnvironmentOutcome(outcome, hostHealth, opts);
  return {
    outcome: verdict.outcome,
    ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
    fields: { hostHealth, environmentDegraded: health.findings() },
  };
}
