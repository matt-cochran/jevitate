import { expect, test } from "vitest";
import type { Clock } from "./ports.js";

test("a Clock implementation satisfies the port", () => {
  const clock: Clock = { nowIso: () => "2026-09-16T00:00:00Z", monotonicMs: () => 1 };
  expect(clock.nowIso()).toMatch(/^2026/);
  expect(clock.monotonicMs()).toBe(1);
});
