import { describe, expect, it } from "vitest";
import type { Question } from "@jevitate/ai-core";
import { decide } from "../decide.js";
import type { Control, Snapshot } from "../snapshot.js";
import { ScriptedJudge } from "../testkit.js";
import { GoalFocus, isNavigation, stem } from "./goal-focus.js";

function nav(index: number, name: string, role = "link", landmark: Control["landmark"] = "navigation"): Control {
  return {
    index,
    descriptor: { role, name },
    stability: "high",
    role,
    name,
    tag: role === "link" ? "a" : "button",
    inputType: null,
    enabled: true,
    summary: `${role} "${name}"`,
    landmark,
  };
}

const SIDEBAR = ["Dashboard", "Settings", "Connections", "Pricing", "Texting registration", "Team", "Billing", "Audit log"].map((n, i) =>
  nav(i, n),
);
const GOAL = "connect the payment provider from Settings → Connections and check Pricing";

describe("goal focus (#338) — navigation to sections the goal never names is off-goal once its area is reached", () => {
  it("stems the goal's section names so plural / -ing forms meet", () => {
    expect(stem("Connections")).toBe(stem("connect"));
    expect(stem("Pricing")).toBe(stem("price"));
    expect(stem("Settings")).toBe(stem("setting"));
  });

  it("marks nothing before the goal's area is reached", () => {
    const f = new GoalFocus(GOAL);
    f.noteUrl("http://app.localtest.me/dashboard");
    expect(f.reached).toBeNull();
    expect(f.offGoal(SIDEBAR).size).toBe(0);
  });

  it("after a click into a named section, unnamed sections are off-goal — both named sections stay on-goal", () => {
    const f = new GoalFocus(GOAL);
    f.noteClicked(SIDEBAR[0]!); // Dashboard: not named → not the goal's area
    expect(f.reached).toBeNull();
    f.noteClicked(SIDEBAR[2]!); // Connections
    expect(f.reached).toMatch(/Connections/);
    const off = [...f.offGoal(SIDEBAR)].map((i) => SIDEBAR[i]!.name);
    expect(off).toEqual(["Dashboard", "Texting registration", "Team", "Billing", "Audit log"]);
    // Settings, Connections and Pricing are all named: the goal may cross between them.
    expect(off).not.toContain("Pricing");
    expect(off).not.toContain("Settings");
  });

  it("a URL path naming a goal term reaches the area too", () => {
    const f = new GoalFocus(GOAL);
    f.noteUrl("http://app.localtest.me/org/42/settings/connections");
    expect(f.reached).toMatch(/settings/);
    expect(f.offGoal(SIDEBAR).has(4)).toBe(true);
  });

  it("only navigation is ever off-goal: content buttons, fields and icon-only links are not", () => {
    const f = new GoalFocus(GOAL);
    f.noteUrl("http://x.test/connections");
    const content = { ...nav(10, "Delete everything", "button", null) };
    const icon = nav(11, "", "link");
    const tab = nav(12, "Webhooks", "tab", null);
    expect(isNavigation(content)).toBe(false);
    expect(f.offGoal([content, icon, tab])).toEqual(new Set([12]));
  });

  it("decide lists off-goal navigation last and marks it in the state and its description — still offered", async () => {
    const snap: Snapshot = { url: "http://x.test/connections", controls: SIDEBAR, truncated: false, signature: "s" };
    const judge = new ScriptedJudge([{ op: "click", target: "3" }]);
    const d = await decide(judge, { goal: GOAL, snapshot: snap, history: [], offGoal: new Set([0, 4, 5, 6, 7]) });
    expect(d.control?.name).toBe("Pricing");
    const q = judge.calls[0]!.questions.action as Extract<Question, { kind: "choice" }>;
    const clicks = q.options.filter((o) => o.startsWith("click:"));
    expect(clicks).toEqual(["click:1", "click:2", "click:3", "click:0", "click:4", "click:5", "click:6", "click:7"]);
    expect(q.descriptions?.["click:4"]).toMatch(/off-goal/);
    expect(q.descriptions?.["click:3"]).not.toMatch(/off-goal/);
    expect(q.instructions).toMatch(/off-goal/);
    expect(JSON.stringify(d.state)).toMatch(/Texting registration.*off-goal/);
  });

  it("decide without off-goal controls is unchanged (no marker, page order)", async () => {
    const snap: Snapshot = { url: "http://x.test/", controls: SIDEBAR, truncated: false, signature: "s" };
    const judge = new ScriptedJudge([{ op: "click", target: "2" }]);
    await decide(judge, { goal: GOAL, snapshot: snap, history: [] });
    const q = judge.calls[0]!.questions.action as Extract<Question, { kind: "choice" }>;
    expect(q.options.filter((o) => o.startsWith("click:"))).toEqual(SIDEBAR.map((c) => `click:${c.index}`));
    expect(q.instructions).not.toMatch(/off-goal/);
  });
});
