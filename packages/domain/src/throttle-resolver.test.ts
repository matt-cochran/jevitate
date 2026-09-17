import { expect, test } from "vitest";
import { resolveThrottle } from "./throttle-resolver.js";

test("most-restrictive wins", () => {
  expect(
    resolveThrottle([
      { minIntervalSeconds: 30, dailyLimit: 20 },
      { minIntervalSeconds: 90, dailyLimit: 10, hourlyLimit: 5 },
    ])
  ).toEqual({ minIntervalSeconds: 90, dailyLimit: 10, hourlyLimit: 5 });
  expect(resolveThrottle([])).toEqual({});
});
