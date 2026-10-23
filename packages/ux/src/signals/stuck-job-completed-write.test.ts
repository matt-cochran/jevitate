import { describe, expect, it } from "vitest";
import { detectStuckJobs, type RunSignalCapture, type SignalRequest, type SignalScreen, type SignalStep } from "../signals.js";

// #641: a 2xx write is not a stuck job when the page showed completion on the same route — even
// when a reusable form keeps offering its start control. A 2xx write whose only follow-up is an
// in-progress indicator (no completion text) stays stuck, exactly as before.

const URL = "http://app.test/compose";

function step(n: number, op: string, over: Partial<SignalStep> = {}): SignalStep {
  return { step: n, op, target: null, actOk: true, url: URL, ...over };
}

function click(n: number, name: string): SignalStep {
  return step(n, "click", { target: `button "${name}"`, descriptor: { role: "button", name } });
}

function write(n: number): SignalRequest {
  return { id: n, method: "POST", endpoint: "POST /api/send", url: "http://app.test/api/send", resourceType: "fetch", startedAt: n * 1000, endedAt: n * 1000 + 50, status: 200, step: n };
}

function screen(index: number, n: number, text: string, over: Partial<SignalScreen> = {}): SignalScreen {
  return { index, step: n, at: n * 1000 + 500, url: URL, signature: `sig-${index}`, visibleText: text, busy: false, ...over };
}

describe("#641 stuck job with a completed write", () => {
  it("reports no stuck job when a 2xx write is followed by newly appeared completion text and Send is still offered", () => {
    const capture: RunSignalCapture = {
      steps: [click(1, "Send"), step(2, "wait"), step(3, "wait")],
      requests: [write(1)],
      screens: [screen(0, 1, "Compose\nSend"), screen(1, 2, "Compose\nSending…\nSend", { busy: true, at: 60_000 }), screen(2, 3, "Compose\nMessage sent\nSend", { at: 100_000 })],
      endedAt: 120_000,
    };
    expect(detectStuckJobs(capture)).toHaveLength(0);
  });

  it("still reports a stuck job when a 2xx write leaves only an in-progress indicator and no completion text", () => {
    const capture: RunSignalCapture = {
      steps: [click(1, "Send"), step(2, "wait"), step(3, "wait")],
      requests: [write(1)],
      screens: [screen(0, 1, "Compose\nSend"), screen(1, 2, "Compose\nSending…\nSend", { busy: true, at: 60_000 }), screen(2, 3, "Compose\nSending…\nSend", { busy: true, at: 100_000 })],
      endedAt: 120_000,
    };
    expect(detectStuckJobs(capture)).toHaveLength(1);
  });

  it("still reports a stuck job when a 'started' line appears but the page stays busy to the end", () => {
    const capture: RunSignalCapture = {
      steps: [click(1, "Send"), step(2, "wait"), step(3, "wait")],
      requests: [write(1)],
      screens: [screen(0, 1, "Compose\nSend"), screen(1, 2, "Compose\nJob started\nSend", { busy: true, at: 60_000 }), screen(2, 3, "Compose\nJob started\nSend", { busy: true, at: 100_000 })],
      endedAt: 120_000,
    };
    expect(detectStuckJobs(capture)).toHaveLength(1);
  });
});
