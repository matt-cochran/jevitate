import { describe, it, expect } from "vitest";
import { assertSafeInboxId, InboxItemSchema, toSummary, resolveTransition, asSecret, revealSecret } from "./types.js";

describe("safe id", () => {
  it("accepts a good id and rejects traversal / uppercase / dots / overlong", () => {
    expect(() => assertSafeInboxId("run-4a1c_2")).not.toThrow();
    for (const bad of ["../x", "a/b", "a\\b", "A", "a.b", "", "-x", "a".repeat(65)])
      expect(() => assertSafeInboxId(bad), bad).toThrow();
  });
});

describe("schema is strict", () => {
  const base = {
    id: "x1", kind: "approval", status: "pending", run: "r", journey: "j", step: "s",
    reason: "why", agent: "claude-code", hasScreenshot: false, thread: [], createdAt: "2026-09-22T00:00:00Z", ttlSec: 3600,
  };
  it("parses a valid item", () => { expect(() => InboxItemSchema.parse(base)).not.toThrow(); });
  it("rejects an unknown field (tamper)", () => {
    expect(() => InboxItemSchema.parse({ ...base, injected: true })).toThrow();
  });
});

describe("toSummary omits every secret-bearing field", () => {
  it("never carries humanInput/thread/findings", () => {
    const item = InboxItemSchema.parse({
      id: "x1", kind: "handback", status: "pending", run: "r", journey: "j", step: "s",
      reason: "why", agent: "a", hasScreenshot: false, thread: [{ author: "human", text: "secret!", at: "t" }],
      humanInput: "4111111111111111", createdAt: "2026-09-22T00:00:00Z", ttlSec: 60,
    });
    const s = toSummary(item) as Record<string, unknown>;
    expect(s.humanInput).toBeUndefined();
    expect(s.thread).toBeUndefined();
    expect(s.findings).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("4111111111111111");
    expect(s.id).toBe("x1");
  });
});

describe("transition table is total & guarded", () => {
  it("maps legal combos and rejects illegal ones", () => {
    expect(resolveTransition("approval", "approve")).toBe("approved");
    expect(resolveTransition("approval", "reject")).toBe("rejected");
    expect(resolveTransition("approval", "resume")).toBe("illegal");
    expect(resolveTransition("handback", "resume")).toBe("resolved");
    expect(resolveTransition("handback", "approve")).toBe("illegal");
    expect(resolveTransition("handback", "reject")).toBe("rejected");
    expect(resolveTransition("review", "approve")).toBe("approved");
    expect(resolveTransition("review", "resume")).toBe("illegal");
    expect(resolveTransition("review", "reject")).toBe("rejected");
    expect(resolveTransition("approval", "input")).toBe("illegal");
    expect(resolveTransition("handback", "input")).toBe("illegal");
    expect(resolveTransition("review", "input")).toBe("illegal");
  });
});

describe("branded Secret", () => {
  it("round-trips through asSecret / the strict schema / revealSecret", () => {
    const secret = asSecret("4111111111111111");
    const item = InboxItemSchema.parse({
      id: "x1", kind: "approval", status: "pending", run: "r", journey: "j", step: "s",
      reason: "why", agent: "claude-code", hasScreenshot: false, thread: [],
      humanInput: secret, createdAt: "2026-09-22T00:00:00Z", ttlSec: 3600,
    });
    expect(revealSecret(item.humanInput!)).toBe("4111111111111111");
  });
});
