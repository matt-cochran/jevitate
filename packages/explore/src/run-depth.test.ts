import { describe, expect, it } from "vitest";
import { DepthLog, breadthHint, goalIsOpenEnded, minEffortNote, resolveMinEffort, shortfall } from "./run-depth.js";
import type { Control } from "./snapshot.js";

const ctl = (name: string, extra: Partial<Control> = {}): Control => ({ index: 0, role: "link", name, enabled: true, ...extra }) as unknown as Control;

describe("#424 goalIsOpenEnded", () => {
  it.each([
    "Use this tool's main features and report what works and every error you see.",
    "Try out all the features of the dashboard",
    "Explore the app and tell me what you find",
    "Give an overview of each tab",
    "Report what doesn't work",
  ])("open-ended: %s", (g) => expect(goalIsOpenEnded(g)).toBe(true));
  it.each(["Find out how many contacts are listed. Report the answer.", "Which plan am I on?", "Check whether there is a status page"])(
    "narrow: %s",
    (g) => expect(goalIsOpenEnded(g)).toBe(false),
  );
});

describe("#424 resolveMinEffort", () => {
  const OPEN = "Use the main features and report every error";
  it("defaults only for an open-ended goal whose answer is the verdict, scaled to half the budget", () => {
    expect(resolveMinEffort({ goal: OPEN, answerIsVerdict: true, maxActions: 60, maxDecisions: 120 })).toEqual({
      minEffort: { minActions: 12, minDistinctStates: 5, source: "open-ended" },
      warnings: [],
    });
    expect(resolveMinEffort({ goal: OPEN, answerIsVerdict: true, maxActions: 6, maxDecisions: 120 }).minEffort).toEqual({ minActions: 3, minDistinctStates: 4, source: "open-ended" });
    expect(resolveMinEffort({ goal: OPEN, answerIsVerdict: false, maxActions: 60, maxDecisions: 120 }).minEffort).toBeNull();
    expect(resolveMinEffort({ goal: "Find out the plan", answerIsVerdict: true, maxActions: 60, maxDecisions: 120 }).minEffort).toBeNull();
  });
  it("explicit values win, each over its own default, for any goal", () => {
    expect(resolveMinEffort({ goal: OPEN, answerIsVerdict: true, request: { minActions: 2 }, maxActions: 60, maxDecisions: 120 }).minEffort).toEqual({
      minActions: 2,
      minDistinctStates: 5,
      source: "flags+open-ended",
    });
    expect(resolveMinEffort({ goal: "Save the form", answerIsVerdict: false, request: { minDistinctStates: 3 }, maxActions: 60, maxDecisions: 120 }).minEffort).toEqual({
      minActions: 0,
      minDistinctStates: 3,
      source: "flags",
    });
  });
  it("caps an explicit value at the budget with a warning, never an error", () => {
    const r = resolveMinEffort({ goal: "x", answerIsVerdict: true, request: { minActions: 50, minDistinctStates: 40 }, maxActions: 10, maxDecisions: 120 });
    expect(r.minEffort).toEqual({ minActions: 10, minDistinctStates: 11, source: "flags" });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/--min-actions 50 exceeds the run's budget \(10 actions, 120 decisions\): capped at 10/);
    expect(r.warnings[1]).toMatch(/--min-distinct-states 40 cannot be reached .* capped at 11/);
  });
});

describe("#424 DepthLog / shortfall / breadthHint", () => {
  it("counts distinct states and pages, submits, and reports the minimum's state", () => {
    const d = new DepthLog();
    d.noteState("a", "https://x.test/");
    d.noteState("b", "https://x.test/");
    d.noteState("c", "https://x.test/p?q=1");
    d.noteState("a", "https://x.test/");
    d.noteSubmitted();
    const min = { minActions: 2, minDistinctStates: 3, source: "flags" as const };
    expect(d.report(1, 4, min)).toEqual({ distinctStates: 3, distinctPages: 2, actions: 1, decisions: 4, formsSubmitted: 1, minimum: { ...min, met: false } });
    expect(d.report(2, 4, min).minimum?.met).toBe(true);
    expect(d.report(2, 4, null).minimum).toBeUndefined();
    expect(shortfall(min, 0, 1)).toBe("0 of 2 actions, 1 of 3 distinct page states");
    expect(shortfall(min, 2, 3)).toBeNull();
  });
  it("names unseen navigation, then untried navigation / links / submits, never a tried or disabled control", () => {
    const d = new DepthLog();
    d.noteTried("https://x.test/", "Home");
    const hint = breadthHint({
      url: "https://x.test/",
      controls: [ctl("Save", { role: "button", submits: true }), ctl("Home", { landmark: "navigation" }), ctl("Detail"), ctl("Tab B", { role: "tab" }), ctl("Off", { enabled: false })],
      unseenNav: ["/reports"],
      depth: d,
    });
    expect(hint).toBe('pages not yet seen: /reports; untried here: "Tab B", "Detail", "Save"');
    expect(breadthHint({ url: "https://x.test/", controls: [], unseenNav: [], depth: d })).toMatch(/go back to an earlier page/);
  });
  it("tells the model the minimum up front", () => {
    expect(minEffortNote({ minActions: 4, minDistinctStates: 3, source: "open-ended" })).toMatch(/open-ended goal.*at least 4 action\(s\) across at least 3 distinct page state\(s\)/);
  });
});
