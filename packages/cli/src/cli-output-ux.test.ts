import { describe, expect, it } from "vitest";
import { formatMissionHuman } from "./cli-output.js";

const base = {
  strategy: "usability",
  missionOutcome: "clean",
  target: { seedUrl: "http://app.test/settings" },
  defects: [],
  hangs: [],
  resultPath: "/out/usability-x.recording.result.json",
};

describe("#213 — a usability summary mentions its UX findings", () => {
  it("counts them and lists the top ones", () => {
    const text = formatMissionHuman({
      ...base,
      reportPath: "/out/usability-x.ux.json",
      report: {
        findings: [
          { severity: "major", rubricItemId: "nielsen-1", route: "/settings", observation: "No feedback after Save." },
          { severity: "minor", rubricItemId: "scent", route: "/settings", observation: "Link label is vague." },
          { severity: "minor", rubricItemId: "nielsen-2", route: "/settings", observation: "Jargon." },
          { severity: "info", rubricItemId: "x", route: "/", observation: "Fourth." },
        ],
        heuristicAppendix: [{}],
        suppressed: { total: 12 },
      },
    });
    expect(text).toContain("UX      4 UX finding(s) (1 heuristic-only in the appendix, 12 suppressed) — report: /out/usability-x.ux.json");
    expect(text).toContain("        - [major] nielsen-1 /settings: No feedback after Save.");
    expect(text).toContain("          … and 1 more in the report");
  });

  it("#198: a verified claim shows its claim type and its boxed screenshot", () => {
    const text = formatMissionHuman({
      ...base,
      report: {
        findings: [
          { severity: "major", rubricItemId: "nielsen-5", route: "/admin", observation: "Delete acts immediately.", claim: { type: "destructive-unguarded" }, screenshot: { path: "/out/f/finding-1.png" } },
        ],
        heuristicAppendix: [],
        suppressed: { total: 0 },
      },
    });
    expect(text).toContain("        - [major] destructive-unguarded /admin: Delete acts immediately. (screenshot: /out/f/finding-1.png)");
  });

  it("says why there are none when the analysis was unavailable", () => {
    const text = formatMissionHuman({ ...base, missionOutcome: "inconclusive", report: null, analysisUnavailable: "UX analysis failed: boom" });
    expect(text).toContain("UX      no UX findings: analysis unavailable (UX analysis failed: boom)");
  });

  it("adds nothing for other strategies", () => {
    expect(formatMissionHuman({ ...base, strategy: "goal" })).not.toContain("UX ");
  });
});
