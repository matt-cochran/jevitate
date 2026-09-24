import { describe, expect, it } from "vitest";
import { consolidate } from "./consolidate.js";
import { runFromMissionResult, runFromUxReport, stampToIso, type RunRecord } from "./extract.js";
import { findingKey, identityBasis } from "./identity.js";

/** A persisted adversarial result (`{missionOutcome, exitCode, result}`), as the runner writes it. */
function adversarial(stamp: string, defects: unknown[], extra: Record<string, unknown> = {}): RunRecord {
  const path = `/r/adversarial-${stamp}.result.json`;
  const run = runFromMissionResult(path, {
    missionOutcome: defects.length > 0 ? "defects-found" : "clean",
    exitCode: defects.length > 0 ? 1 : 0,
    result: {
      target: { seedUrl: "https://app.example/settings", allowlist: ["https://app.example"] },
      transcriptPath: `/r/adversarial-${stamp}.transcript.json`,
      engine: { version: "0.1.0", commit: "abc1234", builtAt: "2026-09-24T00:00:00Z" },
      defects,
      hangs: [],
      advisories: [],
      ...extra,
    },
  });
  if (run === null) throw new Error("not a run");
  return run;
}

const http503 = (fp: string, related: string[] = [fp], occurrences = 1) => ({
  fingerprint: fp,
  related,
  kind: "http-5xx",
  title: "HTTP 503 from /api/items/:id",
  route: "/settings",
  url: "https://app.example/settings",
  signals: [{ kind: "http-5xx", detail: "503", url: "https://app.example/api/items/42", status: 503 }],
  occurrences,
  occurrenceSteps: [3, 7].slice(0, occurrences),
  repro: { steps: [{ step: 3, target: 'button "Save"' }], recordingStepIndex: 2 },
});

describe("finding identity", () => {
  it("is the engine fingerprint when there is one, else signal + route template + control + request", () => {
    const a = findingKey({ category: "defect", signal: "http-5xx", fingerprint: "f1", route: "/a" });
    const b = findingKey({ category: "defect", signal: "http-5xx", fingerprint: "f1", route: "/b" });
    expect(a).toBe(b); // the fingerprint already folds the route in; a hang by element spans routes
    expect(a).toMatch(/^defect:[0-9a-f]{12}$/);
    const ux = { category: "ux", signal: "labels-clear", route: "/items/:id", control: 'button "Go"' } as const;
    expect(identityBasis(ux)).toBe('id|ux|labels-clear|/items/:id|button "Go"|');
    expect(findingKey(ux)).not.toBe(findingKey({ ...ux, control: 'button "Stop"' }));
  });

  it("reads a defect's route, control, request, evidence and reproduction command", () => {
    const run = adversarial("2026-09-24T10-00-00-000Z", [http503("fp503")]);
    expect(run).toMatchObject({ mode: "adversarial", target: "https://app.example", startedAt: "2026-09-24T10:00:00.000Z" });
    const o = run.observations[0];
    expect(o?.identity).toEqual({
      category: "defect",
      signal: "http-5xx",
      fingerprint: "fp503",
      route: "/settings",
      control: 'button "Save"',
      request: "503 /api/items/:id",
    });
    expect(o?.severity).toBe("hard");
    expect(o?.evidence[0]).toMatchObject({ step: 3, request: "https://app.example/api/items/42" });
    expect(o?.reproduce).toBe("jevitate verify-fix --result /r/adversarial-2026-09-24T10-00-00-000Z.result.json --fingerprint fp503");
  });

  it("stamp parsing reverses the artifact stamp", () => {
    expect(stampToIso("coverage-2026-01-02T03-04-05-006Z")).toBe("2026-01-02T03:04:05.006Z");
    expect(stampToIso("no-stamp")).toBeUndefined();
  });
});

describe("consolidate (#139)", () => {
  it("dedupes one defect across runs and modes, with per-mode run counts and occurrences", () => {
    const r1 = adversarial("2026-09-24T10-00-00-000Z", [http503("fp503", ["fp503"], 2)]);
    const r2 = adversarial("2026-09-24T11-00-00-000Z", [http503("fp503")]);
    const goal = runFromMissionResult("/r/explore-2026-09-24T12-00-00-000Z.result.json", {
      missionOutcome: "hang",
      exitCode: 3,
      result: {
        outcome: "hang",
        target: { seedUrl: "https://app.example/", allowlist: [] },
        checks: [],
        hangs: [
          {
            fingerprint: "hang1",
            kind: "hang",
            hangKind: "request-pending",
            title: "Hang",
            route: "/",
            url: "https://app.example/",
            signal: { kind: "request-pending", pending: [{ endpoint: "/api/slow", url: "https://app.example/api/slow", ageMs: 9000 }] },
            occurrences: 1,
            occurrenceSteps: [4],
            reproduction: { status: "intermittent" },
          },
        ],
      },
    });
    if (goal === null) throw new Error("goal run not read");
    const defects = consolidate([r1, r2, goal]);
    expect(defects).toHaveLength(2);
    const d503 = defects.find((d) => d.category === "defect");
    expect(d503?.runCount).toBe(2);
    expect(d503?.occurrences).toBe(3);
    expect(d503?.modes).toEqual([
      expect.objectContaining({ mode: "adversarial", occurrences: 3, runs: [expect.objectContaining({ occurrences: 2 }), expect.objectContaining({ occurrences: 1 })] }),
    ]);
    // The newest run's reproduction command is the one listed.
    expect(d503?.reproduce).toContain("adversarial-2026-09-24T11-00-00-000Z.result.json");
    const hang = defects.find((d) => d.category === "hang");
    expect(hang?.intermittent).toBe(true);
    expect(hang?.identity.request).toBe("pending /api/slow");
  });

  it("merges observations whose fingerprint cascades overlap (the 503 in one run, its page error in another)", () => {
    const a = adversarial("2026-09-24T10-00-00-000Z", [http503("fp503", ["fp503", "fpEcho"])]);
    const b = adversarial("2026-09-24T11-00-00-000Z", [
      { ...http503("fpPageErr", ["fpPageErr", "fp503"]), kind: "page-error", signals: [] },
    ]);
    const defects = consolidate([a, b]);
    expect(defects).toHaveLength(1);
    expect(defects[0]?.keys).toHaveLength(2);
    expect(defects[0]?.fingerprints).toEqual(["fp503", "fpEcho", "fpPageErr"]);
    // Deterministic: the same observations in another order yield the same key.
    expect(consolidate([b, a])[0]?.key).toBe(defects[0]?.key);
  });

  it("keeps advisory findings apart from defects and never counts a crashed goal's checks", () => {
    const withAdvisory = adversarial("2026-09-24T10-00-00-000Z", [], {
      advisories: [{ fingerprint: "adv1", kind: "console-error", title: "c", route: "/x", url: "u", status: 403, occurrenceSteps: [1] }],
    });
    const crashed = runFromMissionResult("/r/explore-2026-09-24T10-00-00-000Z.result.json", {
      missionOutcome: "crashed",
      exitCode: 2,
      result: { outcome: "crashed", target: { seedUrl: "https://app.example/" }, checks: [{ check: "urlIncludes:/done", passed: false }] },
    });
    const failed = runFromMissionResult("/r/explore-2026-09-24T11-00-00-000Z.result.json", {
      missionOutcome: "exhausted",
      exitCode: 1,
      result: { outcome: "exhausted", target: { seedUrl: "https://app.example/" }, checks: [{ check: "urlIncludes:/done", passed: false, detail: "at /" }] },
    });
    expect(crashed?.observations).toEqual([]);
    const defects = consolidate([withAdvisory, ...(failed === null ? [] : [failed])]);
    expect(defects.map((d) => [d.category, d.severity])).toEqual([
      ["goal-check", "hard"],
      ["advisory", "advisory"],
    ]);
  });

  it("reads a usability report's findings as advisory ux findings", () => {
    const run = runFromUxReport(
      "/u/usability-2026-09-24T10-00-00-000Z.json",
      {
        headline: "1 finding",
        findings: [
          { rubricItemId: "signal-internal-id", route: "/decisions/:id", controls: [], screenIds: ["s1", "s2"], occurrences: 2, observation: "uuid shown" },
        ],
      },
      { site: "https://app.example", screenshotDir: "/u/usability-2026-09-24T10-00-00-000Z.screens" },
    );
    expect(run).toMatchObject({ mode: "usability", target: "https://app.example" });
    expect(run?.observations[0]).toMatchObject({
      severity: "advisory",
      identity: { category: "ux", signal: "signal-internal-id", route: "/decisions/:id" },
      evidence: [{ screen: "s1" }, { screen: "s2" }],
    });
  });

  it("refuses to read what is not a mission result", () => {
    expect(runFromMissionResult("/r/explore-x.json", { version: "1.0.0", site: "x", pages: [] })).toBeNull();
    expect(runFromMissionResult("/r/unknown-x.result.json", { missionOutcome: "clean", exitCode: 0, result: {} })).toBeNull();
  });
});
