import { describe, it, expect } from "vitest";
import { JourneySchema } from "./index.js";

const recording = { version: "1", site: "example", pages: [] };

describe("JourneySchema", () => {
  it("parses a well-formed Journey and rejects unknown metadata keys", () => {
    const j = {
      metadata: { id: "login", name: "Log in", promoted: false, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
      recording,
    };
    expect(() => JourneySchema.parse(j)).not.toThrow();
    const bad = { ...j, metadata: { ...j.metadata, bogus: 1 } };
    expect(() => JourneySchema.parse(bad)).toThrow();
  });

  it("rejects a metadata.id containing a path separator or '..', accepts a normal id", () => {
    const base = {
      metadata: { id: "login", name: "Log in", promoted: false, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
      recording,
    };
    expect(() => JourneySchema.parse(base)).not.toThrow();

    for (const badId of ["a/b", "a\\b", "../etc/passwd", "..", ""]) {
      const bad = { ...base, metadata: { ...base.metadata, id: badId } };
      expect(() => JourneySchema.parse(bad)).toThrow();
    }
  });

  it("accepts metadata with no authoredBy (legacy/human default)", () => {
    const result = JourneySchema.safeParse({
      metadata: { id: "login", name: "Log in", promoted: true, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
      recording,
    });
    expect(result.success).toBe(true);
  });

  it("accepts authoredBy: 'jev-driven'", () => {
    const result = JourneySchema.safeParse({
      metadata: {
        id: "explore-login", name: "Explore-driven login", promoted: false, params: [],
        authoredBy: "jev-driven", createdAtIso: "2026-09-20T00:00:00Z",
      },
      recording,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown authoredBy value", () => {
    const result = JourneySchema.safeParse({
      metadata: { id: "x", name: "x", promoted: false, params: [], authoredBy: "made-up", createdAtIso: "2026-09-20T00:00:00Z" },
      recording,
    });
    expect(result.success).toBe(false);
  });
});
