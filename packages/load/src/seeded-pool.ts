import { makeRng } from "@jevitate/domain";

/**
 * Derives `count` reproducible sub-seeds from one master seed, using
 * `@jevitate/domain`'s `makeRng` as the single deterministic RNG stream. Same
 * `masterSeed` + `count` always yields the same seed list — this is what
 * makes a load-test run replayable end to end (the master seed is the only
 * thing a caller needs to record).
 */
export function deriveActorSeeds(masterSeed: number, count: number): number[] {
  const rng = makeRng(masterSeed);
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) {
    seeds.push(Math.floor(rng() * 0xffffffff) >>> 0);
  }
  return seeds;
}
