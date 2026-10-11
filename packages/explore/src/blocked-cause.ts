import type { DefectSignal } from "./adversarial/defect-oracle.js";
import type { AllowOriginMismatch } from "./allow-origin-mismatch.js";
import type { HangSignal } from "./hang.js";

/**
 * #484: a write jevitate's guard refused to send (not an `--allow` origin) is never the app's defect —
 * and neither is what it set off later in the same session: the page's own "Failed to fetch" error a
 * step later, or a busy indicator that never clears because the upload never went out. Such a
 * finding carries a `causedBy` link to the blocked write (the ROOT event) and is reported under
 * Environment faults, grouped beneath it — never as a defect, never gating the run.
 */

/** #403: how a browser reports a fetch/XHR that was aborted before it left (Chromium, Firefox, WebKit). */
export const BLOCKED_FETCH_ERROR = /Failed to fetch|NetworkError when attempting to fetch|Load failed|ERR_BLOCKED_BY_CLIENT/i;

/** A blocked write, where it happened: the run's transcript step and its browser session (reset epoch). */
export interface BlockedRoot {
  readonly step: number;
  readonly session: number;
  readonly method: string;
  /** Origin + path for an off-allowlist write (`BlockedWrite.path`). */
  readonly path: string;
  readonly allowMismatch?: AllowOriginMismatch;
  /**
   * The busy indicator (`visibleBusyIndicator`'s description) that was NOT showing before the
   * blocked write's action and was showing once it settled — the only indicator a later
   * `ui-no-progress` hang may be linked to this write by.
   */
  readonly busyStarted?: string;
}

/** The link a consequence carries to the blocked write that caused it. */
export interface CausedBy {
  /** The transcript step the write was blocked at. */
  readonly step: number;
  /** `METHOD origin/path` of the blocked write. */
  readonly write: string;
  /** Why the finding is attributed to it. */
  readonly why: string;
}

/** A finding moved out of the defects because a blocked write caused it. */
export interface BlockedConsequence {
  readonly fingerprint: string;
  /** The finding's kind (`console-error`, `failed-request`, `page-error`, `hang:ui-no-progress`, …). */
  readonly kind: string;
  readonly title: string;
  readonly route: string;
  readonly firstSeenStep: number;
  readonly occurrenceSteps: number[];
  readonly causedBy: CausedBy;
}

/** What is being attributed: a defect's signals or a hang, seen at `step` in `session`. */
export type ConsequenceCandidate =
  | { readonly session: number; readonly step: number; readonly signals: readonly DefectSignal[] }
  | { readonly session: number; readonly step: number; readonly hang: HangSignal };

export function writeOf(root: Pick<BlockedRoot, "method" | "path">): string {
  return `${root.method} ${root.path}`;
}

/**
 * How many transcript steps after the blocked one a consequence may land on. 1: the page's reaction
 * to a refused write surfaces while its own step settles (same step) or is drained late into the one
 * after it (`drainLate`; a hang check records its own step right after the action). Anything later
 * is no longer attributable to that action — it stays the app's.
 */
export const BLOCKED_CONSEQUENCE_STEPS = 1;

/** `origin + pathname` of an absolute http(s) URL, else null (a bare path never links). */
function originPath(url: string): { readonly origin: string; readonly full: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { origin: u.origin, full: `${u.origin}${u.pathname}` };
  } catch {
    return null;
  }
}

/**
 * Whether one signal is the page reporting THIS refused write: a failed request with its exact
 * method + origin + path, or a console/page error that names the blocked URL or origin. A generic
 * "Failed to fetch" names neither — it could be any request — so it never links.
 */
function signalFromBlocked(s: DefectSignal, root: BlockedRoot): boolean {
  const blocked = originPath(root.path);
  if (blocked === null) return false;
  if (s.kind === "failed-request") {
    const got = originPath(s.url);
    return got !== null && s.method !== undefined && s.method.toUpperCase() === root.method.toUpperCase() && got.full === blocked.full;
  }
  if (s.kind === "console-error" || s.kind === "page-error") return s.detail.includes(blocked.full) || s.detail.includes(blocked.origin);
  return false;
}

/**
 * The blocked write `candidate` is a consequence of, or undefined. Only a write blocked in the SAME
 * session, at the candidate's step or up to `BLOCKED_CONSEQUENCE_STEPS` before it, qualifies — and
 * only when every defect signal names that write (`signalFromBlocked`), or, for a hang, the stuck busy
 * indicator is the one that APPEARED in that write's own action window (`busyStarted`) with nothing
 * in flight. When unsure the finding stays the app's: a false defect beats a hidden bug.
 */
export function blockedCauseOf(roots: readonly BlockedRoot[], candidate: ConsequenceCandidate): CausedBy | undefined {
  const inWindow = roots.filter(
    (r) => r.session === candidate.session && r.step <= candidate.step && candidate.step - r.step <= BLOCKED_CONSEQUENCE_STEPS,
  );
  // Latest first: the nearest action wins.
  inWindow.sort((a, b) => b.step - a.step);
  if ("hang" in candidate) {
    const h = candidate.hang;
    if (h.kind !== "ui-no-progress" || h.pending.length > 0 || h.element === undefined) return undefined;
    const root = inWindow.find((r) => r.busyStarted === h.element);
    if (root === undefined) return undefined;
    return {
      step: root.step,
      write: writeOf(root),
      why: `busy indicator ${h.element} appeared with the write blocked at step ${root.step} and never cleared with nothing in flight: that write was never sent`,
    };
  }
  if (candidate.signals.length === 0) return undefined;
  const root = inWindow.find((r) => candidate.signals.every((s) => signalFromBlocked(s, r)));
  if (root === undefined) return undefined;
  return { step: root.step, write: writeOf(root), why: `the page reporting the write blocked at step ${root.step}, which was never sent` };
}

/** A result's `environmentFaults.causes[]` entry: a classified backend-log line or a blocked write (#422, #484). */
export interface EnvironmentFaultCause {
  readonly ruleId: string;
  readonly source: string;
  readonly message: string;
  readonly count: number;
  /** #484: the findings this cause set off (`causedBy` it) — never defects. */
  readonly consequences?: readonly BlockedConsequence[];
}

/** One environment cause per blocked write (`environmentFaults.causes[]`), its consequences grouped beneath it. */
export interface BlockedWriteCause extends EnvironmentFaultCause {
  readonly ruleId: "jevitate:blocked-write";
  readonly source: "jevitate --allow guard";
  readonly message: string;
  readonly count: number;
  /** The findings this blocked write caused (`causedBy` → this cause), when any. */
  readonly consequences?: readonly BlockedConsequence[];
}

/** The environment causes for a run's blocked writes, each with the consequences that link to it. */
export function blockedWriteCauses(roots: readonly BlockedRoot[], consequences: readonly BlockedConsequence[]): BlockedWriteCause[] {
  const byWrite = new Map<string, { root: BlockedRoot; count: number }>();
  for (const r of roots) {
    const known = byWrite.get(writeOf(r));
    if (known === undefined) byWrite.set(writeOf(r), { root: r, count: 1 });
    else known.count += 1;
  }
  return [...byWrite.entries()].map(([write, { root, count }]) => {
    const own = consequences.filter((c) => c.causedBy.write === write);
    return {
      ruleId: "jevitate:blocked-write" as const,
      source: "jevitate --allow guard" as const,
      message: `${write}: not an --allow origin, never sent${root.allowMismatch === undefined ? "" : ` — WARNING: ${root.allowMismatch.message}`}`,
      count,
      ...(own.length === 0 ? {} : { consequences: own }),
    };
  });
}
