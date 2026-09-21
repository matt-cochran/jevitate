import { expect, test } from "vitest";
import { isWithinQuietHours, nextOpenAfter } from "./quiet-hours.js";
import type { QuietHours } from "./interaction-policy.js";

const wrapQh: QuietHours = {
  timezone: "America/New_York",
  windows: [{ start: "20:00", end: "08:00" }],
};

const nonWrapQh: QuietHours = {
  timezone: "America/New_York",
  windows: [{ start: "09:00", end: "17:00" }],
};

const multiWindowQh: QuietHours = {
  timezone: "America/New_York",
  windows: [
    { start: "12:00", end: "13:00" },
    { start: "22:00", end: "23:00" },
  ],
};

test("wrap-around midnight window", () => {
  expect(isWithinQuietHours("2026-09-17T02:00:00-04:00", wrapQh)).toBe(true); // 2am local → inside
  expect(isWithinQuietHours("2026-09-17T12:00:00-04:00", wrapQh)).toBe(false); // noon → outside
});

test("non-wrapping window", () => {
  expect(isWithinQuietHours("2026-09-17T09:00:00-04:00", nonWrapQh)).toBe(true); // start boundary → inside
  expect(isWithinQuietHours("2026-09-17T12:00:00-04:00", nonWrapQh)).toBe(true); // middle → inside
  expect(isWithinQuietHours("2026-09-17T08:59:00-04:00", nonWrapQh)).toBe(false); // just before → outside
  expect(isWithinQuietHours("2026-09-17T17:00:00-04:00", nonWrapQh)).toBe(false); // end boundary → outside (half-open)
});

test("wrap-around window boundaries", () => {
  expect(isWithinQuietHours("2026-09-17T20:00:00-04:00", wrapQh)).toBe(true); // start boundary → inside
  expect(isWithinQuietHours("2026-09-17T08:00:00-04:00", wrapQh)).toBe(false); // end boundary → outside
  expect(isWithinQuietHours("2026-09-17T19:59:00-04:00", wrapQh)).toBe(false); // just before start → outside
  expect(isWithinQuietHours("2026-09-17T07:59:00-04:00", wrapQh)).toBe(true); // just before end → inside
});

test("multiple windows: inside any window counts", () => {
  expect(isWithinQuietHours("2026-09-17T12:30:00-04:00", multiWindowQh)).toBe(true);
  expect(isWithinQuietHours("2026-09-17T22:30:00-04:00", multiWindowQh)).toBe(true);
  expect(isWithinQuietHours("2026-09-17T15:00:00-04:00", multiWindowQh)).toBe(false);
});

test("nextOpenAfter: already open returns nowIso unchanged", () => {
  const now = "2026-09-17T12:00:00-04:00";
  expect(nextOpenAfter(now, wrapQh)).toBe(now);
});

test("nextOpenAfter: closed inside wrap-around window (early morning portion) returns today's end", () => {
  const now = "2026-09-17T02:00:00-04:00";
  const result = nextOpenAfter(now, wrapQh);
  const expected = "2026-09-17T08:00:00-04:00";
  expect(result).toBe(expected);
});

test("nextOpenAfter: closed inside wrap-around window (evening portion) returns next day's end", () => {
  const now = "2026-09-17T22:00:00-04:00";
  const result = nextOpenAfter(now, wrapQh);
  const expected = "2026-09-18T08:00:00-04:00";
  expect(result).toBe(expected);
});

test("nextOpenAfter: closed inside non-wrapping window returns same-day end", () => {
  const now = "2026-09-17T12:00:00-04:00";
  const result = nextOpenAfter(now, nonWrapQh);
  const expected = "2026-09-17T17:00:00-04:00";
  expect(result).toBe(expected);
});
