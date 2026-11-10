import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { verifyJourneyMutations } from "./journey-verify.js";
import type { runJourneyProgrammatically } from "./journey-api.js";

const journey: Journey = {
  metadata: { id: "failure-phase", name: "Failure phase", params: [], promoted: false, createdAtIso: "2026-11-06T00:00:00Z" },
  recording: { version: "1", site: "http://fixture.test", pages: [{ url: "/", steps: [
    { step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } },
    { step: { kind: "click", target: { role: "button", name: "postcondition failed" }, expect: { kind: "textIncludes", target: { css: "#saved" }, text: "Saved" } },
      delta: { verdict: "relevant-change", why: "saved", changes: [], requests: ["POST /save → 200"], overheadMs: 0 },
      expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/save", status: { class: 2 } }] },
  ] }] },
};

describe("mutation failure phase is structured evidence", () => {
  it.each([undefined, "action"] as const)("does not parse misleading target prose when phase is %s", async (failurePhase) => {
    const dir = await mkdtemp(join(tmpdir(), "jev-failure-phase-"));
    try {
      await new FsJourneyStore(dir).put(journey);
      let calls = 0;
      const run: typeof runJourneyProgrammatically = async (_opts, mutation = {}) => {
        if (calls++ === 0) return { outcome: "ok", output: null };
        return {
          outcome: "quarantined", at: 1, reason: "step 2 failed: missing button 'postcondition failed'",
          ...(failurePhase === undefined ? {} : { failurePhase }),
          outcomeFailures: [{ where: "step-request", step: 2, checkIndex: 0, evaluated: true, detail: "no matching response" }],
          ...(mutation.blockWritesAtStep === undefined ? {} : { blockedWrites: [{ method: "POST", path: "/save" }] }),
        };
      };
      const report = await verifyJourneyMutations({ dir, id: journey.metadata.id }, run);
      expect(report.assertions.find((a) => a.site === "step-request:2:0")).toMatchObject({ verdict: "cascade" });
      expect(report.mutations.find((m) => m.id === "block-write:2")?.failedSites).toContainEqual({ where: "step", step: 2, postcondition: false });
      expect(report.verdict).toBe("inconclusive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
