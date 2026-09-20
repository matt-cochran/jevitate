import { expect, test, vi } from "vitest";
import type { Recording } from "@jevitate/recording";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { authorJourney } from "./author-journey.js";

const { recording } = vi.hoisted(() => ({
  recording: {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/x", steps: [{ step: { kind: "navigate", url: "/x", expect: { kind: "visible", target: { testId: "ok" } } } }] }],
  } as Recording,
}));

vi.mock("../missions/goal-based.js", () => ({
  runGoalBasedMission: vi.fn(async () => ({
    outcome: "succeeded",
    assertionPassed: true,
    recording,
    transcript: [],
    finalUrl: "https://example.test/x",
    run: {},
  })),
}));

const judgment: JudgmentPort = { systemOne: vi.fn(async () => ({})) } as unknown as JudgmentPort;
const generation: GenerationPort = {
  generate: vi.fn(async () => ({ output: { text: "" }, provenance: { model: "fake", tookMs: 0 } })),
} as unknown as GenerationPort;

const baseReq = {
  goal: "g",
  successAssertion: { kind: "visible", target: { testId: "ok" } } as const,
  allowlist: ["https://example.test"],
  startUrl: "https://example.test/x",
  actor: {} as never,
  judgment,
  generation,
  journeyId: "j",
  journeyName: "J",
};

test("#1 never auto-promoted: metadata.promoted is always false", async () => {
  const result = await authorJourney({ ...baseReq, takes: 1 });
  expect(result.outcome).toBe("authored");
  if (result.outcome === "authored") expect(result.journey.metadata.promoted).toBe(false);
});

test("#2 independent oracle preserved: a discovery mission outcome other than 'succeeded' never authors a journey", async () => {
  const { runGoalBasedMission } = await import("../missions/goal-based.js");
  (runGoalBasedMission as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    outcome: "exhausted",
    assertionPassed: false,
    recording,
    transcript: [],
    finalUrl: "https://example.test/x",
    run: {},
  });
  const result = await authorJourney({ ...baseReq, takes: 1 });
  expect(result.outcome).toBe("not-reached");
});

test("#4 rejects an invalid takes count rather than silently defaulting", async () => {
  await expect(authorJourney({ ...baseReq, takes: 0 })).rejects.toThrow(/takes must be/);
});
