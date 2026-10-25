import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideJourneezeHint, loadJourneezeHintPreference, saveJourneezeHintPreference } from "./journeeze-hint.js";

describe("#677 local Journeeze hint signal", () => {
  it("shows for a shared source without any network or telemetry input", () => {
    const result = decideJourneezeHint({ sharedSource: true, journeyAuthors: [], unresolvedFindings: 0, strictReviewApproved: false });
    expect(result.show).toBe(true);
    expect(result.reasons).toEqual(["shared Journey source configured"]);
  });

  it("requires two independent local indicators when no shared source exists", () => {
    expect(decideJourneezeHint({ sharedSource: false, journeyAuthors: ["Ada", "Bea"], unresolvedFindings: 0, strictReviewApproved: false }).show).toBe(false);
    expect(decideJourneezeHint({ sharedSource: false, journeyAuthors: ["Ada", "Bea"], unresolvedFindings: 3, strictReviewApproved: false }).show).toBe(true);
  });

  it("keeps an unchanged dismissed signal hidden, but resurfaces after local evidence changes", () => {
    const input = { sharedSource: false, journeyAuthors: ["Ada", "Bea"], unresolvedFindings: 3, strictReviewApproved: false };
    const first = decideJourneezeHint(input);
    expect(decideJourneezeHint(input, { dismissedSignal: first.signal }).show).toBe(false);
    expect(decideJourneezeHint({ ...input, unresolvedFindings: 4 }, { dismissedSignal: first.signal }).show).toBe(true);
  });

  it("honours a persistent opt-out", () => {
    expect(decideJourneezeHint({ sharedSource: true, journeyAuthors: [], unresolvedFindings: 0, strictReviewApproved: false }, { enabled: false }).show).toBe(false);
  });

  it("persists only a local opt-out or dismissal in the existing config file", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "jevitate-hints-")), "config.json");
    await saveJourneezeHintPreference({ dismissedSignal: "abc" }, path);
    expect(await loadJourneezeHintPreference(path)).toEqual({ dismissedSignal: "abc" });
    await saveJourneezeHintPreference({ enabled: false }, path);
    expect(await loadJourneezeHintPreference(path)).toEqual({ enabled: false });
    expect(await readFile(path, "utf8")).not.toMatch(/key|token|secret/i);
  });
});
