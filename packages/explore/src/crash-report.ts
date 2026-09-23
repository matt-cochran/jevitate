import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import {
  attributeCrash,
  looksLikeRendererOom,
  type AttributionResult,
  type CrashEvidence,
  type HeapSample,
  type MissionFailure,
} from "@jevitate/domain";
import type { CrashSignals } from "./mission-failure.js";
import type { HostPressure } from "./host-pressure.js";

/**
 * Crash evidence for owner ruling 3: every crash records the error + stack, the page/browser
 * crash signals, and the page's JS heap across steps, and is ATTRIBUTED from that evidence by the
 * pure `attributeCrash` rule (domain).
 *
 * The heap is read portably from the page (`performance.memory`, exposed by Chromium on every OS);
 * a CDP `Performance.getMetrics` read is an optional enrichment used only when the page API is not
 * there. A page that cannot answer within the bound (a hung main thread) simply yields no sample.
 */

/** Reads the page's JS heap, or null when it cannot be read within `timeoutMs`. */
export async function sampleHeap(page: Page, timeoutMs = 2_000): Promise<Omit<HeapSample, "step"> | null> {
  const read = async (): Promise<Omit<HeapSample, "step"> | null> => {
    const fromPage = await page.evaluate(() => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      return mem === undefined ? null : { usedBytes: mem.usedJSHeapSize, limitBytes: mem.jsHeapSizeLimit };
    });
    if (fromPage !== null) return fromPage;
    // Optional enrichment (Chromium only): CDP Performance.getMetrics.
    try {
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Performance.enable");
        const { metrics } = await cdp.send("Performance.getMetrics");
        const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value;
        return used === undefined ? null : { usedBytes: used };
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch {
      return null;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([read().catch(() => null), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Collects one heap sample per step (skipping steps where the heap could not be read). */
export class HeapLog {
  readonly #samples: HeapSample[] = [];

  async sample(page: Page, step: number): Promise<void> {
    const s = await sampleHeap(page);
    if (s !== null) this.#samples.push({ step, ...s });
  }

  samples(): HeapSample[] {
    return [...this.#samples];
  }
}

/**
 * Where jevitate's own code lives at runtime: the directory two levels above this module — the
 * workspace `packages/` dir in a checkout, or the `@jevitate/` scope dir of an installed CLI bundle
 * (`…/@jevitate/cli/dist/bin.js`). A stack frame under it (and not under a `node_modules` beneath
 * it) is jevitate code for attribution.
 */
export function jevitateCodeRoots(): string[] {
  return [fileURLToPath(new URL("../../", import.meta.url))];
}

export interface CrashReport {
  readonly failure: MissionFailure;
  readonly evidence: CrashEvidence;
  readonly attribution: AttributionResult;
  /** The host's resource pressure sampled when the crash was detected. */
  readonly host?: HostPressure;
}

/**
 * A navigation that timed out (`page.goto: Timeout 30000ms exceeded`, `navigating to …`) is the
 * app not loading within its bound — hang evidence about the system under test, even though the
 * exception surfaced through jevitate's own call stack.
 */
export function isNavigationTimeout(failure: MissionFailure): boolean {
  const text = `${failure.message}\n${failure.stack ?? ""}`;
  return /Timeout \d+ms exceeded/i.test(text) && /\b(?:page\.goto|navigating to|waitForNavigation|waitForURL)\b/i.test(text);
}

/** Assembles the evidence for a crashed run and attributes it. */
export function buildCrashReport(
  failure: MissionFailure,
  signals: CrashSignals,
  heapSamples: readonly HeapSample[],
  opts: {
    readonly hang?: boolean;
    readonly hangKind?: string;
    readonly ownCodeRoots?: readonly string[];
    /** The host's resource pressure at detection time (see `hostProbe`). */
    readonly host?: HostPressure;
  } = {},
): CrashReport {
  const navigationTimeout = isNavigationTimeout(failure);
  const evidence: CrashEvidence = {
    ...(failure.stack === undefined ? {} : { stack: failure.stack }),
    pageCrashed: signals.pageCrashed,
    browserDisconnected: signals.browserDisconnected,
    rendererOom: looksLikeRendererOom(signals.pageCrashed, heapSamples),
    heapSamples: [...heapSamples],
    hang: opts.hang ?? navigationTimeout,
    ...(opts.hangKind === undefined ? {} : { hangKind: opts.hangKind }),
    ...(navigationTimeout ? { navigationTimeout: true } : {}),
    ...(opts.host?.overThreshold ? { hostUnderPressure: opts.host.overThreshold } : {}),
  };
  return {
    failure,
    evidence,
    attribution: attributeCrash(evidence, opts.ownCodeRoots ?? jevitateCodeRoots()),
    ...(opts.host === undefined ? {} : { host: opts.host }),
  };
}
