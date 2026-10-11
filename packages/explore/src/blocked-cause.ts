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

function pathOf(urlOrPath: string): string {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath.split(/[?#]/)[0] ?? urlOrPath;
  }
}

/** Whether one signal is what a refused write looks like from the page (never a server or layout fault). */
function signalFromBlocked(s: DefectSignal, root: BlockedRoot): boolean {
  const path = pathOf(root.path);
  if (s.kind === "failed-request") return pathOf(s.url) === path;
  if (s.kind === "console-error" || s.kind === "page-error") return BLOCKED_FETCH_ERROR.test(s.detail) || (path !== "/" && s.detail.includes(path));
  return false;
}

/**
 * The blocked write `candidate` is a consequence of, or undefined. The latest write blocked at or
 * before the candidate's step in the SAME session qualifies when every defect signal is the page
 * reporting a request that never left (its fetch error, its failed request) — or, for a hang, a busy
 * indicator stuck with nothing in flight (`ui-no-progress`, no pending request: it waits on a request
 * the guard refused). Anything else — a 5xx, a layout fault, a stuck request that WAS sent — stays the app's.
 */
export function blockedCauseOf(roots: readonly BlockedRoot[], candidate: ConsequenceCandidate): CausedBy | undefined {
  let root: BlockedRoot | undefined;
  for (const r of roots) if (r.session === candidate.session && r.step <= candidate.step && (root === undefined || r.step >= root.step)) root = r;
  if (root === undefined) return undefined;
  if ("hang" in candidate) {
    const h = candidate.hang;
    if (h.kind !== "ui-no-progress" || h.pending.length > 0) return undefined;
    return {
      step: root.step,
      write: writeOf(root),
      why: `busy indicator${h.element === undefined ? "" : ` ${h.element}`} never cleared with nothing in flight: the write it waited on was blocked at step ${root.step} and never sent`,
    };
  }
  const r = root;
  if (candidate.signals.length === 0 || !candidate.signals.every((s) => signalFromBlocked(s, r))) return undefined;
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
