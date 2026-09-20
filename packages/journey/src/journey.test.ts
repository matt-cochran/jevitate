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
});
