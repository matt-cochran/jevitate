import { describe, it, expect } from "vitest";
import { canonicalJson, canonicalJourneyHash } from "./hash.js";

describe("canonicalJson", () => {
  it("is invariant to object key order and whitespace", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it("preserves array order (step order is semantic)", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it("omits undefined optionals rather than emitting null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("canonicalJourneyHash", () => {
  const j = {
    metadata: { id: "x", name: "x", promoted: false, params: [], createdAtIso: "t" },
    recording: { version: "1", site: "s", pages: [] },
    declaredOrigins: ["https://mail.example.com"],
  };
  it("is stable and sha256-prefixed", () => {
    expect(canonicalJourneyHash(j)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalJourneyHash(j)).toBe(canonicalJourneyHash({ ...j }));
  });
  it("changes when a step's bytes change (TOCTOU basis)", () => {
    const j2 = { ...j, declaredOrigins: ["https://evil.example.com"] };
    expect(canonicalJourneyHash(j2)).not.toBe(canonicalJourneyHash(j));
  });
});
