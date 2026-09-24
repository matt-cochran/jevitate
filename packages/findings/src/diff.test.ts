import { describe, expect, it } from "vitest";
import { classify, diffRuns } from "./diff.js";
import type { FindingObservation, RunRecord } from "./extract.js";
import { findingKey, type FindingIdentity, type RunMode } from "./identity.js";

function obs(signal: string, extra: Partial<FindingObservation> = {}): FindingObservation {
  const identity: FindingIdentity = { category: "defect", signal, fingerprint: `fp-${signal}` };
  return { key: findingKey(identity), identity, title: signal, severity: "hard", related: [`fp-${signal}`], occurrences: 1, evidence: [], ...extra };
}

function run(runId: string, observations: FindingObservation[], mode: RunMode = "adversarial"): RunRecord {
  return { runId, mode, path: `/r/${runId}.result.json`, observations };
}

describe("classify (#138)", () => {
  it("is the pure rule over both sides", () => {
    expect(classify({ seen: 0, of: 1 }, { seen: 1, of: 1 }, false)).toBe("new");
    expect(classify({ seen: 1, of: 1 }, { seen: 0, of: 1 }, false)).toBe("resolved");
    expect(classify({ seen: 1, of: 1 }, { seen: 1, of: 1 }, false)).toBe("still-present");
    expect(classify({ seen: 1, of: 3 }, { seen: 0, of: 1 }, false)).toBe("flaky"); // never "resolved" off a 1/3 baseline
    expect(classify({ seen: 0, of: 1 }, { seen: 1, of: 2 }, false)).toBe("flaky");
    expect(classify({ seen: 1, of: 1 }, { seen: 1, of: 1 }, true)).toBe("flaky"); // the run itself saw it come and go
    expect(classify({ seen: 1, of: 1 }, { seen: 0, of: 0 }, false)).toBe("not-rerun");
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
    const newflaky = d.entries.find((e) => e.defect.identity.signal === "newflaky");
    expect(newflaky).toMatchObject({ status: "flaky", inBaseline: false, current: { seen: 1, of: 2 } });
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
