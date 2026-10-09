import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock, type HealBudget } from "@jevitate/domain";
import { HealBudgetMeter } from "./heal-budget.js";

const budget: HealBudget = {
  perStep: { maxAttempts: 2, maxModelCalls: 3, maxMs: 60_000 },
  perRun: { maxAttempts: 3, maxModelCalls: 5, maxMs: 100_000, maxBrokenSteps: 2 },
};

describe("HealBudgetMeter (#453)", () => {
  let fake: FakeClock;
  beforeEach(() => {
    fake = new FakeClock();
    installClock(fake);
  });
  afterEach(() => resetClock());

  it("refuses a third attempt on one step once perStep.maxAttempts 2 are spent", () => {
    const m = new HealBudgetMeter(budget);
    m.beginStep(0);
    m.recordAttempt();
    m.recordAttempt();
    expect(m.canAttempt()).toMatchObject({ by: "attempts", scope: "step" });
  });

  it("refuses an attempt once the step has spent perStep.maxMs of clock time", async () => {
    const m = new HealBudgetMeter(budget);
    m.beginStep(0);
    await fake.advanceBy(60_000);
    expect(m.canAttempt()).toMatchObject({ by: "wallClock", scope: "step" });
  });

  it("charges the run only for time spent healing, not for the time between broken steps", async () => {
    const m = new HealBudgetMeter(budget);
    m.beginStep(0);
    await fake.advanceBy(50_000);
    m.endStep();
    await fake.advanceBy(500_000); // the rest of the run replays: not heal time
    m.beginStep(3);
    await fake.advanceBy(50_000);
    expect(m.canAttempt()).toMatchObject({ by: "wallClock", scope: "run" });
  });

  it("refuses a broken step beyond perRun.maxBrokenSteps", () => {
    const m = new HealBudgetMeter(budget);
    m.beginStep(0);
    m.beginStep(1);
    expect(m.beginStep(2)).toMatchObject({ by: "brokenSteps", scope: "run" });
  });

  it("refuses a model call once the step has made perStep.maxModelCalls", () => {
    const m = new HealBudgetMeter(budget);
    m.beginStep(0);
    m.charge({ modelCalls: 3 });
    expect(m.canCallModel()).toMatchObject({ by: "modelCalls", scope: "step" });
  });

  it("sets the healer's deadline by the tighter of the step and run time budgets", async () => {
    const m = new HealBudgetMeter(budget);
    m.beginStep(0);
    await fake.advanceBy(55_000);
    m.endStep();
    m.beginStep(1);
    // step: 60s left; run: 100s - 55s = 45s left.
    expect(m.deadlineAtMs()).toBe(fake.now() + 45_000);
  });
});
