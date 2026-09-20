import { expect, test, vi } from "vitest";
import { safeRunPolicy } from "@jevitate/domain";
import type { Recording } from "@jevitate/recording";
import { JourneyRunner } from "./journey-runner.js";
import type { SelfHealer } from "./self-heal.js";

// §9a invariant #8 refusal contract — a dedicated, standalone file (mirrors
// the repo's slice1-invariants.test.ts pattern). These tests PROVE the
// refusal: a broken write/irreversible step is NEVER auto-healed, even when
// a heal is available, in EITHER hybrid or full mode; and the shipped
// default stays fail-closed.

const baseMetadata = { id: "j", name: "j", promoted: true, params: [], createdAtIso: "x" };
const fakeActor = {} as any;

function healedSegmentFixture(): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/a", steps: [{ step: { kind: "click", target: { testId: "new-button" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
  };
}

function journeyWithBrokenWriteStep(): Recording {
  // navigate (0, ok) -> fill (1, the broken WRITE step) — must NEVER auto-heal
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/a",
        steps: [
          { step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { testId: "loaded" } } } },
          { step: { kind: "fill", target: { testId: "field" }, value: { redacted: true, length: 3 }, expect: { kind: "visible", target: { testId: "next" } } } },
        ],
      },
    ],
  };
}

function journeyWithBrokenReadOnlyStep(): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/a",
        steps: [
          { step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { testId: "loaded" } } } },
          { step: { kind: "assert", check: { kind: "visible", target: { testId: "next" } } } },
        ],
      },
    ],
  };
}

function fakeInterpreterThatFails() {
  return {
    run: vi.fn().mockResolvedValue({ outcome: "failed", at: 1, error: "boom" }),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "failed", at: 1, error: "boom" }),
  } as any;
}

test("#8a hybrid never calls the healer for a write step", async () => {
  const healer: SelfHealer = { reLearnStep: vi.fn(async () => ({ outcome: "healed", segment: healedSegmentFixture() })) };
  const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFails(), undefined, undefined, healer);
  const result = await runner.run({
    journey: { metadata: baseMetadata, recording: journeyWithBrokenWriteStep() } as any,
    params: {},
    policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
  });
  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
});

test("#8b full never calls the healer for a write step", async () => {
  const healer: SelfHealer = { reLearnStep: vi.fn(async () => ({ outcome: "healed", segment: healedSegmentFixture() })) };
  const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFails(), undefined, undefined, healer);
  const result = await runner.run({
    journey: { metadata: baseMetadata, recording: journeyWithBrokenWriteStep() } as any,
    params: {},
    policy: { selfHeal: { mode: "full" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
  });
  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
});

test("current default remains fail-closed: safeRunPolicy() never triggers a heal attempt", async () => {
  const healer: SelfHealer = { reLearnStep: vi.fn(async () => ({ outcome: "healed", segment: healedSegmentFixture() })) };
  const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFails(), undefined, undefined, healer);
  const result = await runner.run({
    journey: { metadata: baseMetadata, recording: journeyWithBrokenReadOnlyStep() } as any,
    params: {},
    policy: safeRunPolicy(),
  });
  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
  expect(safeRunPolicy().selfHeal.mode).toBe("fail-closed");
});
