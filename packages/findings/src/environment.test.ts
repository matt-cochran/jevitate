import { describe, expect, it } from "vitest";
import { environmentCausesOf, runFromMissionResult } from "./extract.js";
import { renderReportMarkdown } from "./markdown.js";

/** #422: a batch's environment faults are listed once (summed, with how many runs hit each) — never as defects. */

const result = (stamp: string, causes: unknown[], extra: Record<string, unknown> = {}) =>
  runFromMissionResult(`/out/explore-${stamp}.result.json`, {
    missionOutcome: "clean",
    exitCode: 0,
    result: {
      schemaVersion: 1,
      strategy: "coverage",
      missionOutcome: "clean",
      defects: [],
      hangs: [],
      target: { seedUrl: "http://app.test/", allowlist: [] },
      ...(causes.length === 0 ? {} : { environmentFaults: { causes } }),
      ...extra,
    },
  });

describe("environment faults across a batch (#422)", () => {
  it("reads each run's causes and lists each one once for the batch", () => {
    const key = { ruleId: "default:credential", source: "docker:api", message: "Incorrect API key provided" };
    const a = result("2026-10-08T10-00-00-000Z", [{ ...key, count: 2 }, { ruleId: "x", source: "s" /* malformed: no message/count */ }]);
    const b = result("2026-10-08T11-00-00-000Z", [{ ...key, count: 1 }], {
      expectedValidation: [{ ruleId: "v", source: "docker:api", message: "invalid email", count: 1 }],
    });
    const c = result("2026-10-08T12-00-00-000Z", []);
    expect(a?.environmentFaults).toEqual([{ ...key, count: 2 }]);
    expect(b?.expectedValidation).toEqual([{ ruleId: "v", source: "docker:api", message: "invalid email", count: 1 }]);
    expect(c !== null && "environmentFaults" in c).toBe(false);
    const runs = [a!, b!, c!];
    expect(environmentCausesOf(runs)).toEqual([{ ...key, count: 3, runs: 2 }]);
    expect(a?.observations).toEqual([]); // never a finding
    const md = renderReportMarkdown({ title: "t", runs, defects: [] });
    expect(md).toContain("## Environment faults");
    expect(md.match(/Incorrect API key provided/g)).toHaveLength(1);
    expect(md).toContain("| 3 | 2/3 |");
  });

  it("no causes: no section", () => {
    expect(renderReportMarkdown({ title: "t", runs: [result("2026-10-08T10-00-00-000Z", [])!], defects: [] })).not.toContain("Environment faults");
  });
});
