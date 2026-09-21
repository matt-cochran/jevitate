import { expect, test, vi } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recording } from "@jevitate/recording";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { reproduceFailure, NeverFailedError } from "./reproduce.js";
import { minimizeRecording, makeSingleShotReproduces } from "./minimize.js";
import { commitRegression, FlakyNotCommittableError } from "./commit.js";

function fakeLocator(visible: boolean) {
  return { click: vi.fn(async () => {}), fill: vi.fn(async () => {}), isVisible: vi.fn(async () => visible), count: vi.fn(async () => 0), innerText: vi.fn(async () => ""), waitFor: vi.fn(async () => {}) };
}
function fakePage(locator: ReturnType<typeof fakeLocator>) {
  return { goto: vi.fn(async () => {}), url: vi.fn(() => "https://example.test/x"), getByTestId: vi.fn(() => locator), getByRole: vi.fn(() => locator), getByLabel: vi.fn(() => locator), getByText: vi.fn(() => locator), locator: vi.fn(() => locator) };
}
function makeActor(visible: boolean) {
  return async () => CastActor.named("a").whoCan(new BrowseTheWeb({ page: fakePage(fakeLocator(visible)), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []));
}

const rec: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [{ url: "/x", steps: [{ step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
};

test("#1 flaky never promoted: commitRegression refuses and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  const flaky = { attempts: 2, reproducedCount: 1, rate: 0.5, label: "flaky" as const, fingerprint: { stepSignature: "x" }, firstFailureAt: 0 };
  await expect(commitRegression(dir, "id", rec, flaky)).rejects.toThrow(FlakyNotCommittableError);
  expect(await readdir(dir)).toEqual([]);
});

// Every failing attempt against a fake actor here polls for the interpreter's
// default 5000ms bounded-retry window before giving up (see
// `@jevitate/interpreter`'s `assertion.ts`) — fake timers + a single
// `advanceTimersByTimeAsync`, mirroring the pattern already used throughout
// `packages/interpreter/src/*.test.ts`, fast-forward through all of them.
test("#2 minimization never loses the bug: the final minimized Recording still reproduces", async () => {
  vi.useFakeTimers();
  try {
    const reportPromise = reproduceFailure(rec, makeActor(false), 3);
    await vi.advanceTimersByTimeAsync(3 * 6000);
    const report = await reportPromise;
    expect(report.label).toBe("reproducible");

    const reproduces = makeSingleShotReproduces(makeActor(false), report.fingerprint);
    const minimizedPromise = minimizeRecording(rec, reproduces);
    await vi.advanceTimersByTimeAsync(6000);
    const minimized = await minimizedPromise;

    const finalCheckPromise = reproduces(minimized);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await finalCheckPromise).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("#3 committed artifact is schema-valid: commitRegression rejects a malformed candidate", async () => {
  vi.useFakeTimers();
  try {
    const dir = await mkdtemp(join(tmpdir(), "inv-"));
    const reportPromise = reproduceFailure(rec, makeActor(false), 1);
    await vi.advanceTimersByTimeAsync(6000);
    const report = await reportPromise;
    const malformed = { ...rec, pages: [{ url: "/x", steps: [{ step: { kind: "not-a-real-kind" } }] }] } as any;
    await expect(commitRegression(dir, "id", malformed, report)).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

test("#4 no fabricated regression: reproduceFailure refuses an already-passing recording", async () => {
  await expect(reproduceFailure(rec, makeActor(true), 2)).rejects.toThrow(NeverFailedError);
});
