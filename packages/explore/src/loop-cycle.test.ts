import { describe, expect, it } from "vitest";
import { CYCLE_MAX_PERIOD, CYCLE_REPEATS, LoopCycleDetector, describeCycle, type CycleStep, type CycleVerdict } from "./loop-cycle.js";

/**
 * #367 — the loop-cycle detector: a run confined to at most two actions and two page states for
 * `CYCLE_REPEATS` round trips, with no request sent, is going round a loop.
 */

const click = (name: string, state: string, progress = false): CycleStep => ({ action: `click ${name}`, label: `click "${name}"`, state, progress });
const scroll = (dir: "down" | "up", state: string): CycleStep => ({ action: `scroll_${dir}`, label: `scroll ${dir}`, state, progress: false });

/** Feeds the steps; returns the index of the step that tripped, and the verdict (or -1 / null). */
function feed(steps: readonly CycleStep[], d = new LoopCycleDetector()): { at: number; verdict: CycleVerdict | null } {
  for (let i = 0; i < steps.length; i++) {
    const v = d.note(steps[i]!);
    if (v !== null) return { at: i, verdict: v };
  }
  return { at: -1, verdict: null };
}

const SPAN = CYCLE_REPEATS * CYCLE_MAX_PERIOD;

describe("LoopCycleDetector (#367)", () => {
  it("a period-2 click ping-pong with no delta stops after N round trips — not before", () => {
    const steps = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? click("Show site", "B") : click("Back", "A")));
    const { at, verdict } = feed(steps);
    expect(at).toBe(SPAN - 1);
    expect(verdict).toEqual({ labels: ['click "Show site"', 'click "Back"'], states: 2, period: 2, steps: SPAN });
    expect(describeCycle(verdict!)).toBe(
      `no progress: the run went round a loop — click "Show site" ↔ click "Back" — ${CYCLE_REPEATS} times (${SPAN} steps between the same 2 page states, no request sent, nothing new on the page)`,
    );
    // One step short of N round trips: not yet.
    expect(feed(steps.slice(0, SPAN - 1)).verdict).toBeNull();
  });

  it("a ping-pong whose clicks each send a request is progress — it never stops", () => {
    const steps = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? click("Add", "B", true) : click("Back", "A")));
    expect(feed(steps).verdict).toBeNull();
  });

  it("a ping-pong whose clicks each reveal a new state (or change a value) never stops", () => {
    // Next ↔ Back, but each Next lands on a new page (a new item, a new value in the signature).
    const steps = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? click("Next", `item-${i}`) : click("Back", "list")));
    expect(feed(steps).verdict).toBeNull();
  });

  it("a request in the middle of a loop restarts the count", () => {
    const loop = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? click("Open", "B") : click("Close", "A")));
    const d = new LoopCycleDetector();
    expect(feed([...loop(SPAN - 2), click("Save", "A", true)], d).verdict).toBeNull();
    expect(d.size).toBe(0);
    const { at } = feed(loop(SPAN), d);
    expect(at).toBe(SPAN - 1);
  });

  it("a list → item → back walk over different items is not a loop", () => {
    const steps: CycleStep[] = [];
    for (let i = 0; i < 20; i++) steps.push(click(`Item ${i}`, `item-${i}`), click("Back", "list"));
    expect(feed(steps).verdict).toBeNull();
  });

  it("a disclosure toggled open and shut (one control, two states) stops", () => {
    const steps = Array.from({ length: 40 }, (_, i) => click("Details", i % 2 === 0 ? "open" : "shut"));
    const { at, verdict } = feed(steps);
    expect(at).toBe(SPAN - 1);
    expect(verdict?.labels).toEqual(['click "Details"']);
    expect(describeCycle(verdict!)).toContain('click "Details" over and over');
  });

  it("zero-delta scroll direction flips (the page never moves) stop", () => {
    const steps = Array.from({ length: 40 }, (_, i) => scroll(i % 2 === 0 ? "down" : "up", "S@0"));
    const { at, verdict } = feed(steps);
    expect(at).toBe(SPAN - 1);
    expect(verdict?.labels).toEqual(["scroll down", "scroll up"]);
  });

  it("the #367 target-absent scroll: down (moved), down (did not move), up (moved), up (did not move)… stops", () => {
    // The target is on no page: the model scrolls to the bottom, again, back to the top, again.
    const pattern = [scroll("down", "S@480"), scroll("down", "S@480"), scroll("up", "S@0"), scroll("up", "S@0")];
    const steps = Array.from({ length: 60 }, (_, i) => pattern[i % pattern.length]!);
    const { at, verdict } = feed(steps);
    expect(at).toBe(SPAN - 1);
    expect(verdict?.states).toBe(2);
  });

  it("reading a long page (each scroll reaches a new position) is not a loop", () => {
    const steps = Array.from({ length: 30 }, (_, i) => scroll("down", `S@${i * 600}`));
    expect(feed(steps).verdict).toBeNull();
  });

  it("one action that lands on one state (a step that changed nothing) is left to NoProgressDetector", () => {
    const steps = Array.from({ length: 30 }, () => click("Save", "A"));
    expect(feed(steps).verdict).toBeNull();
  });

  it("three alternating actions are not a period-2 cycle", () => {
    const names = ["A", "B", "C"];
    const steps = Array.from({ length: 30 }, (_, i) => click(names[i % 3]!, names[(i + 1) % 3]!));
    expect(feed(steps).verdict).toBeNull();
  });

  it("rejects an invalid configuration", () => {
    expect(() => new LoopCycleDetector(1)).toThrow(/repeats/);
    expect(() => new LoopCycleDetector(4, 0)).toThrow(/maxPeriod/);
  });
});
