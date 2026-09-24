import { describe, expect, it } from "vitest";
import { REDACTION_MASK } from "@jevitate/ai-core";
import { TranscriptLog, type Control, type Snapshot } from "./index.js";

const control: Control = {
  index: 0,
  descriptor: { role: "button", name: "Pay hunter2" },
  stability: "high",
  role: "button",
  name: "Pay hunter2",
  tag: "button",
  inputType: null,
  enabled: true,
  summary: 'button "Pay hunter2"',
};
const snap: Snapshot = {
  url: "https://app.test/checkout?token=abc123&view=1",
  controls: [control],
  truncated: false,
  signature: "sig-1",
};

describe("TranscriptLog — the shared, redacting decision transcript", () => {
  it("numbers steps from 1 and records perception facts (url, signature, controlCount)", () => {
    const log = new TranscriptLog();
    log.record({ op: "click", control, confidence: 0.8, chosenBy: "model", actOk: true, snapshot: snap });
    log.record({ op: null, control: null, confidence: null, chosenBy: "strategy", strategy: "repeat-rapid", actOk: false, reason: "no action", snapshot: snap });
    const [a, b] = log.entries();
    expect(a).toMatchObject({ step: 1, op: "click", confidence: 0.8, chosenBy: "model", actOk: true, signature: "sig-1", controlCount: 1 });
    expect(a).not.toHaveProperty("reason");
    expect(a).not.toHaveProperty("strategy");
    expect(b).toMatchObject({ step: 2, op: null, target: null, confidence: null, strategy: "repeat-rapid", reason: "no action" });
    expect(log.nextStep).toBe(3);
  });

  it("redacts registered secrets and sensitive URL params out of every page-derived string", () => {
    const log = new TranscriptLog(["hunter2"]);
    const e = log.record({
      op: "click",
      control,
      confidence: 0.9,
      chosenBy: "model",
      actOk: false,
      reason: "click failed near hunter2",
      snapshot: snap,
      judgments: { looksBroken: { value: false, probability: 0.1 } },
    });
    const bytes = JSON.stringify(e);
    expect(bytes).not.toContain("hunter2");
    expect(bytes).not.toContain("abc123");
    expect(e.target).toContain(REDACTION_MASK);
    expect(e.url).toContain(`token=${REDACTION_MASK}`);
    expect(e.judgments).toEqual({ looksBroken: { value: false, probability: 0.1 } });
  });

  it("entries() is a copy — callers cannot rewrite history", () => {
    const log = new TranscriptLog();
    log.record({ op: "wait", control: null, confidence: 0.5, chosenBy: "model", actOk: true, snapshot: snap });
    log.entries().pop();
    expect(log.entries()).toHaveLength(1);
  });
});
