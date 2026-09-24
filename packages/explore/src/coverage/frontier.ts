import type { Recording } from "@jevitate/recording";
import type { Control } from "../snapshot.js";
import { controlIdentity, type FrontierOp } from "./fingerprint.js";

export interface FrontierItem {
  /** Unique `(state, op, control)` key — the dedup identity (see `actionKey`). */
  readonly key: string;
  /** Fingerprint of the state this action must be performed FROM. */
  readonly fromFingerprint: string;
  /** A replayable path (from the seed) back to `fromFingerprint`'s state. */
  readonly pathPrefix: Recording;
  readonly control: Control;
  readonly op: FrontierOp;
}

/**
 * A dedup'd FIFO queue of not-yet-tried (state, action) pairs.
 *
 * Two run-wide refinements on top of plain FIFO (#75 — the skip-link/global-nav budget drain):
 *
 *  - `blacklist` — a control identity (role+name) that failed with a timeout (or was refused as
 *    not actionable) is never enqueued or popped again, however many new states re-offer it. A
 *    visually-hidden skip link or any other control that cannot be acted on gets ONE attempt for
 *    the whole run, not one per state that re-discovers it.
 *  - exercised preference — among items reachable without a reset, and failing that among all
 *    queued items, one whose control identity has NEVER been successfully acted on yet is popped
 *    before one that has. A global nav link present on every page is exercised once early and then
 *    stops competing with genuinely unvisited in-page controls for the rest of the run's budget.
 */
export class Frontier {
  private readonly queue: FrontierItem[] = [];
  private readonly seen = new Set<string>();
  private readonly blacklisted = new Set<string>();
  private readonly exercised = new Set<string>();

  push(item: FrontierItem): void {
    if (this.seen.has(item.key)) return;
    if (this.blacklisted.has(controlIdentity(item.control))) return;
    this.seen.add(item.key);
    this.queue.push(item);
  }

  /** Never enqueue or pop this control identity again for the rest of the run. */
  blacklist(identity: string): void {
    this.blacklisted.add(identity);
  }

  /** Marks a control identity as successfully acted on — queued/future items for it are deprioritized. */
  markExercised(identity: string): void {
    this.exercised.add(identity);
  }

  /**
   * Prefers, in order: (1) reachable without a reset+replay (its `fromFingerprint` matches where
   * the browser already is) AND not-yet-exercised, (2) reachable without a reset, (3) not-yet-
   * exercised (oldest), (4) the oldest queued item overall.
   */
  popPreferring(preferFingerprint: string | undefined): FrontierItem | undefined {
    const notExercised = (it: FrontierItem): boolean => !this.exercised.has(controlIdentity(it.control));
    if (preferFingerprint !== undefined) {
      let i = this.queue.findIndex((it) => it.fromFingerprint === preferFingerprint && notExercised(it));
      if (i === -1) i = this.queue.findIndex((it) => it.fromFingerprint === preferFingerprint);
      if (i !== -1) return this.queue.splice(i, 1)[0];
    }
    const j = this.queue.findIndex(notExercised);
    if (j !== -1) return this.queue.splice(j, 1)[0];
    return this.queue.shift();
  }

  isExhausted(): boolean {
    return this.queue.length === 0;
  }

  get size(): number {
    return this.queue.length;
  }
}
