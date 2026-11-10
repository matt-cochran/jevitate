import { describe, expect, it } from "vitest";
import { rejudge } from "./adjudicate.js";
import type { DoneReading, Known, RunEvidence } from "./evidence.js";

const known = <T>(value: T): Known<T> => ({ known: true, value });
const writes = () => ({ sent: known(1), answered: known(1), aborted: known(0), openAtClose: known(0), shapes: [] });
const reading = (value: boolean, at: "pre" | "post"): DoneReading => ({ value: known(value), session: "fresh", at, durationMs: 500 });

function base(trust: RunEvidence["run"]["target"]["trust"] = "test"): RunEvidence {
  return {
    schema: "jevitate.evidence",
    version: 1,
    producedAt: "2026-11-08T12:00:00.000Z",
    producer: { jevitate: "0.30.0" },
    subject: { kind: "journey-run", journey: { id: "add-todo", hash: "sha256:abc" }, job: { id: "keep-a-list", hash: "sha256:def" } },
    run: { mode: "test", channel: "cli", target: { origin: "http://127.0.0.1:4173", trust }, paramsDigest: "hmac:1", secretParamNames: [] },
    steps: [
      { index: 1, kind: "navigate", outcome: "ok", postcondition: "none", writes: known(0) },
      { index: 2, kind: "click", outcome: "ok", postcondition: "held", writes: known(1) },
    ],
    writes: writes(),
    judgments: [{ advisory: true, task: "done.grounded", step: 2, probability: 0.97, threshold: 0.8 }],
    notes: [],
  };
}

const fixture = (): RunEvidence => ({
  ...base(),
  doneCheck: { spec: { version: 1, at: "/todos", check: "textIncludes:${title}" }, before: reading(false, "pre"), after: reading(true, "post") },
});

describe("rejudge", () => {
  it("moves nothing under v1 -> v1", () => {
    expect(rejudge(fixture(), "v1", "v1").moved).toEqual([]);
  });
});
