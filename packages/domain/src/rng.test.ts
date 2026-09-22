import { expect, test } from "vitest";
import { seedFrom, makeRng, gaussian } from "./rng.js";

test("same seed → identical stream; different seed → different", () => {
  const a = makeRng(seedFrom("run1", "1")); const b = makeRng(seedFrom("run1", "1")); const c = makeRng(seedFrom("run2", "1"));
  const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()];
  expect(seqA).toEqual(seqB);
  expect([c(), c(), c()]).not.toEqual(seqA);
  seqA.forEach((x) => { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); });
});

test("gaussian clamps to [min,max] and is deterministic for a seed", () => {
  const r1 = makeRng(42); const r2 = makeRng(42);
  const p = { mean: 100, sd: 50, min: 60, max: 140 };
  const v1 = gaussian(r1, p); const v2 = gaussian(r2, p);
  expect(v1).toBe(v2);
  for (let i = 0; i < 200; i++) { const v = gaussian(r1, p); expect(v).toBeGreaterThanOrEqual(60); expect(v).toBeLessThanOrEqual(140); }
});
