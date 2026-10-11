import { describe, expect, it } from "vitest";
import { formatMissionHuman, formatVerifyFixHuman } from "./cli-output.js";

/**
 * #484: a write jevitate blocked is an environment fault — its loopback --allow mismatch is a WARNING,
 * the findings it caused sit beneath it; a verify-fix replay under an overridden allow list says so.
 */

const write = "POST http://127.0.0.1:3000/api/upload";
const run = {
  strategy: "adversarial",
  missionOutcome: "clean",
  target: { seedUrl: "http://localhost:3000/", allowlist: ["http://localhost:3000"] },
  defects: [],
  hangs: [],
  resultPath: "/runs/explore-1.result.json",
  blockedWrites: [{ method: "POST", path: "http://127.0.0.1:3000/api/upload", allowMismatch: { message: "add http://127.0.0.1:3000 to --allow" } }],
  environmentFaults: {
    causes: [
      {
        ruleId: "jevitate:blocked-write",
        source: "jevitate --allow guard",
        message: `${write}: not an --allow origin, never sent`,
        count: 1,
        consequences: [{ kind: "hang:ui-no-progress", title: "Hang (ui-no-progress) on /files", firstSeenStep: 5 }],
      },
    ],
  },
};

describe("#484 blocked writes in the human summary", () => {
  it("warns about the loopback --allow mismatch", () => {
    expect(formatMissionHuman(run)).toMatch(/WARNING\s+add http:\/\/127\.0\.0\.1:3000 to --allow/);
  });

  it("lists the finding a blocked write caused beneath it, as not a defect", () => {
    expect(formatMissionHuman(run)).toMatch(/CAUSED\s+hang:ui-no-progress: Hang \(ui-no-progress\) on \/files \(step 5; not a defect\)/);
  });

  it("says a verify-fix replay ran under an overridden allow list", () => {
    const report = {
      verdict: "fixed",
      fingerprint: "abc",
      allowlistOverride: { source: "--allow", origins: ["http://localhost:3000", "http://127.0.0.1:3000"], recorded: ["http://localhost:3000"] },
    };
    expect(formatVerifyFixHuman(report)).toContain("overridden by --allow: http://localhost:3000, http://127.0.0.1:3000 (stored: http://localhost:3000)");
  });
});
