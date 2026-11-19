import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Answer, JudgmentPort, JudgmentState, Question } from "@jevitate/ai-core";
import type { GuidanceClaim } from "@jevitate/journey";
import { claimVerdictFields, evaluateClaims, evidenceFromTranscript, saveClaimVerdicts, type ClaimEvidence } from "./explore-job-claims.js";

/** #874 — every guidance claim gets exactly one verdict after a `--job-context` run, with its basis. */

const CHECK = { version: 1 as const, at: "/team", check: "textIncludes:role=table|Pending" };
const checked: GuidanceClaim = { id: "invite-pending", statement: "a new invite shows as Pending", check: CHECK };
const unchecked: GuidanceClaim = { id: "one-seat", statement: "an invite uses one free seat" };
const evidence: ClaimEvidence = { urls: ["http://127.0.0.1:3000/team"], controls: ['button "Invite"', 'textbox "Email"'] };

/** A judge that answers every question with `value` and records what it was asked. */
function judgeAnswering(value: string): JudgmentPort & { asked: { state: JudgmentState; questions: Record<string, Question> }[] } {
  const asked: { state: JudgmentState; questions: Record<string, Question> }[] = [];
  return {
    asked,
    systemOne: async (args) => {
      asked.push(args);
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "choice", value, confidence: 0.9 };
      return out;
    },
  };
}
const readAs = (value: boolean | null) => async () => value;

describe("evaluateClaims — a claim with its own check is decided by code", () => {
  it("a check that reads true confirms the claim", async () => {
    const [r] = await evaluateClaims([checked], { readCheck: readAs(true), evidence: null });
    expect(r).toMatchObject({ id: "invite-pending", verdict: "confirmed", basis: "check" });
  });

  it("a check that reads false contradicts the claim", async () => {
    const [r] = await evaluateClaims([checked], { readCheck: readAs(false), evidence: null });
    expect(r).toMatchObject({ verdict: "contradicted", basis: "check" });
  });

  it("a check that cannot be read leaves the claim not observed", async () => {
    const [r] = await evaluateClaims([checked], { readCheck: readAs(null), evidence: null });
    expect(r).toMatchObject({ verdict: "not_observed", basis: "check" });
  });

  it("a checked claim never asks the model", async () => {
    const judge = judgeAnswering("contradicted");
    await evaluateClaims([checked], { readCheck: readAs(true), judge, evidence });
    expect(judge.asked).toHaveLength(0);
  });
});

describe("evaluateClaims — a claim without a check", () => {
  it("with no evidence is not observed, and no model is asked", async () => {
    const judge = judgeAnswering("confirmed");
    const [r] = await evaluateClaims([unchecked], { readCheck: readAs(true), judge, evidence: null });
    expect(r).toMatchObject({ verdict: "not_observed", basis: "no-evidence" });
  });

  it("with evidence takes the model's verdict, labelled as a model judgment", async () => {
    const [r] = await evaluateClaims([unchecked], { readCheck: readAs(true), judge: judgeAnswering("contradicted"), evidence });
    expect(r).toMatchObject({ verdict: "contradicted", basis: "model" });
  });

  it("the model is asked to check the claim against what the run observed", async () => {
    const judge = judgeAnswering("confirmed");
    await evaluateClaims([unchecked], { readCheck: readAs(true), judge, evidence });
    expect(judge.asked[0]?.state.visibleText).toContain('button "Invite"');
  });

  it("the model sees the claim as a statement to check, not as fact", async () => {
    const judge = judgeAnswering("confirmed");
    await evaluateClaims([unchecked], { readCheck: readAs(true), judge, evidence });
    expect(judge.asked[0]?.state.visibleText).toContain("CLAIM TO CHECK: an invite uses one free seat");
  });

  it("a model answer outside the three verdicts is not observed, not trusted", async () => {
    const [r] = await evaluateClaims([unchecked], { readCheck: readAs(true), judge: judgeAnswering("maybe"), evidence });
    expect(r).toMatchObject({ verdict: "not_observed", basis: "model" });
  });

  it("a model failure is recorded as such, never silently", async () => {
    const failing: JudgmentPort = { systemOne: async () => { throw new Error("judgment API 503"); } };
    const [r] = await evaluateClaims([unchecked], { readCheck: readAs(true), judge: failing, evidence });
    expect(r).toMatchObject({ verdict: "not_observed", basis: "model-error", reason: "judgment API 503" });
  });

  it("without a judge (no model allowed) it is not observed", async () => {
    const [r] = await evaluateClaims([unchecked], { readCheck: readAs(true), evidence });
    expect(r).toMatchObject({ verdict: "not_observed", basis: "no-evidence" });
  });
});

describe("evaluateClaims — completeness", () => {
  it("every claim gets exactly one verdict, in order", async () => {
    const claims = [checked, unchecked, { id: "c3", statement: "s3" }];
    const results = await evaluateClaims(claims, { readCheck: readAs(true), evidence: null });
    expect(results.map((r) => r.id)).toEqual(["invite-pending", "one-seat", "c3"]);
  });
});

describe("evidenceFromTranscript", () => {
  const entry = (url: string, controls: string[]) => ({ url, controls });

  it("keeps each page URL once, in order", () => {
    const e = evidenceFromTranscript([entry("http://a/1", []), entry("http://a/2", []), entry("http://a/1", [])]);
    expect(e?.urls).toEqual(["http://a/1", "http://a/2"]);
  });

  it("keeps each control once", () => {
    const e = evidenceFromTranscript([entry("http://a/1", ['button "Save"']), entry("http://a/2", ['button "Save"', 'link "Home"'])]);
    expect(e?.controls).toEqual(['button "Save"', 'link "Home"']);
  });

  it("an empty transcript is no evidence", () => {
    expect(evidenceFromTranscript([])).toBeNull();
  });
});

describe("saveClaimVerdicts — the saved result gets the envelope's claim-verdict fields", () => {
  const saved = { missionOutcome: "clean", exitCode: 0, result: { schemaVersion: 1, strategy: "goal", missionOutcome: "clean", exitCode: 0, resultPath: "x" } };
  const fields = claimVerdictFields({ jobId: "invite", contentHash: "a".repeat(64) }, [{ id: "one-seat", statement: "an invite uses one free seat", verdict: "confirmed", basis: "check" }]);
  const withFile = (fn: (path: string, dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "jev-save-claims-"));
    try {
      const path = join(dir, "explore-1.result.json");
      writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`);
      fn(path, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("adds jobContext and claims to the saved result, keeping every other field", () => {
    withFile((path) => {
      saveClaimVerdicts(path, fields);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...saved, result: { ...saved.result, ...fields } });
    });
  });

  it("keeps the journal's formatting (two-space JSON, trailing newline)", () => {
    withFile((path) => {
      saveClaimVerdicts(path, fields);
      expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify({ ...saved, result: { ...saved.result, ...fields } }, null, 2)}\n`);
    });
  });

  it("writes through a temp file and a rename: no temp file is left behind", () => {
    withFile((path, dir) => {
      saveClaimVerdicts(path, fields);
      expect(readdirSync(dir)).toEqual(["explore-1.result.json"]);
    });
  });

  it("a saved file without a result object is refused, not overwritten", () => {
    withFile((path) => {
      writeFileSync(path, "[]\n");
      expect(() => saveClaimVerdicts(path, fields)).toThrow(/not a saved run result/);
    });
  });
});
