import type { Recording } from "@jevitate/recording";
import type { Control } from "../snapshot.js";
import type { FrontierOp } from "./fingerprint.js";

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

/** A dedup'd FIFO queue of not-yet-tried (state, action) pairs. */
export class Frontier {
  private readonly queue: FrontierItem[] = [];
  private readonly seen = new Set<string>();

  push(item: FrontierItem): void {
    if (this.seen.has(item.key)) return;
    this.seen.add(item.key);
    this.queue.push(item);
  }

  /**
   * Prefers an item reachable without a reset+replay (its `fromFingerprint`
   * matches where the browser already is), so the loop keeps DFS-ing forward
   * when it can; otherwise the oldest queued item (FIFO).
   */
  popPreferring(preferFingerprint: string | undefined): FrontierItem | undefined {
    if (preferFingerprint !== undefined) {
      const i = this.queue.findIndex((it) => it.fromFingerprint === preferFingerprint);
      if (i !== -1) return this.queue.splice(i, 1)[0];
    }
    return this.queue.shift();
  }

  isExhausted(): boolean {
    return this.queue.length === 0;
  }

  get size(): number {
    return this.queue.length;
  }
}
