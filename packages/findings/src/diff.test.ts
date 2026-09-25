import { describe, expect, it } from "vitest";
import { classify, diffRuns } from "./diff.js";
import { runFromMissionResult, type FindingObservation, type RunRecord } from "./extract.js";
import { findingKey, type FindingIdentity, type RunMode } from "./identity.js";

function obs(signal: string, extra: Partial<FindingObservation> = {}): FindingObservation {
  const identity: FindingIdentity = { category: "defect", signal, fingerprint: `fp-${signal}` };
  return { key: findingKey(identity), identity, title: signal, severity: "hard", related: [`fp-${signal}`], occurrences: 1, evidence: [], ...extra };
}

function run(runId: string, observations: FindingObservation[], mode: RunMode = "adversarial"): RunRecord {
  return { runId, mode, path: `/r/${runId}.result.json`, observations };
}

describe("classify (#138, #171)", () => {
  it("is the pure rule over both sides", () => {
    expect(classify({ seen: 0, of: 1 }, { seen: 1, of: 1 }, false)).toBe("new");
    expect(classify({ seen: 1, of: 1 }, { seen: 0, of: 1 }, false)).toBe("resolved");
    expect(classify({ seen: 1, of: 1 }, { seen: 1, of: 1 }, false)).toBe("still-present");
    expect(classify({ seen: 1, of: 3 }, { seen: 0, of: 1 }, false)).toBe("flaky"); // never "resolved" off a 1/3 baseline and one rerun
    expect(classify({ seen: 1, of: 3 }, { seen: 0, of: 3 }, false)).toBe("resolved"); // three reruns would have shown it once
    expect(classify({ seen: 1, of: 2 }, { seen: 1, of: 1 }, false)).toBe("flaky");
    expect(classify({ seen: 1, of: 1 }, { seen: 1, of: 1 }, true)).toBe("flaky"); // the run itself saw it come and go
    expect(classify({ seen: 1, of: 1 }, { seen: 0, of: 0 }, false)).toBe("not-rerun");
  });

  it("calls a finding in no comparable baseline run new, however often it recurs (#171)", () => {
    expect(classify({ seen: 0, of: 1 }, { seen: 1, of: 2 }, false)).toBe("new");
    expect(classify({ seen: 0, of: 0 }, { seen: 1, of: 3 }, true)).toBe("new");
  });
});

describe("diffRuns (#138)", () => {
  it("classifies new, resolved and still-present findings across two runs by finding identity", () => {
    const a = run("adversarial-A", [obs("fixed"), obs("kept")]);
    const b = run("adversarial-B", [obs("kept"), obs("fresh")]);
    const d = diffRuns([a], [b]);
    const status = Object.fromEntries(d.entries.map((e) => [e.defect.identity.signal, e.status]));
    expect(status).toEqual({ fixed: "resolved", kept: "still-present", fresh: "new" });
    expect(d.summary).toEqual({ new: 1, resolved: 1, "still-present": 1, flaky: 0, "not-rerun": 0 });
    expect(d.entries.find((e) => e.status === "new")?.inBaseline).toBe(false);
  });

  it("marks a finding seen in only some runs of a side flaky, and keeps inBaseline for the gate", () => {
    const base = [run("adversarial-1", [obs("sometimes")]), run("adversarial-2", []), run("adversarial-3", [obs("sometimes")])];
    const cur = [run("adversarial-4", [obs("sometimes"), obs("newflaky")]), run("adversarial-5", [obs("sometimes")])];
    const d = diffRuns(base, cur);
    const sometimes = d.entries.find((e) => e.defect.identity.signal === "sometimes");
    expect(sometimes).toMatchObject({ status: "flaky", baseline: { seen: 2, of: 3 }, current: { seen: 2, of: 2 }, inBaseline: true });
    // #171: not in the baseline at all ⇒ new, with its recurrence ratio beside it.
    const newflaky = d.entries.find((e) => e.defect.identity.signal === "newflaky");
    expect(newflaky).toMatchObject({ status: "new", inBaseline: false, current: { seen: 1, of: 2 } });
  });

  it("only counts runs of the modes that observed a finding (a goal run's silence is not a fix)", () => {
    const base = [run("adversarial-1", [obs("x")])];
    const cur = [run("explore-2", [], "goal"), run("adversarial-3", [obs("x")])];
    const e = diffRuns(base, cur).entries[0];
    expect(e).toMatchObject({ status: "still-present", current: { seen: 1, of: 1 } });
    // With no comparable current run at all, a baseline finding is never "resolved": nothing re-tested it.
    const onlyGoal = diffRuns(base, [run("explore-4", [], "goal")]).entries[0];
    expect(onlyGoal).toMatchObject({ status: "not-rerun", current: { seen: 0, of: 0 } });
  });

  it("counts a run given on both sides only as current", () => {
    const r = run("adversarial-1", [obs("x")]);
    const d = diffRuns([r], [r]);
    expect(d.baselineRuns).toEqual([]);
    expect(d.entries[0]?.status).toBe("new");
  });
});

// ── #171: realistic run sets (Preveti rounds 2 → 3), read through the real result extractor ──────

const APP = "http://127.0.0.1:5195";
const API = "http://127.0.0.1:18585";
let seq = 0;

function stamp(day: string): string {
  seq += 1;
  return `2026-09-${day}T10-00-${String(seq % 60).padStart(2, "0")}-000Z`;
}

function adversarialRun(day: string, seedPath: string, defects: unknown[]): RunRecord {
  const path = `/runs/r${day}/adversarial-${stamp(day)}.result.json`;
  const r = runFromMissionResult(path, {
    missionOutcome: defects.length > 0 ? "defects-found" : "clean",
    exitCode: defects.length > 0 ? 1 : 0,
    result: {
      target: { seedUrl: `${APP}${seedPath}`, allowlist: [APP, API] },
      scope: { routeGlobs: [seedPath, `${seedPath}/`, `${seedPath}/**`], outOfScopeSteps: 0, departures: [], resets: 0 },
      transcript: [{ step: 1, url: `${APP}${seedPath}` }],
      defects,
      hangs: [],
      advisories: [],
    },
  });
  if (r === null) throw new Error("not a run");
  return r;
}

function goalRun(day: string, seedPath: string, goal: string, failedCheck?: string): RunRecord {
  const path = `/runs/r${day}/explore-${stamp(day)}.result.json`;
  const r = runFromMissionResult(path, {
    missionOutcome: failedCheck === undefined ? "clean" : "defects-found",
    exitCode: failedCheck === undefined ? 0 : 1,
    result: {
      outcome: failedCheck === undefined ? "succeeded" : "exhausted",
      checks: failedCheck === undefined ? [] : [{ check: failedCheck, passed: false, detail: "matched nothing" }],
      target: { seedUrl: `${APP}${seedPath}`, allowlist: [APP, API] },
      recording: { version: 1, site: APP, intent: goal, pages: [] },
      transcript: [{ step: 1, url: `${APP}${seedPath}` }],
      finalUrl: `${APP}${seedPath}`,
      defects: [],
      hangs: [],
    },
  });
  if (r === null) throw new Error("not a run");
  return r;
}

const rawUuid = {
  kind: "invariant",
  fingerprint: "3188d665ab52",
  title: "Admin page shows a raw uuid",
  route: "/admin/plan-applications",
  url: `${APP}/admin/plan-applications`,
  invariant: { id: "admin-no-raw-uuid" },
};
const nulByte500 = {
  kind: "http-5xx",
  fingerprint: "5a1b2c3d4e5f6a7b",
  title: "HTTP 500 from /v1/admin/design-partners/:id/interactions",
  route: "/admin/design-partners",
  url: `${APP}/admin/design-partners`,
  signals: [{ kind: "http-5xx", status: 500, url: `${API}/v1/admin/design-partners/%00invalid%00/interactions` }],
};

describe("diffRuns comparability (#171)", () => {
  // Round 2: many goal runs (different goals), adversarial runs on several scopes.
  const baseline = [
    adversarialRun("23", "/admin/plan-applications", [rawUuid]),
    adversarialRun("23", "/admin/plan-applications", [rawUuid]),
    adversarialRun("23", "/admin/design-partners", []),
    adversarialRun("23", "/settings", []),
    goalRun("23", "/settings", "Find the current plan status on the Settings page.", "visible:testId=plan-program-status"),
    goalRun("23", "/decisions", "Approve the 'Raise Pro' bet."),
    goalRun("23", "/research", "Open the latest research note.", "textIncludes:testId=note|Pricing"),
    ...["/home", "/workspace", "/proposals", "/inbox", "/team"].map((p, i) => goalRun("23", p, `Other goal ${i}`)),
  ];
  // Round 3: the uuid bug is fixed; one of three adversarial scopes hits a new 500.
  const current = [
    adversarialRun("24", "/admin/plan-applications", []),
    adversarialRun("24", "/admin/design-partners", [nulByte500]),
    adversarialRun("24", "/settings", []),
    goalRun("24", "/settings", "Find the current plan status on the Settings page."),
    goalRun("24", "/decisions", "Approve the 'Raise Pro' bet."),
    ...["/home", "/workspace"].map((p, i) => goalRun("24", p, `Other goal ${i}`)),
  ];
  const d = diffRuns(baseline, current);
  const byTitle = (s: string) => d.entries.find((e) => e.defect.title.includes(s));

  it("a fixed defect seen in its comparable baseline runs is resolved, not flaky", () => {
    // Mode-only comparability made this 2/4 → 0/3 "flaky"; only the admin scope could see it.
    expect(byTitle("raw uuid")).toMatchObject({ status: "resolved", baseline: { seen: 2, of: 2 }, current: { seen: 0, of: 1 } });
  });

  it("a defect in no baseline run is new, even when it recurs in only some current runs", () => {
    expect(byTitle("HTTP 500")).toMatchObject({ status: "new", inBaseline: false, baseline: { seen: 0, of: 1 }, current: { seen: 1, of: 1 } });
  });

  it("a goal check compares only with runs of the same goal", () => {
    // Was 1/9 → 0/4 "flaky": the other goal runs had different goals.
    expect(byTitle("plan-program-status")).toMatchObject({ status: "resolved", baseline: { seen: 1, of: 1 }, current: { seen: 0, of: 1 } });
    // Its goal was not re-run: nothing re-tested it.
    expect(byTitle("research note") ?? byTitle("testId=note")).toMatchObject({ status: "not-rerun", current: { seen: 0, of: 0 } });
  });

  it("classifies the whole set without a single flaky", () => {
    expect(d.summary).toEqual({ new: 1, resolved: 2, "still-present": 0, flaky: 0, "not-rerun": 1 });
  });

  it("the same pair diffed alone agrees with the set (diff of the two admin adversarial runs)", () => {
    const pair = diffRuns([adversarialRun("23", "/admin/plan-applications", [rawUuid])], [adversarialRun("24", "/admin/plan-applications", [])]);
    expect(pair.entries.map((e) => e.status)).toEqual(["resolved"]);
  });

  it("an adversarial run on another scope is not evidence (a different target neither)", () => {
    const other = diffRuns([adversarialRun("23", "/admin/plan-applications", [rawUuid])], [adversarialRun("24", "/settings", [])]);
    expect(other.entries[0]).toMatchObject({ status: "not-rerun", current: { seen: 0, of: 0 } });
    const elsewhere = { ...adversarialRun("24", "/admin/plan-applications", []), target: "http://127.0.0.1:9999" };
    expect(diffRuns([adversarialRun("23", "/admin/plan-applications", [rawUuid])], [elsewhere]).entries[0]?.status).toBe("not-rerun");
  });

  it("a run that never reached the finding's route is not evidence", () => {
    const base = [goalRun("23", "/settings", "Change the plan", "visible:testId=plan")];
    const early: RunRecord = { ...goalRun("24", "/settings", "Change the plan"), scope: { settings: base[0]!.scope!.settings, routes: ["/login"] } };
    expect(diffRuns(base, [early]).entries[0]).toMatchObject({ status: "not-rerun" });
  });
});
