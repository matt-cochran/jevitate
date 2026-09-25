import type { Recording } from "@jevitate/recording";
import type { Control } from "../snapshot.js";
import { controlIdentity, type FrontierOp } from "./fingerprint.js";

/**
 * Verb pairs at the START of a control's accessible name that mark it as one direction of a
 * TOGGLE whose other direction relabels the SAME control (Collapse/Expand, Show/Hide, Open/Close…)
 * — #160. Matched against either verb; the group key is role + whatever the name says once the
 * verb is stripped, so "Collapse signal minimap" and "Expand signal minimap" resolve to the same
 * group even though their accessible names (and so their `controlIdentity`) differ.
 */
const TOGGLE_VERB_PAIRS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^collapse\b/i, /^expand\b/i],
  [/^show\b/i, /^hide\b/i],
  [/^open\b/i, /^close\b/i],
  [/^enable\b/i, /^disable\b/i],
  [/^minimi[sz]e\b/i, /^maximi[sz]e\b/i],
  [/^mute\b/i, /^unmute\b/i],
  [/^lock\b/i, /^unlock\b/i],
  [/^pause\b/i, /^(?:resume|play)\b/i],
];

/** The toggle group a control's name pairs it into, or null when it matches no known verb. */
function toggleGroupOf(c: Pick<Control, "role" | "name">): string | null {
  const name = c.name.trim();
  for (const [a, b] of TOGGLE_VERB_PAIRS) {
    if (a.test(name)) return `${c.role}\u0001${name.replace(a, "").trim()}`;
    if (b.test(name)) return `${c.role}\u0001${name.replace(b, "").trim()}`;
  }
  return null;
}

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
 * How a mission classifies a queued item AT POP TIME (#115) — at pop time, not push time, because
 * the signals sharpen as the run goes (a `ChromeTracker` only recognises global chrome once the
 * control has been seen on a second pathname).
 */
export interface FrontierClass {
  /** Deferred: global chrome (header/nav/footer landmarks, a control repeated across pages) or a link out of scope. */
  readonly deferred: boolean;
  /** Where acting on it leads (a link's path, else the control identity) — chrome is tried once per destination. */
  readonly destination: string;
  /** Acting on it is expected to leave the target scope (a link whose destination is out of scope). */
  readonly leavesScope: boolean;
}

/**
 * The frontier's pop order (#115):
 *
 *  - `breadth` (`--strategy coverage`): the exhaustive sweep — items reachable without a reset first,
 *    then the oldest queued item, in DOM order within a state.
 *  - `novelty` (`--strategy exploratory`): novelty-seeking — the control that appeared MOST RECENTLY
 *    in the run first (what the last action just revealed: an opened panel's buttons, a new page's
 *    content), so the run follows the UI deeper instead of sweeping every state's siblings in order.
 */
export type FrontierOrder = "breadth" | "novelty";

export interface FrontierOptions {
  readonly order?: FrontierOrder;
  /** Classifies an item as chrome (see `FrontierClass`). Omitted: nothing is chrome. */
  readonly classify?: (item: FrontierItem) => FrontierClass;
  /**
   * The largest share (0..1) of the run's attempted actions that may be chrome which LEAVES the target
   * scope. Such a click proves nothing about the target — it is only a boundary edge. Default 0.2.
   */
  readonly maxLeavingChromeShare?: number;
}

/**
 * A dedup'd queue of not-yet-tried (state, action) pairs.
 *
 * Run-wide refinements on top of plain FIFO:
 *
 *  - `blacklist` (#75) — a control identity (role+name) that failed with a timeout (or was refused as
 *    not actionable) is never enqueued or popped again, however many new states re-offer it.
 *  - exercised preference (#75) — a control identity that has NEVER been successfully acted on yet
 *    is popped before one that has.
 *  - toggle round trips (#160) — `noteTransition` recognises a control whose click reverted the
 *    state it ran from (A→B→A: the SAME control, or its name-paired opposite — Collapse/Expand,
 *    Show/Hide, …) and, once a toggle has gone both ways, blacklists AND purges every identity
 *    involved, so a control that only ever flips between two states already proven is exercised
 *    once in each direction and never offered again — instead of every near-duplicate state it
 *    passes through re-queuing it afresh, forever.
 *  - chrome last (#115) — an item the mission classifies as chrome is popped only once no non-chrome
 *    item is left; each chrome destination is tried at most once per run; and chrome that leaves the
 *    target scope may never exceed `maxLeavingChromeShare` of the attempted actions.
 */
export class Frontier {
  private readonly queue: FrontierItem[] = [];
  private readonly seen = new Set<string>();
  private readonly blacklisted = new Set<string>();
  private readonly exercised = new Set<string>();
  /** Control identity → the generation (the discovery index of the state) it was first offered in (for `novelty`). */
  private readonly firstSeen = new Map<string, number>();
  /** State fingerprint → its discovery index. */
  private readonly generations = new Map<string, number>();
  private readonly chromeDestinations = new Set<string>();
  /** Toggle group -> control identities exercised in it so far (#160). */
  private readonly toggleDirections = new Map<string, Set<string>>();
  /** `"${before}\u0006${after}"` -> the identity of the item that produced that transition (#160). */
  private readonly transitions = new Map<string, string>();
  private readonly order: FrontierOrder;
  private readonly classify: ((item: FrontierItem) => FrontierClass) | undefined;
  private readonly maxLeavingChromeShare: number;
  private attempted = 0;
  private leavingChromeAttempted = 0;
  private lastClass: FrontierClass | null = null;

  constructor(options: FrontierOptions = {}) {
    this.order = options.order ?? "breadth";
    this.classify = options.classify;
    this.maxLeavingChromeShare = options.maxLeavingChromeShare ?? 0.2;
  }

  push(item: FrontierItem): void {
    if (this.seen.has(item.key)) return;
    const identity = controlIdentity(item.control);
    if (this.blacklisted.has(identity)) return;
    this.seen.add(item.key);
    if (!this.generations.has(item.fromFingerprint)) this.generations.set(item.fromFingerprint, this.generations.size);
    if (!this.firstSeen.has(identity)) this.firstSeen.set(identity, this.generations.get(item.fromFingerprint) ?? 0);
    this.queue.push(item);
  }

  /** Never enqueue or pop this control identity again for the rest of the run. */
  blacklist(identity: string): void {
    this.blacklisted.add(identity);
  }

  /**
   * Drops every currently QUEUED item for this control identity (already-popped items are
   * untouched — only what is still waiting). Used together with `blacklist()` for a toggle
   * completed in every direction (#160): purges the duplicate re-offers already queued from
   * earlier, near-identical states, instead of leaving them to be popped and re-attempted one by
   * one. `blacklist()` alone never does this (see its own test) — this is an explicit, separate
   * step so #75's existing "refuses every FURTHER push" contract is unchanged.
   */
  private dropIdentity(identity: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (controlIdentity((this.queue[i] as FrontierItem).control) === identity) this.queue.splice(i, 1);
    }
  }

  /**
   * Records the state transition an EXECUTED item produced (#160): `before` is the fingerprint it
   * ran from, `after` the one it landed in. A toggle exercised once in each direction is fully
   * covered — re-offering it forever (every near-duplicate state re-queuing it afresh) proves
   * nothing new about the target, so it is then dropped for the rest of the run:
   *
   *  - name-paired (Collapse/Expand, Show/Hide, …): once BOTH directions of the same toggle group
   *    have been exercised, every identity seen in that group is blacklisted and purged;
   *  - same-control round trip (A→B→A): once a transition's exact reverse is already on record —
   *    by this identity or another — both identities are blacklisted and purged.
   *
   * A no-op action (`before === after`) records nothing: nothing toggled.
   */
  noteTransition(before: string, control: Control, after: string): void {
    if (before === after) return;
    const identity = controlIdentity(control);
    const finish = (id: string): void => {
      this.blacklist(id);
      this.dropIdentity(id);
    };

    const group = toggleGroupOf(control);
    if (group !== null) {
      const seen = this.toggleDirections.get(group) ?? new Set<string>();
      seen.add(identity);
      this.toggleDirections.set(group, seen);
      if (seen.size >= 2) for (const id of seen) finish(id);
    }

    const key = `${before}\u0006${after}`;
    const reverseKey = `${after}\u0006${before}`;
    this.transitions.set(key, identity);
    const reverseIdentity = this.transitions.get(reverseKey);
    if (reverseIdentity !== undefined) {
      finish(identity);
      finish(reverseIdentity);
    }
  }

  /**
   * Drops every queued item performed FROM this state — its reset-and-replay went stale, and every
   * item sharing that path would replay (and wait out) the same failed reset (#114).
   */
  dropState(fingerprint: string): number {
    const before = this.queue.length;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.fromFingerprint === fingerprint) this.queue.splice(i, 1);
    }
    return before - this.queue.length;
  }

  /** Marks a control identity as successfully acted on — queued/future items for it are deprioritized. */
  markExercised(identity: string): void {
    this.exercised.add(identity);
  }

  /**
   * Counts one attempted action on the item last popped (landed or not) — the denominator of the
   * leaving-chrome share. Call it once per action the mission actually took.
   */
  recordAttempt(): void {
    this.attempted += 1;
    if (this.lastClass?.deferred === true && this.lastClass.leavesScope) this.leavingChromeAttempted += 1;
  }

  /** How the item last popped was classified (null when there is no classifier). */
  get lastPoppedClass(): FrontierClass | null {
    return this.lastClass;
  }

  /**
   * Pops the next item. Non-chrome first, by the frontier's order:
   *
   *  - `breadth`: (1) reachable without a reset+replay (its `fromFingerprint` matches where the browser
   *    already is) AND not-yet-exercised, (2) reachable without a reset, (3) not-yet-exercised (oldest),
   *    (4) the oldest queued item overall.
   *  - `novelty`: (1) not-yet-exercised, the control identity first offered by the most recently
   *    discovered state (reachable without a reset, then DOM order, on a tie), (2) the same over every item.
   *
   * Then chrome, once per destination and within the leaving-chrome share. Chrome that is not
   * eligible (its destination already tried, or over the share) is dropped.
   */
  popPreferring(preferFingerprint: string | undefined): FrontierItem | undefined {
    const classes = new Map<FrontierItem, FrontierClass>();
    const classOf = (it: FrontierItem): FrontierClass | null => {
      if (this.classify === undefined) return null;
      let c = classes.get(it);
      if (c === undefined) {
        c = this.classify(it);
        classes.set(it, c);
      }
      return c;
    };
    const nonChrome = this.queue.filter((it) => classOf(it)?.deferred !== true);
    let picked = this.pick(nonChrome, preferFingerprint);
    if (picked === undefined) {
      // Only chrome is left: each destination once, and leaving-scope chrome within its share.
      for (;;) {
        const chrome = this.queue.filter((it) => classOf(it)?.deferred === true);
        const next = this.pick(chrome, preferFingerprint);
        if (next === undefined) break;
        const cls = classOf(next);
        const overShare =
          cls !== null &&
          cls.leavesScope &&
          this.leavingChromeAttempted + 1 > this.maxLeavingChromeShare * (this.attempted + 1);
        if (cls !== null && !this.chromeDestinations.has(cls.destination) && !overShare) {
          picked = next;
          break;
        }
        this.remove(next); // already tried this destination, or over the share: never chosen
      }
    }
    if (picked === undefined) {
      this.lastClass = null;
      return undefined;
    }
    this.remove(picked);
    const cls = classOf(picked);
    this.lastClass = cls;
    if (cls?.deferred === true) this.chromeDestinations.add(cls.destination);
    return picked;
  }

  private pick(items: readonly FrontierItem[], preferFingerprint: string | undefined): FrontierItem | undefined {
    if (items.length === 0) return undefined;
    const notExercised = (it: FrontierItem): boolean => !this.exercised.has(controlIdentity(it.control));
    if (this.order === "novelty") {
      const fresh = items.filter(notExercised);
      const pool = fresh.length > 0 ? fresh : items;
      let best: FrontierItem | undefined;
      let bestRank = -1;
      for (const it of pool) {
        const rank = this.firstSeen.get(controlIdentity(it.control)) ?? 0;
        const better =
          rank > bestRank ||
          (rank === bestRank && best !== undefined && best.fromFingerprint !== preferFingerprint && it.fromFingerprint === preferFingerprint);
        if (better) {
          best = it;
          bestRank = rank;
        }
      }
      return best;
    }
    if (preferFingerprint !== undefined) {
      const here = items.filter((it) => it.fromFingerprint === preferFingerprint);
      const hit = here.find(notExercised) ?? here[0];
      if (hit !== undefined) return hit;
    }
    return items.find(notExercised) ?? items[0];
  }

  private remove(item: FrontierItem): void {
    const i = this.queue.indexOf(item);
    if (i !== -1) this.queue.splice(i, 1);
  }

  isExhausted(): boolean {
    return this.queue.length === 0;
  }

  get size(): number {
    return this.queue.length;
  }
}
