import { expect, test, vi } from "vitest";
import type { Recording } from "@jevitate/recording";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { reproduceFailure, NeverFailedError } from "./reproduce.js";

function fakeLocator(overrides: Partial<Record<string, any>> = {}) {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    isVisible: vi.fn(async () => false), // the postcondition that never holds — always fails
    count: vi.fn(async () => 0),
    innerText: vi.fn(async () => ""),
    waitFor: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakePage(locator: ReturnType<typeof fakeLocator>) {
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.test/inbox"),
    getByTestId: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
  };
}

function makeFailingActorFactory() {
  return async () =>
    CastActor.named("repro").whoCan(
      new BrowseTheWeb(
        { page: fakePage(fakeLocator()), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any,
        [],
      ),
    );
}

const rec: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [
    {
      url: "/inbox",
      steps: [
        { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
        { step: { kind: "click", target: { role: "button", name: "Compose" }, expect: { kind: "visible", target: { testId: "editor" } } } },
      ],
    },
  ],
};

// A failing attempt's postcondition (`checkAssertion`) polls for the
// interpreter's default 5000ms bounded-retry window before giving up (see
// `@jevitate/interpreter`'s `assertion.ts`). Three sequential failing
// attempts would otherwise take 15s of real wall-clock time and blow past
// vitest's default per-test timeout — fake timers + a single
// `advanceTimersByTimeAsync` (mirroring the pattern already used throughout
// `packages/interpreter/src/*.test.ts`) fast-forward through all of them.
test("a consistently-failing recording is labeled reproducible with rate 1", async () => {
  vi.useFakeTimers();
  try {
    const resultPromise = reproduceFailure(rec, makeFailingActorFactory(), 3);
    await vi.advanceTimersByTimeAsync(3 * 6000);
    const report = await resultPromise;
    expect(report.label).toBe("reproducible");
    expect(report.rate).toBe(1);
    expect(report.attempts).toBe(3);
    expect(report.reproducedCount).toBe(3);
    expect(report.fingerprint.stepSignature).toContain("navigate");
  } finally {
    vi.useRealTimers();
  }
});

test("a recording that fails on the first attempt but passes later is labeled flaky", async () => {
  let call = 0;
  const makeActor = async () => {
    call++;
    const passingLocator = fakeLocator({ isVisible: vi.fn(async () => true) });
    const locator = call === 1 ? fakeLocator() : passingLocator;
    return CastActor.named("repro").whoCan(
      new BrowseTheWeb(
        { page: fakePage(locator), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any,
        [],
      ),
    );
  };
  vi.useFakeTimers();
  try {
    const resultPromise = reproduceFailure(rec, makeActor, 3);
    await vi.advanceTimersByTimeAsync(6000);
    const report = await resultPromise;
    expect(report.label).toBe("flaky");
    expect(report.rate).toBeLessThan(1);
  } finally {
    vi.useRealTimers();
  }
});

test("throws NeverFailedError when the recording never fails", async () => {
  const passingActorFactory = async () =>
    CastActor.named("repro").whoCan(
      new BrowseTheWeb(
        { page: fakePage(fakeLocator({ isVisible: vi.fn(async () => true) })), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any,
        [],
      ),
    );
  await expect(reproduceFailure(rec, passingActorFactory, 2)).rejects.toThrow(NeverFailedError);
});

test("rejects attempts < 1", async () => {
  await expect(reproduceFailure(rec, makeFailingActorFactory(), 0)).rejects.toThrow(/attempts must be/);
});
