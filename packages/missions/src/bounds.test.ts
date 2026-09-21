import { describe, it, expect } from "vitest";
import { MISSION_BOUNDS_CEILING } from "./bounds.js";

describe("MISSION_BOUNDS_CEILING", () => {
  it("equals the hard ceiling values from the spec", () => {
    expect(MISSION_BOUNDS_CEILING).toEqual({
      maxActions: 60,
      maxDecisions: 120,
      maxCandidates: 250,
    });
  });
});
