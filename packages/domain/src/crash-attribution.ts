/**
 * Who a crash belongs to, decided from EVIDENCE by one pure rule (owner ruling 3):
 *
 *  - `system-under-test` — the page or browser crashed, the renderer ran out of memory, the page's
 *    JS heap grew without bound across steps, or the app hung. These are the app's behaviour, even
 *    when the exception that surfaced them was thrown from jevitate code.
 *  - `jevitate`          — an exception whose stack has a frame inside jevitate's own code, and NO
 *    page or browser crash signal: the engine broke on a healthy page.
 *  - `uncertain`         — anything else (no own frame, no crash signal). Filed to BOTH sides.
 *
 * One exception to "a hang is the app's": when the HOST was over a resource threshold at detection
 * time, a main-thread-unresponsive hang or a navigation timeout is `uncertain` — a starved host
 * makes any page slow, so that evidence no longer points at the app. (A renderer crash, an OOM or
 * unbounded heap growth still does.)
 */

export type Attribution = "jevitate" | "system-under-test" | "uncertain";

export interface HeapSample {
  /** The transcript step the sample was taken at. */
  readonly step: number;
  /** The page's used JS heap (bytes). */
  readonly usedBytes: number;
  /** The page's JS heap limit (bytes), when the browser exposes it. */
  readonly limitBytes?: number;
}

export interface CrashEvidence {
  readonly stack?: string;
  readonly pageCrashed: boolean;
  readonly browserDisconnected: boolean;
  /** The renderer died out of memory (a crash with the heap at/near its limit). */
  readonly rendererOom: boolean;
  readonly heapSamples: readonly HeapSample[];
  /** The app under test hung (never settled / unresponsive / request stuck / no progress). */
  readonly hang: boolean;
  /** The hang's kind, when it was a hang (`main-thread-unresponsive`, `request-pending`, …). */
  readonly hangKind?: string;
  /** The failure was a navigation that timed out (the page did not load within its bound). */
  readonly navigationTimeout?: boolean;
  /** The host resource threshold that was exceeded at detection time, described; absent when within. */
  readonly hostUnderPressure?: string;
}

export interface AttributionResult {
  readonly attribution: Attribution;
  /** The evidence the decision rests on, in plain words (goes into the issue draft). */
  readonly reasons: string[];
}

export interface HeapGrowthRule {
  /** Minimum consecutive samples that must all grow. Default 4. */
  readonly minSamples: number;
  /** Minimum last/first ratio across that growing run. Default 2 (the heap at least doubled). */
  readonly minGrowthRatio: number;
}

export const DEFAULT_HEAP_GROWTH_RULE: HeapGrowthRule = { minSamples: 4, minGrowthRatio: 2 };

/**
 * "Unbounded heap growth across steps": the trailing `minSamples` samples are strictly increasing
 * and the last is at least `minGrowthRatio` × the first of them. A heap that plateaus, dips (a GC)
 * or grows modestly is not unbounded.
 */
export function isUnboundedHeapGrowth(
  samples: readonly HeapSample[],
  rule: HeapGrowthRule = DEFAULT_HEAP_GROWTH_RULE,
): boolean {
  if (samples.length < rule.minSamples) return false;
  const tail = samples.slice(-rule.minSamples);
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1];
    const cur = tail[i];
    if (prev === undefined || cur === undefined || cur.usedBytes <= prev.usedBytes) return false;
  }
  const first = tail[0];
  const last = tail[tail.length - 1];
  if (first === undefined || last === undefined || first.usedBytes <= 0) return false;
  return last.usedBytes / first.usedBytes >= rule.minGrowthRatio;
}

/** A renderer crash with the heap at ≥90% of its limit is an out-of-memory crash. */
export function looksLikeRendererOom(pageCrashed: boolean, samples: readonly HeapSample[]): boolean {
  if (!pageCrashed) return false;
  const last = samples[samples.length - 1];
  return last?.limitBytes !== undefined && last.limitBytes > 0 && last.usedBytes / last.limitBytes >= 0.9;
}

/** Normalizes a stack frame location or a code root to a comparable `/`-separated path. */
function normalizePath(p: string): string {
  return p.replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/^\/([A-Za-z]:\/)/, "$1");
}

/**
 * True when a stack has at least one frame inside jevitate's own code: under one of `ownCodeRoots`
 * and NOT inside a dependency (`node_modules`) installed beneath that root.
 */
export function hasOwnFrame(stack: string | undefined, ownCodeRoots: readonly string[]): boolean {
  if (stack === undefined || ownCodeRoots.length === 0) return false;
  const roots = ownCodeRoots.map((r) => normalizePath(r).replace(/\/+$/, "") + "/");
  for (const rawLine of stack.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("at ")) continue;
    const loc = normalizePath(line.replace(/^at\s+(?:.*?\()?/, "").replace(/\)?$/, ""));
    for (const root of roots) {
      const at = loc.indexOf(root);
      if (at === -1) continue;
      if (!loc.slice(at + root.length).includes("node_modules/")) return true;
    }
  }
  return false;
}

export function attributeCrash(
  evidence: CrashEvidence,
  ownCodeRoots: readonly string[],
  heapRule: HeapGrowthRule = DEFAULT_HEAP_GROWTH_RULE,
): AttributionResult {
  const hardAppSignal =
    evidence.pageCrashed ||
    evidence.browserDisconnected ||
    evidence.rendererOom ||
    isUnboundedHeapGrowth(evidence.heapSamples, heapRule);
  const pressureSensitive = evidence.hangKind === "main-thread-unresponsive" || evidence.navigationTimeout === true;
  if (evidence.hostUnderPressure !== undefined && pressureSensitive && !hardAppSignal) {
    return {
      attribution: "uncertain",
      reasons: [
        `host under resource pressure (${evidence.hostUnderPressure})`,
        evidence.navigationTimeout === true
          ? "a navigation timeout on a starved host does not show the app is at fault"
          : "an unresponsive main thread on a starved host does not show the app is at fault",
      ],
    };
  }
  const sut: string[] = [];
  if (evidence.pageCrashed) sut.push("the page (renderer) crashed");
  if (evidence.browserDisconnected) sut.push("the browser disconnected");
  if (evidence.rendererOom) sut.push("the renderer ran out of memory");
  if (isUnboundedHeapGrowth(evidence.heapSamples, heapRule)) sut.push("the page's JS heap grew without bound across steps");
  if (evidence.hang) sut.push("the app under test hung");
  if (sut.length > 0) return { attribution: "system-under-test", reasons: sut };
  if (hasOwnFrame(evidence.stack, ownCodeRoots)) {
    return {
      attribution: "jevitate",
      reasons: ["the exception has a stack frame inside jevitate code", "no page or browser crash signal"],
    };
  }
  return {
    attribution: "uncertain",
    reasons: ["no page/browser crash signal and no stack frame inside jevitate code"],
  };
}
