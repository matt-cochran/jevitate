import { describe, expect, it } from "vitest";
import { reportSlowness } from "./cold-start-report.js";

const slow = { step: 3, check: "responseStatus:POST /api/save=2xx", latencyMs: 10_000 };

describe("slowness across a run's replays of one Journey", () => {
  it("reports a cold start when only the first replay was slow", () => {
    const r = reportSlowness([{ journey: "j", slowSteps: [slow] }, { journey: "j", slowSteps: [] }]);
    expect(r.coldStarts).toEqual([{ kind: "cold-start", journey: "j", step: 3, check: slow.check, firstLatencyMs: 10_000, laterReplaysFast: 1 }]);
  });

  it("does not list a cold-start step as a separate slow-step", () => {
    const r = reportSlowness([{ journey: "j", slowSteps: [slow] }, { journey: "j", slowSteps: [] }]);
    expect(r.slowSteps).toEqual([]);
  });

  it("keeps a step slow on every replay as slow-step items", () => {
    const r = reportSlowness([{ journey: "j", slowSteps: [slow] }, { journey: "j", slowSteps: [slow] }]);
    expect(r.slowSteps).toHaveLength(2);
  });

  it("keeps a lone slow replay as a slow-step, not a cold start", () => {
    const r = reportSlowness([{ journey: "j", slowSteps: [slow] }]);
    expect(r.coldStarts).toEqual([]);
  });

  it("does not mix replays of different Journeys", () => {
    const r = reportSlowness([{ journey: "a", slowSteps: [slow] }, { journey: "b", slowSteps: [] }]);
    expect(r.coldStarts).toEqual([]);
  });
});
