import type { Recording } from "@jevitate/recording";
import type { InvariantViolation } from "./types.js";
// Type-only: `finishDeclaredRun`/`DeclaredRun` only ever name `InvariantMonitor`'s TYPE (to call
// `.flushResponses()`), never a value from it — no runtime dependency on `declared-invariants.ts`.
import type { InvariantMonitor } from "../declared-invariants.js";

/** An invariant violation as a mission finding: deduped by fingerprint, with its reproduction. */
export interface InvariantDefect {
  /** `invariantFingerprint(url, reason, id)` — the declared invariant's id + route. */
  readonly fingerprint: string;
  readonly related: string[];
  readonly kind: "invariant";
  readonly title: string;
  readonly route: string;
  readonly url: string;
  /** The first occurrence's evidence: id, expression, before/after values, action, probe evidence. */
  readonly invariant: InvariantViolation;
  readonly occurrences: number;
  readonly repro: {
    /** Flat index of the Recording step whose action broke the invariant. */
    readonly recordingStepIndex: number;
    /** The finding's own Recording (a coverage/feature path), when the run has no single one. */
    readonly recording?: Recording;
  };
}

/** Collects violations into deduped `InvariantDefect`s (same fingerprint ⇒ one more occurrence). */
export class InvariantDefectLog {
  readonly #defects = new Map<string, { d: InvariantDefect; occurrences: number }>();

  add(v: InvariantViolation, repro: InvariantDefect["repro"]): void {
    const known = this.#defects.get(v.fingerprint);
    if (known !== undefined) {
      known.occurrences += 1;
      return;
    }
    this.#defects.set(v.fingerprint, {
      occurrences: 1,
      d: {
        fingerprint: v.fingerprint,
        related: [v.fingerprint],
        kind: "invariant",
        title: `Invariant "${v.id}" violated on ${v.route}`,
        route: v.route,
        url: v.url,
        invariant: v,
        occurrences: 1,
        repro,
      },
    });
  }

  get size(): number {
    return this.#defects.size;
  }

  defects(): InvariantDefect[] {
    return [...this.#defects.values()].map(({ d, occurrences }) => ({ ...d, occurrences }));
  }
}

/**
 * #195 — a mission's declared invariants: the monitor, its defect log, and the repro of the LAST
 * checked action (what an end-of-run finding reproduces). Shared by every frontier mission.
 */
export interface DeclaredRun {
  readonly monitor: InvariantMonitor;
  readonly log: InvariantDefectLog;
  lastRepro: InvariantDefect["repro"] | null;
}

/**
 * #195 — the one end-of-run path for a mission's declared invariants: flushes `never.response` hits
 * that landed after the last action's check into the log, attributed to that action. Never throws.
 */
export async function finishDeclaredRun(d: Pick<DeclaredRun, "monitor" | "log" | "lastRepro">): Promise<void> {
  const r = await d.monitor.flushResponses().catch(() => null);
  for (const v of r?.violations ?? []) d.log.add(v, d.lastRepro ?? { recordingStepIndex: 0 });
}

/** Flat step count of a Recording (the next step's index). */
export function recordingStepCount(recording: Recording): number {
  return recording.pages.reduce((n, p) => n + p.steps.length, 0);
}
