import { describe, expect, it } from "vitest";
import { formatMissionHuman } from "./cli-output.js";

/**
 * #424: a goal run's human summary says how deep it went, and a find-out that could not ground an
 * answer prints its partial report (what each page showed, what was tried) instead of only "answer
 * not found"; a minimum effort capped by the budget is a WARNING line.
 */
describe("#424 depth and partial report in the human summary", () => {
  const base = {
    strategy: "goal",
    missionOutcome: "defects-found",
    goalOutcome: "blocked",
    stop: "blocked",
    target: { seedUrl: "http://app.test/", allowlist: [] },
    defects: [],
    hangs: [],
    reason: "answer not found (pages seen: /, /reports)",
    resultPath: "/runs/explore-1.result.json",
  };

  it("prints DEPTH with the minimum, PARTIAL per page, grounded claims, and the warnings", () => {
    const lines = formatMissionHuman({
      ...base,
      depth: { distinctStates: 3, distinctPages: 2, actions: 4, decisions: 9, formsSubmitted: 1, minimum: { minActions: 4, minDistinctStates: 3, source: "open-ended", met: true } },
      partialReport: {
        note: "answer not found (pages seen: /, /reports)",
        states: [
          { url: "/", title: "Tool", seen: ["Overview: 3 projects active"], controls: ["Reports"], tried: [{ op: "click", control: 'link "Reports"', ok: true, result: "led to /reports" }] },
          { url: "/reports", heading: "Reports", seen: ["Error: the weekly report failed to load."], controls: [], tried: [{ op: "click", control: 'button "Export"', ok: false, result: "refused: read-only run" }] },
        ],
        claims: [{ claim: "3 projects are active", quote: "Overview: 3 projects active", url: "http://app.test/", grounded: true }],
      },
      checkWarnings: ["--min-actions 80 exceeds the run's budget (60 actions, 120 decisions): capped at 60"],
    }).split("\n");
    expect(lines).toContain("DEPTH   3 distinct state(s) on 2 page(s), 4 action(s), 1 form(s) submitted · minimum 4 action(s) / 3 state(s) (open-ended): met");
    expect(lines).toContain("PARTIAL no grounded answer — what the run saw and tried on 2 page(s) (observed evidence only)");
    expect(lines).toContain("        / — Tool");
    expect(lines).toContain('          seen: "Overview: 3 projects active"');
    expect(lines).toContain('          tried: click link "Reports" → led to /reports');
    expect(lines).toContain('          tried: click button "Export" → failed: refused: read-only run');
    expect(lines).toContain('        grounded claim: 3 projects are active ("Overview: 3 projects active")');
    expect(lines).toContain("WARNING --min-actions 80 exceeds the run's budget (60 actions, 120 decisions): capped at 60");
  });

  it("prints nothing extra for a result without depth or a partial report", () => {
    const text = formatMissionHuman(base);
    expect(text).not.toContain("DEPTH");
    expect(text).not.toContain("PARTIAL");
  });
});
