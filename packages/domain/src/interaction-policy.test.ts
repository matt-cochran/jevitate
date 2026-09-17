import { expect, test } from "vitest";
import { SitePolicySchema } from "./interaction-policy.js";

test("valid policy parses; negative cps rejected", () => {
  const p = { version: "1", interaction: { typing: { charsPerSecond: 6, perKeyJitter: 0.3 } },
    throttles: { write: { minIntervalSeconds: 90, dailyLimit: 10 } } };
  expect(SitePolicySchema.parse(p).version).toBe("1");
  expect(() => SitePolicySchema.parse({ version: "1", interaction: { typing: { charsPerSecond: -1, perKeyJitter: 0.3 } } })).toThrow();
});
