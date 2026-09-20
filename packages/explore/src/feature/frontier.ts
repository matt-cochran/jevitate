import type { Recording } from "@jevitate/recording";
import type { Control } from "../snapshot.js";
import type { FrontierOp } from "./fingerprint.js";

/**
 * Local (feature-mission) copy of ticket #3's Frontier — a deduped work queue
 * of "from this state, do this op on this control" items, each carrying the
 * replayable `Recording` prefix that reaches its source state (so the mission
 * can reset-and-replay back to it). See the plan's "Known duplication" note.
 */
export interface FrontierItem {
  readonly key: string;
  readonly fromFingerprint: string;
  /** A self-contained, replayable Recording that reaches `fromFingerprint`. */
  readonly pathPrefix: Recording;
  readonly control: Control;
  readonly op: FrontierOp;
}

export class Frontier {
  private readonly queue: FrontierItem[] = [];
  private readonly seen = new Set<string>();

  push(item: FrontierItem): void {
    if (this.seen.has(item.key)) return;
    this.seen.add(item.key);
    this.queue.push(item);
  }

  /**
   * Pop an item, preferring one whose source state is the one we're already
   * standing on (no replay needed). Falls back to FIFO otherwise.
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
