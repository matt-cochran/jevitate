import { describe, expect, it } from "vitest";
import { boundCandidates, LIST_HEAD, type BudgetedCandidate } from "./candidate-budget.js";

/** #192: the decision's candidates are bounded below the judgment API's choice cap, keeping the useful ones. */
const c = (index: number, role: string, name: string, extra: { landmark?: "navigation" | null; scope?: string | null } = {}): BudgetedCandidate => ({
  control: { index, role, name, summary: `${role} "${name}"`, landmark: extra.landmark ?? null, scope: extra.scope ?? null },
  description: `click ${role} "${name}"`,
});

describe("boundCandidates", () => {
  it("keeps everything when it fits", () => {
    const all = [c(0, "button", "Save"), c(1, "link", "Home")];
    expect(boundCandidates(all, { limit: 5, goal: "save", history: [], offered: new Set() })).toEqual({ kept: all, omitted: 0 });
  });

  it("over the limit: keeps what the goal names (even deep in a list), what was just offered and primary controls, in page order", () => {
    const options = Array.from({ length: 300 }, (_, i) => c(10 + i, "option", i === 280 ? "Uruguay" : `Country ${i}`, { scope: 'dialog "Add"' }));
    const all = [c(0, "link", "Nav A", { landmark: "navigation" }), c(1, "button", "Add New Phone Number"), ...options, c(400, "button", "Save", { scope: 'dialog "Add"' })];
    const r = boundCandidates(all, { limit: 20, goal: "Add a phone number for Uruguay and save it", history: [], offered: new Set([400]) });
    expect(r.kept).toHaveLength(20);
    expect(r.omitted).toBe(all.length - 20);
    const names = r.kept.map((k) => k.control.name);
    expect(names).toContain("Uruguay"); // the goal names it: kept though it is option #281
    expect(names).toContain("Save"); // after the long list, offered by the last action
    expect(names).toContain("Add New Phone Number"); // a primary control
    expect(names.filter((n) => n.startsWith("Country ")).length).toBeLessThanOrEqual(LIST_HEAD + 20);
    // Page order is preserved.
    expect(r.kept.map((k) => k.control.index)).toEqual([...r.kept.map((k) => k.control.index)].sort((a, b) => a - b));
  });

  it("page chrome loses to content when something must go", () => {
    const all = [c(0, "link", "Nav A", { landmark: "navigation" }), c(1, "link", "Nav B", { landmark: "navigation" }), c(2, "button", "Export"), c(3, "button", "Import")];
    const r = boundCandidates(all, { limit: 2, goal: "do something", history: [], offered: new Set() });
    expect(r.kept.map((k) => k.control.name)).toEqual(["Export", "Import"]);
  });
});
