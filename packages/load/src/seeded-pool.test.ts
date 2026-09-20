import { describe, it, expect } from "vitest";
import { deriveActorSeeds } from "./seeded-pool.js";

describe("deriveActorSeeds", () => {
  it("returns `count` seeds", () => {
    expect(deriveActorSeeds(42, 5)).toHaveLength(5);
  });

  it("is deterministic: same masterSeed + count -> identical seeds every call", () => {
    expect(deriveActorSeeds(42, 5)).toEqual(deriveActorSeeds(42, 5));
  });

  it("different master seeds produce different seed lists", () => {
    expect(deriveActorSeeds(1, 3)).not.toEqual(deriveActorSeeds(2, 3));
  });

  it("produces distinct seeds within one pool (no accidental collisions for a small pool)", () => {
    const seeds = deriveActorSeeds(7, 10);
    expect(new Set(seeds).size).toBe(10);
  });
});
