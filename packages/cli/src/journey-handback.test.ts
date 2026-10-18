import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright";
import { flatJourneySteps, type Journey } from "@jevitate/journey";
import { BoundaryNoHealError, HandbackWriteObserver, assertHandbackNoHeal, attachHandback, handbackExitCode, handbackLine } from "./journey-handback.js";

// #583: the CLI wiring — heal refusal, the typed handback attached only with a boundary, and the
// whole-run write observer's counts reaching the classifier. No real browser: a fake page captures
// the route handler and feeds it a fake request.

const boundary = {
  kind: "prepare-only" as const,
  stopBefore: { target: { testId: "reply-send" }, label: "Send" },
  nextStep: "Read the prepared reply in Community, then click Send yourself.",
};

const journey = (over: Partial<Journey["metadata"]> = {}): Journey => ({
  metadata: { id: "reply", name: "Reply", promoted: true, params: [], createdAtIso: "2026-01-01T00:00:00Z", ...over },
  recording: { version: "1", site: "https://example.test", pages: [] },
});

function fakePage(): { page: Page; handlers: Map<string, (route: unknown, request: unknown) => Promise<void>> } {
  const handlers = new Map<string, (route: unknown, request: unknown) => Promise<void>>();
  const page = {
    route: vi.fn(async (pattern: string, handler: (route: unknown, request: unknown) => Promise<void>) => {
      handlers.set(pattern, handler);
    }),
    unroute: vi.fn(async () => {}),
    isClosed: () => false,
  } as unknown as Page;
  return { page, handlers };
}

const request = (method: string, url: string, headers: Record<string, string> = {}): unknown => ({
  method: () => method,
  url: () => url,
  headers: () => headers,
});

describe("assertHandbackNoHeal (#583 §3)", () => {
  it("refuses self-heal for a Journey with a prepare-only boundary", () => {
    expect(() => assertHandbackNoHeal(journey({ boundary }), true)).toThrow(BoundaryNoHealError);
  });

  it("codes the refusal E_BOUNDARY_NO_HEAL", () => {
    try {
      assertHandbackNoHeal(journey({ boundary }), true);
    } catch (err) {
      expect((err as BoundaryNoHealError).code).toBe("E_BOUNDARY_NO_HEAL");
    }
  });

  it("allows self-heal for a Journey without a boundary", () => {
    expect(() => assertHandbackNoHeal(journey(), true)).not.toThrow();
  });

  it("allows a boundary Journey when no self-heal is requested", () => {
    expect(() => assertHandbackNoHeal(journey({ boundary }), false)).not.toThrow();
  });
});

describe("attachHandback (#583 §4)", () => {
  const result = { outcome: "ok" as const, output: {} };
  const counts = { writes: 0, writesBlocked: 0, observation: "available" as const };

  it("attaches a handback only when the Journey declares a boundary", () => {
    expect(attachHandback(result, journey({ boundary }), counts).handback).toBeDefined();
  });

  it("leaves a Journey without a boundary unchanged", () => {
    expect("handback" in attachHandback(result, journey(), counts)).toBe(false);
  });

  it("counts steps from the Journey", () => {
    const j = journey({ boundary });
    j.recording.pages = [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } }] }];
    expect(attachHandback(result, j, counts).handback?.evidence.steps).toBe(flatJourneySteps(j).length);
  });
});

describe("HandbackWriteObserver (#583 §3)", () => {
  it("counts a first-party write the page sends", async () => {
    const { page, handlers } = fakePage();
    const observer = new HandbackWriteObserver(["https://example.test"]);
    await observer.arm(page);
    await handlers.get("**/*")!( { fallback: async () => {} }, request("POST", "https://example.test/api/reply", { "content-type": "application/json" }));
    expect(observer.counts().writes).toBe(1);
  });

  it("does not count a read", async () => {
    const { page, handlers } = fakePage();
    const observer = new HandbackWriteObserver(["https://example.test"]);
    await observer.arm(page);
    await handlers.get("**/*")!({ fallback: async () => {} }, request("GET", "https://example.test/api/reply"));
    expect(observer.counts().writes).toBe(0);
  });

  it("reports write observation unavailable when the page cannot be routed", async () => {
    const observer = new HandbackWriteObserver(["https://example.test"]);
    await observer.arm({} as Page);
    expect(observer.counts().observation).toBe("unavailable");
  });

  it("feeds a counted write into the handback state", async () => {
    const { page, handlers } = fakePage();
    const observer = new HandbackWriteObserver(["https://example.test"]);
    await observer.arm(page);
    await handlers.get("**/*")!({ fallback: async () => {} }, request("POST", "https://example.test/api/reply", { "content-type": "application/json" }));
    expect(attachHandback({ outcome: "ok", output: {} }, journey({ boundary }), observer.counts()).handback?.state).toBe("submitted");
  });
});

describe("handbackExitCode / handbackLine (#583 §4)", () => {
  const base = { boundary: "prepare-only" as const, stopBefore: "Send", evidence: { steps: 3, checksPassed: 3, writes: 0, writesBlocked: 0 } };
  it("keeps the run's code for prepared", () => {
    expect(handbackExitCode(0, { ...base, state: "prepared", nextStep: "Click Send yourself." })).toBe(0);
  });
  it("never passes a submitted run", () => {
    expect(handbackExitCode(0, { ...base, state: "submitted", evidence: { ...base.evidence, writes: 1 } })).toBe(1);
  });
  it("makes an inconclusive handback exit 2", () => {
    expect(handbackExitCode(0, { ...base, state: "inconclusive" })).toBe(2);
  });
  it("shows the next step only when prepared", () => {
    expect(handbackLine({ ...base, state: "prepared", nextStep: "Click Send yourself." })).toBe("handback: prepared — next: Click Send yourself.");
  });
  it("names the failed step without a next step", () => {
    expect(handbackLine({ ...base, state: "verification-failed", evidence: { ...base.evidence, failedAt: 2 } })).toBe("handback: verification-failed at step 2 — nothing is ready for Send");
  });
});
