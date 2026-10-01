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
      // #211: strategy comes from content, never the file name — as the real runner writes it.
      strategy: "adversarial",
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

  it("reads every strategy's server-log defect from defects (#195); a usability one marked advisory stays advisory", () => {
    const serverLog = (advisory: boolean) => ({
      fingerprint: "5e5e5e5e5e5e5e5e",
      related: ["5e5e5e5e5e5e5e5e"],
      kind: "server-log",
      title: "Server error: SaveSettings failed",
      route: "/settings",
      level: "error",
      message: "SaveSettings failed",
      occurrences: 1,
      repro: { recordingStepIndex: 0 },
      ...(advisory ? { advisory: true } : {}),
    });
    const hard = adversarial("2026-09-24T09-00-00-000Z", [serverLog(false)]);
    expect(hard.observations[0]).toMatchObject({ severity: "hard", identity: { category: "defect", signal: "server-log", fingerprint: "5e5e5e5e5e5e5e5e" } });
    const ux = runFromMissionResult("/r/usability-2026-09-24T09-30-00-000Z.recording.result.json", {
      missionOutcome: "clean",
      exitCode: 0,
      result: { strategy: "usability", target: { seedUrl: "https://app.example/settings", allowlist: [] }, defects: [serverLog(true)], hangs: [], recordingPaths: ["/r/u.recording.json"] },
    });
    expect(ux?.observations[0]).toMatchObject({ severity: "advisory", identity: { category: "advisory", fingerprint: "5e5e5e5e5e5e5e5e" } });
  });

  it("#217: a goal run's verdict is canonical and its own ending is goalOutcome — a pre-#217 goal word is folded", () => {
    const seedUrl = "https://app.example/cart";
    const failedCheck = { check: "urlIncludes:/done", passed: false, detail: "url was /cart" };
    const current = runFromMissionResult("/r/explore-2026-09-24T13-00-00-000Z.result.json", {
      missionOutcome: "defects-found",
      exitCode: 1,
      result: { strategy: "goal", missionOutcome: "defects-found", goalOutcome: "failed", outcome: "failed", checks: [failedCheck], target: { seedUrl } },
    });
    expect([current?.missionOutcome, current?.goalOutcome]).toEqual(["defects-found", "failed"]);
    expect(current?.observations.map((o) => o.identity.signal)).toEqual(["goal-check:urlIncludes:/done"]);
    const legacy = runFromMissionResult("/r/explore-2026-09-24T13-00-00-001Z.result.json", {
      missionOutcome: "blocked",
      exitCode: 1,
      result: { outcome: "blocked", checks: [failedCheck], target: { seedUrl } },
    });
    expect([legacy?.missionOutcome, legacy?.goalOutcome]).toEqual(["defects-found", "blocked"]);
  });

  it("#213: a goal run stamped `aiMode: \"fake\"` never yields a hard goal-check finding — the fake judge's own ending is not trusted", () => {
    const seedUrl = "https://app.example/cart";
    const failedCheck = { check: "urlIncludes:/done", passed: false, detail: "url was /cart" };
    const fake = runFromMissionResult("/r/explore-2026-09-24T14-00-00-000Z.result.json", {
      missionOutcome: "defects-found",
      exitCode: 1,
      result: { strategy: "goal", missionOutcome: "defects-found", goalOutcome: "failed", outcome: "failed", checks: [failedCheck], target: { seedUrl }, aiMode: "fake" },
    });
    expect(fake?.observations).toEqual([]);
    // A hard signal the same fake-ai run hit (independent of the judge) still gates: the fake stamp
    // only suppresses the goal's OWN (judgment-driven) ending, never `defects`/`hangs`/invariants.
    const withHardSignal = runFromMissionResult("/r/explore-2026-09-24T14-05-00-000Z.result.json", {
      missionOutcome: "defects-found",
      exitCode: 1,
      result: {
        strategy: "goal",
        missionOutcome: "defects-found",
        goalOutcome: "defects-found",
        outcome: "defects-found",
        checks: [],
        target: { seedUrl },
        aiMode: "fake",
        defects: [{ fingerprint: "fp5xx", related: ["fp5xx"], kind: "http-5xx", title: "HTTP 503", route: "/cart", url: seedUrl, signals: [], occurrences: 1, occurrenceSteps: [1] }],
        hangs: [],
      },
    });
    expect(withHardSignal?.observations.map((o) => [o.identity.category, o.severity])).toEqual([["defect", "hard"]]);
  });

  // #213: a verify-fix "still-reproduces" record's `source` is the ORIGINAL mission's
  // `.result.json` — its evidence must be labeled `result`, never `recording` (that's the
  // Recording file itself, a different artifact entirely).
  it("#213: a still-reproducing verify-fix's evidence is labeled `result`, not `recording`", () => {
    const run = runFromMissionResult("/r/verify-fp503.result.json", {
      mode: "verify-fix",
      missionOutcome: "defects-found",
      exitCode: 1,
      result: {
        mode: "verify-fix",
        verdict: "still-reproduces",
        fingerprint: "fp503",
        source: "/r/adversarial-2026-09-24T10-00-00-000Z.result.json",
        title: "HTTP 503 from /api/items/:id",
        identity: { category: "defect", signal: "http-5xx", route: "/settings", request: "503 /api/items/:id" },
      },
    });
    expect(run?.observations).toHaveLength(1);
    const evidence = run?.observations[0]?.evidence[0];
    expect(evidence).toMatchObject({ result: "/r/adversarial-2026-09-24T10-00-00-000Z.result.json" });
    expect(evidence).not.toHaveProperty("recording");
  });

  it("refuses to read what is not a mission result", () => {
    expect(runFromMissionResult("/r/explore-x.json", { version: "1.0.0", site: "x", pages: [] })).toBeNull();
    expect(runFromMissionResult("/r/unknown-x.result.json", { missionOutcome: "clean", exitCode: 0, result: {} })).toBeNull();
  });
});

describe("#293: journey-anchored runs", () => {
  it("a run's branch point is read, kept per run, and listed once per Journey step on the deduped defect", () => {
    const a = adversarial("2026-10-01T10-00-00-000Z", [http503("fp503")], { branch: { journeyId: "order", step: 3, anchor: "review", stepLabel: "click Next" } });
    const b = adversarial("2026-10-01T11-00-00-000Z", [http503("fp503")], { branch: { journeyId: "order", step: 2 } });
    const c = adversarial("2026-10-01T12-00-00-000Z", [http503("fp503")], { branch: { journeyId: "order", step: 3, anchor: "review" } });
    const plain = adversarial("2026-10-01T13-00-00-000Z", [http503("fp503")]);
    expect(a.branch).toEqual({ journeyId: "order", step: 3, anchor: "review" });
    expect(plain.branch).toBeUndefined();
    const [d] = consolidate([a, b, c, plain]);
    expect(d?.runCount).toBe(4);
    expect(d?.branches).toEqual([
      { journeyId: "order", step: 2 },
      { journeyId: "order", step: 3, anchor: "review" },
    ]);
    expect(d?.modes[0]?.runs.map((r) => r.branch?.step)).toEqual([3, 2, 3, undefined]);
    expect(consolidate([plain])[0]?.branches).toBeUndefined();
  });
});
