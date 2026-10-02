import { describe, expect, it } from "vitest";
import { MAX_DOCUMENTED_WAIT_MS, documentedWaitMs } from "./status.js";
describe("documentedWaitMs (#258) — the duration page copy says a wait takes", () => {
  it("reads stated durations, the longest of a range, word numbers", () => {
    expect(documentedWaitMs("We're reading it carefully. This usually takes less than a minute…")).toBe(60_000);
    expect(documentedWaitMs("This may take up to 5 minutes.")).toBe(300_000);
    expect(documentedWaitMs("Your report will be ready in 2–3 minutes")).toBe(180_000);
    expect(documentedWaitMs("Hang tight, this takes about 30 seconds")).toBe(30_000);
    expect(documentedWaitMs("Generating usually takes a few minutes")).toBe(300_000);
  });
  it("is null for a line that is not about a wait (a timestamp, no wait words, no duration)", () => {
    expect(documentedWaitMs("Saved about 2 minutes ago")).toBeNull();
    expect(documentedWaitMs("Updated 5 minutes")).toBeNull();
    expect(documentedWaitMs("This usually works")).toBeNull();
  });
  it("is capped", () => {
    expect(documentedWaitMs("This can take up to 12 hours")).toBe(MAX_DOCUMENTED_WAIT_MS);
  });
});
