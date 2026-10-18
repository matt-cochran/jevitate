import { describe, it, expect } from "vitest";
import { JourneySchema } from "./index.js";
import { classifyHandback, type HandbackFacts } from "./handback.js";

// #583: the prepare-only boundary. Two halves: the load-time refusals on a Journey file
// (`E_BOUNDARY_SCHEMA`) and the pure classifier from run facts to the §4 handback result.

const boundary = {
  kind: "prepare-only",
  stopBefore: { target: { testId: "reply-send" }, label: "Send" },
  nextStep: "Read the prepared reply in Community, then click Send yourself.",
};

const facts = (over: Partial<HandbackFacts> = {}): HandbackFacts => ({
  outcome: "ok",
  steps: 3,
  checksPassed: 3,
  writes: 0,
  writesBlocked: 0,
  writeObservation: "available",
  ...over,
});

const journeyWithBoundary = (steps: unknown[], over: Record<string, unknown> = {}) => ({
  metadata: {
    id: "reply",
    name: "Reply",
    promoted: true,
    params: [],
    createdAtIso: "2026-01-01T00:00:00Z",
    boundary: { ...boundary, ...over },
  },
  recording: {
    version: "1",
    site: "https://example.test",
    pages: [{ url: "/", steps: steps.map((step, i) => ({ stepId: `s-${i}`, step })) }],
  },
});

const navigate = { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } };
const click = (target: Record<string, unknown>) => ({ kind: "click", target, expect: { kind: "visible", target } });
const fill = (target: Record<string, unknown>) => ({ kind: "fill", target, value: { redacted: false, value: "hi" }, expect: { kind: "visible", target } });
const press = (key: string) => ({ kind: "press", key, expect: { kind: "urlIncludes", text: "/" } });
const handbackStep = { kind: "handback", prompt: "enter it", resume: { kind: "visible", target: { testId: "field" } } };

const issues = (j: unknown): string => {
  const r = JourneySchema.safeParse(j);
  return r.success ? "" : r.error.issues.map((i) => i.message).join("\n");
};

describe("JourneySchema metadata.boundary (#583)", () => {
  it("accepts a prepare-only boundary", () => {
    expect(JourneySchema.safeParse(journeyWithBoundary([navigate])).success).toBe(true);
  });

  it("accepts a Journey without a boundary (additive)", () => {
    const j = journeyWithBoundary([navigate]);
    delete (j.metadata as Record<string, unknown>).boundary;
    expect(JourneySchema.safeParse(j).success).toBe(true);
  });

  it("accepts blockWrites: true", () => {
    expect(JourneySchema.safeParse(journeyWithBoundary([navigate], { blockWrites: true })).success).toBe(true);
  });

  it("refuses a nextStep longer than 500 characters", () => {
    expect(JourneySchema.safeParse(journeyWithBoundary([navigate], { nextStep: "x".repeat(501) })).success).toBe(false);
  });

  it("refuses a boundary kind other than prepare-only", () => {
    expect(JourneySchema.safeParse(journeyWithBoundary([navigate], { kind: "send" })).success).toBe(false);
  });

  it("refuses a click on the stopBefore target", () => {
    expect(issues(journeyWithBoundary([navigate, click({ testId: "reply-send" })]))).toMatch(/^E_BOUNDARY_SCHEMA/);
  });

  it("names the step path when refusing a click on the stopBefore target", () => {
    expect(issues(journeyWithBoundary([navigate, click({ testId: "reply-send" })]))).toContain("recording.pages[0].steps[1]");
  });

  it("refuses a click on the stopBefore target inside a forEach", () => {
    const each = { kind: "forEach", items: { testId: "rows" }, as: "row", steps: [click({ testId: "reply-send" })] };
    expect(issues(journeyWithBoundary([navigate, each]))).toMatch(/^E_BOUNDARY_SCHEMA/);
  });

  it("refuses a press of Enter", () => {
    expect(issues(journeyWithBoundary([navigate, press("Enter")]))).toMatch(/^E_BOUNDARY_SCHEMA/);
  });

  it("refuses a press of NumpadEnter", () => {
    expect(issues(journeyWithBoundary([navigate, press("NumpadEnter")]))).toMatch(/^E_BOUNDARY_SCHEMA/);
  });

  it("refuses a click after the last fill", () => {
    expect(issues(journeyWithBoundary([navigate, fill({ testId: "reply" }), click({ testId: "other" })]))).toMatch(/^E_BOUNDARY_SCHEMA/);
  });

  it("refuses a click when nothing prepares a value", () => {
    expect(issues(journeyWithBoundary([navigate, click({ testId: "tab" })]))).toMatch(/^E_BOUNDARY_SCHEMA/);
  });

  it("refuses a handback step", () => {
    expect(issues(journeyWithBoundary([navigate, handbackStep]))).toMatch(/^E_BOUNDARY_SCHEMA/);
  });

  it("accepts a click on an unrelated control before the fill", () => {
    expect(JourneySchema.safeParse(journeyWithBoundary([navigate, click({ testId: "tab" }), fill({ testId: "reply" })])).success).toBe(true);
  });
});

describe("classifyHandback (#583 §4)", () => {
  it("reports prepared when the run is ok with no writes", () => {
    expect(classifyHandback(facts(), boundary).state).toBe("prepared");
  });

  it("shows the human next step only when prepared", () => {
    expect(classifyHandback(facts(), boundary).nextStep).toBe(boundary.nextStep);
  });

  it("carries the stopBefore label", () => {
    expect(classifyHandback(facts(), boundary).stopBefore).toBe("Send");
  });

  it("names the boundary kind", () => {
    expect(classifyHandback(facts(), boundary).boundary).toBe("prepare-only");
  });

  it("reports verification-failed when a step's postcondition failed", () => {
    expect(classifyHandback(facts({ outcome: "quarantined", failedAt: 2, failedKind: "postcondition" }), boundary).state).toBe("verification-failed");
  });

  it("names the failed step in the evidence", () => {
    expect(classifyHandback(facts({ outcome: "quarantined", failedAt: 2, failedKind: "postcondition" }), boundary).evidence.failedAt).toBe(2);
  });

  it("reports incomplete when the run ended for another reason", () => {
    expect(classifyHandback(facts({ outcome: "quarantined", failedAt: 1, failedKind: "other" }), boundary).state).toBe("incomplete");
  });

  it("reports inconclusive when the run's outcome is inconclusive", () => {
    expect(classifyHandback(facts({ outcome: "inconclusive" }), boundary).state).toBe("inconclusive");
  });

  it("reports inconclusive when write observation was unavailable", () => {
    expect(classifyHandback(facts({ writeObservation: "unavailable" }), boundary).state).toBe("inconclusive");
  });

  it("reports submitted when a write was sent", () => {
    expect(classifyHandback(facts({ writes: 1 }), boundary).state).toBe("submitted");
  });

  it("reports submitted when a write was blocked", () => {
    expect(classifyHandback(facts({ writesBlocked: 1 }), boundary).state).toBe("submitted");
  });

  it("lets submitted override a failed postcondition", () => {
    expect(classifyHandback(facts({ outcome: "quarantined", failedAt: 2, failedKind: "postcondition", writes: 1 }), boundary).state).toBe("submitted");
  });

  it("hides the human next step when the state is not prepared", () => {
    expect(classifyHandback(facts({ writes: 1 }), boundary).nextStep).toBe(undefined);
  });

  it("carries the run's counts as evidence", () => {
    expect(classifyHandback(facts({ steps: 9, checksPassed: 9, writes: 0, writesBlocked: 0 }), boundary).evidence).toEqual({
      steps: 9,
      checksPassed: 9,
      writes: 0,
      writesBlocked: 0,
    });
  });
});
