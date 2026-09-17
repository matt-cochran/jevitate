import { expect, test } from "vitest";
import { SitePolicySchema } from "./interaction-policy.js";

test("valid policy parses; negative cps rejected", () => {
  const p = { version: "1", interaction: { typing: { charsPerSecond: 6, perKeyJitter: 0.3 } },
    throttles: { write: { minIntervalSeconds: 90, dailyLimit: 10 } } };
  expect(SitePolicySchema.parse(p).version).toBe("1");
  expect(() => SitePolicySchema.parse({ version: "1", interaction: { typing: { charsPerSecond: -1, perKeyJitter: 0.3 } } })).toThrow();
});

test("valid quiet-hours config parses (no regression)", () => {
  const p = {
    version: "1",
    quietHours: { timezone: "America/New_York", windows: [{ start: "20:00", end: "08:00" }] },
  };
  const parsed = SitePolicySchema.parse(p);
  expect(parsed.quietHours?.timezone).toBe("America/New_York");
  expect(parsed.quietHours?.windows).toEqual([{ start: "20:00", end: "08:00" }]);
});

test("malformed quiet-hours window start ('8pm') is rejected by the schema, not silently accepted", () => {
  const p = {
    version: "1",
    quietHours: { timezone: "America/New_York", windows: [{ start: "8pm", end: "08:00" }] },
  };
  expect(() => SitePolicySchema.parse(p)).toThrow();
});

test("invalid IANA timezone is rejected by the schema, not silently accepted", () => {
  const p = {
    version: "1",
    quietHours: { timezone: "Not/A/Real/Zone", windows: [{ start: "20:00", end: "08:00" }] },
  };
  expect(() => SitePolicySchema.parse(p)).toThrow();
});
