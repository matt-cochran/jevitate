import { expect, test } from "vitest";
import { deriveOracleFromTranscript, oracleFromAssertion, appendOracleStep, type MissionTranscriptEntry } from "./oracle.js";
import type { Recording } from "@jevitate/recording";

// #119/#129: jevitate's OWN engine refusals (the repeated-side-effect guard #92, a budget/fail-closed
// cutoff, …) must never become "the" oracle a regression replays — replaying a refusal jevitate would
// issue again regardless of the app can never fail, so it would fabricate an always-passing regression.

test("an engine-refused step (origin: engine) is never chosen as the oracle, even as the last failed actionable step", () => {
  const transcript: MissionTranscriptEntry[] = [
    { op: "click", actOk: true, url: "/x", descriptor: { testId: "save" } },
    {
      op: "click",
      actOk: false,
      reason: 'repeated side effect refused: "Save Preferences" already sent POST /api/v1/tool/profile → 200 on this page and the page does not offer a retry — clicking it again would repeat that action',
      origin: "engine",
      url: "/x",
      descriptor: { testId: "save" },
    },
  ];
  expect(deriveOracleFromTranscript(transcript)).toBeUndefined();
});

test("an engine refusal is excluded by TEXT even without the origin marker (older transcripts)", () => {
  const transcript: MissionTranscriptEntry[] = [
    {
      op: "click",
      actOk: false,
      reason: 'repeated side effect refused: "Save" already sent POST /api/v1/x — clicking it again would repeat that action',
      url: "/x",
      descriptor: { testId: "save" },
    },
  ];
  expect(deriveOracleFromTranscript(transcript)).toBeUndefined();
});

test("an engine refusal falls through to an EARLIER app-caused failed action, when one exists", () => {
  const transcript: MissionTranscriptEntry[] = [
    { op: "click", actOk: false, reason: "target not enabled: \"Pay\" is disabled", url: "/x", descriptor: { testId: "pay" } },
    { op: "click", actOk: true, url: "/x", descriptor: { testId: "save" } },
    {
      op: "click",
      actOk: false,
      reason: 'repeated side effect refused: "Save" already sent POST /api/v1/x — clicking it again would repeat that action',
      origin: "engine",
      url: "/x",
      descriptor: { testId: "save" },
    },
  ];
  const oracle = deriveOracleFromTranscript(transcript);
  expect(oracle?.source).toBe("failed-action");
  expect(oracle && "step" in oracle && "target" in oracle.step ? oracle.step.target : undefined).toEqual({ testId: "pay" });
});

test("an app-caused failed action (target not enabled) IS chosen as the oracle", () => {
  const transcript: MissionTranscriptEntry[] = [
    { op: "click", actOk: false, reason: 'target not enabled: "Pay" is disabled — its label may say what it needs first', url: "/x", descriptor: { testId: "pay" } },
  ];
  const oracle = deriveOracleFromTranscript(transcript);
  expect(oracle?.source).toBe("failed-action");
});

test("oracleFromAssertion + appendOracleStep still produce a replayable assert step (page/reloadThen checks)", () => {
  const recording: Recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/x", steps: [{ step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
  };
  const oracle = oracleFromAssertion({ kind: "valueEquals", target: { testId: "last-name" }, value: "LitmusThree" });
  const { augmented, flatIndex } = appendOracleStep(recording, oracle);
  expect(flatIndex).toBe(1);
  expect(augmented.pages[0]?.steps[1]?.step).toEqual({ kind: "assert", check: { kind: "valueEquals", target: { testId: "last-name" }, value: "LitmusThree" } });
});
