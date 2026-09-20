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
});
