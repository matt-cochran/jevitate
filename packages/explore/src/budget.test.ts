import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import type { BudgetDeclaration, ObservedValue } from "@jevitate/recording";
import { BudgetMonitor, type ObservableReader } from "./budget.js";

/** A fake reader: a scripted sequence of values per observable, one read consumed per call. */
class FakeReader implements ObservableReader {
  readonly #queues: Map<string, Array<{ value: ObservedValue | null; unreadable: boolean }>>;
  constructor(queues: Record<string, Array<number | null | "unreadable">>) {
    this.#queues = new Map(
      Object.entries(queues).map(([name, vs]) => [
        name,
        vs.map((v) => (v === "unreadable" ? { value: null, unreadable: true } : { value: v, unreadable: false })),
      ]),
    );
  }
  async readObservable(_page: Page, name: string): Promise<{ value: ObservedValue | null; unreadable: boolean }> {
    const q = this.#queues.get(name);
    if (q === undefined || q.length === 0) return { value: null, unreadable: true };
    return q.shift() as { value: ObservedValue | null; unreadable: boolean };
  }
}

const page = {} as Page;

describe("BudgetMonitor (#150)", () => {
  it("a negative maxDelta caps spend: crosses once delta <= maxDelta", async () => {
    const decl: BudgetDeclaration = { observe: "credits", maxDelta: -100 };
    const reader = new FakeReader({ credits: [1000, 950, 900] });
    const m = new BudgetMonitor([decl], reader);
    expect(await m.baseline(page)).toEqual({ crossed: false });
    expect((await m.afterSettle(page, 1)).crossed).toBe(false);
    const r = await m.afterSettle(page, 2);
    expect(r.crossed).toBe(true);
    expect(r.reason).toMatch(/credits.*-100/);
    expect(m.trajectory()).toEqual([
      {
        observe: "credits",
        limit: -100,
        baseline: 1000,
        final: 900,
        delta: -100,
        perAction: [
          { step: 1, before: 1000, after: 950 },
          { step: 2, before: 950, after: 900 },
        ],
      },
    ]);
  });

  it("a positive maxDelta caps growth: crosses once delta >= maxDelta", async () => {
    const decl: BudgetDeclaration = { observe: "requests", maxDelta: 5 };
    const reader = new FakeReader({ requests: [0, 3, 6] });
    const m = new BudgetMonitor([decl], reader);
    await m.baseline(page);
    expect((await m.afterSettle(page, 1)).crossed).toBe(false);
    expect((await m.afterSettle(page, 2)).crossed).toBe(true);
  });

  it("fails closed on an unreadable baseline by default (onUnreadable: stop)", async () => {
    const decl: BudgetDeclaration = { observe: "credits", maxDelta: -10 };
    const reader = new FakeReader({ credits: ["unreadable"] });
    const m = new BudgetMonitor([decl], reader);
    const r = await m.baseline(page);
    expect(r.crossed).toBe(true);
    expect(r.reason).toMatch(/could not be read/);
    expect(m.trajectory()[0]).toMatchObject({ observe: "credits", unreadable: true });
  });

  it("onUnreadable: continue skips an unreadable read instead of stopping", async () => {
    const decl: BudgetDeclaration = { observe: "credits", maxDelta: -1000, onUnreadable: "continue" };
    const reader = new FakeReader({ credits: [1000, "unreadable", 950] });
    const m = new BudgetMonitor([decl], reader);
    await m.baseline(page);
    expect((await m.afterSettle(page, 1)).crossed).toBe(false); // unreadable, but continue
    expect((await m.afterSettle(page, 2)).crossed).toBe(false); // 950, delta -50, well within -1000
  });

  it("guard refuses a paid action whose estimate would cross the remaining budget (fail closed on no estimate)", async () => {
    const decl: BudgetDeclaration = { observe: "credits", maxDelta: -100, guard: { estimate: 80 } };
    const reader = new FakeReader({ credits: [1000] });
    const m = new BudgetMonitor([decl], reader);
    await m.baseline(page);
    // Not paid: never gated, whatever the estimate.
    expect(await m.guard(page, { op: "click", control: "Free thing", paid: false })).toEqual({ refuse: false });
    // Paid, 80 < 100 remaining: allowed.
    expect(await m.guard(page, { op: "click", control: "Small spend", paid: true })).toEqual({ refuse: false });

    const decl2: BudgetDeclaration = { observe: "credits", maxDelta: -50, guard: { estimate: 80 } };
    const m2 = new BudgetMonitor([decl2], new FakeReader({ credits: [1000] }));
    await m2.baseline(page);
    const refusal = await m2.guard(page, { op: "click", control: "Big spend", paid: true });
    expect(refusal.refuse).toBe(true);
    expect(refusal.reason).toMatch(/Big spend/);
  });

  it("guard scales the estimate by factor, and refuses when the estimate itself can't be read", async () => {
    const decl: BudgetDeclaration = { observe: "credits", maxDelta: -100, guard: { estimate: "confirmEst", factor: 2 } };
    const reader = new FakeReader({ credits: [1000], confirmEst: [40] });
    const m = new BudgetMonitor([decl], reader);
    await m.baseline(page);
    // 40 * 2 = 80 < 100: allowed.
    const ok = await m.guard(page, { op: "click", control: "Run", paid: true });
    expect(ok.refuse).toBe(false);

    const missingEstimate = new BudgetMonitor(
      [{ observe: "credits", maxDelta: -100, guard: { estimate: "confirmEst" } }],
      new FakeReader({ credits: [1000], confirmEst: ["unreadable"] }),
    );
    await missingEstimate.baseline(page);
    const refused = await missingEstimate.guard(page, { op: "click", control: "Run", paid: true });
    expect(refused.refuse).toBe(true);
    expect(refused.reason).toMatch(/no cost estimate/);
  });

  it("a monitor with no declarations is a harmless no-op", async () => {
    const m = new BudgetMonitor([], new FakeReader({}));
    expect(m.declared).toBe(false);
    expect(await m.baseline(page)).toEqual({ crossed: false });
    expect(await m.afterSettle(page, 1)).toEqual({ crossed: false });
    expect(await m.guard(page, { op: "click", control: "x", paid: true })).toEqual({ refuse: false });
    expect(m.trajectory()).toEqual([]);
  });
});
