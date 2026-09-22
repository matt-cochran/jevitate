import { expect, test } from "vitest";
import { makeRng } from "./rng.js";
import { Pacer } from "./pacer.js";

test("typingDelays: one per char, deterministic, ~ base cadence, pauses at boundaries", () => {
  const model = {
    charsPerSecond: 5,
    perKeyJitter: 0.2,
    wordPauseMs: { mean: 120, sd: 0, min: 120, max: 120 },
    sentencePauseMs: { mean: 400, sd: 0, min: 400, max: 400 },
  };
  const d1 = new Pacer(makeRng(7)).typingDelays("Hi there.", model);
  const d2 = new Pacer(makeRng(7)).typingDelays("Hi there.", model);
  expect(d1).toEqual(d2); // deterministic
  expect(d1).toHaveLength("Hi there.".length); // one per char
  const spaceIdx = "Hi there.".indexOf(" ");
  expect(d1[spaceIdx]).toBeGreaterThan(d1[0]); // word pause adds time after the space
  expect(d1[d1.length - 1]).toBeGreaterThan(300); // sentence pause after "."
});

test("typingDelays: with no pause/hesitation config, delays cluster around base cadence", () => {
  const model = { charsPerSecond: 10, perKeyJitter: 0.1 };
  const delays = new Pacer(makeRng(42)).typingDelays("abcdef", model);
  const base = 1000 / model.charsPerSecond;
  expect(delays).toHaveLength(6);
  for (const d of delays) {
    expect(d).toBeGreaterThanOrEqual(base * 0.4);
    expect(d).toBeLessThanOrEqual(base * 3);
  }
});

test("typingDelays: hesitation always triggers when probability is 1", () => {
  const model = {
    charsPerSecond: 10,
    perKeyJitter: 0.1,
    hesitation: { probability: 1, pauseMs: { mean: 500, sd: 0, min: 500, max: 500 } },
  };
  const noHesitation = new Pacer(makeRng(1)).typingDelays("ab", {
    charsPerSecond: 10,
    perKeyJitter: 0.1,
  });
  const withHesitation = new Pacer(makeRng(1)).typingDelays("ab", model);
  for (let i = 0; i < withHesitation.length; i++) {
    expect(withHesitation[i]).toBeGreaterThan(noHesitation[i]);
  }
});

test("think/reading/interInteraction return 0 or bounded defaults when config is absent", () => {
  const pacer = new Pacer(makeRng(3));
  expect(pacer.think({})).toBe(0);
  expect(pacer.interInteraction({})).toBe(0);
  expect(pacer.reading(100, {})).toBe(0);
});

test("reading: scales with nChars and clamps to maxReadingMs", () => {
  const pacer = new Pacer(makeRng(3));
  expect(pacer.reading(10, { readingMsPerChar: 5 })).toBe(50);
  expect(pacer.reading(1000, { readingMsPerChar: 5, maxReadingMs: 100 })).toBe(100);
});

test("think: returns a gaussian sample of thinkBeforeActionMs when defined", () => {
  const pacer = new Pacer(makeRng(9));
  const t = pacer.think({ thinkBeforeActionMs: { mean: 200, sd: 0, min: 200, max: 200 } });
  expect(t).toBe(200);
});
