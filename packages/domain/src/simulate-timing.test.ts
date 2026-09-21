import { expect, test } from "vitest";
import { simulateTiming } from "./simulate-timing.js";
test("simulateTiming is deterministic and sums step delays", () => {
  const policy = { typing: { charsPerSecond: 5, perKeyJitter: 0 }, thinkBeforeActionMs: { mean: 300, sd: 0, min: 300, max: 300 }, readingMsPerChar: 50, maxReadingMs: 10000 };
  const script = [{ kind: "read", label: "inbox", chars: 100 }, { kind: "type", label: "reply", text: "hello" }, { kind: "click", label: "send" }] as const;
  const a = simulateTiming(policy, 123, script as any); const b = simulateTiming(policy, 123, script as any);
  expect(a).toEqual(b);
  expect(a.totalMs).toBe(a.steps.reduce((n, s) => n + s.delayMs, 0));
  expect(a.steps[0].delayMs).toBe(100 * 50); // reading dwell
});
