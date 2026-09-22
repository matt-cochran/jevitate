import { expect, test, vi } from "vitest";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { runRegressionCapture } from "./regression-api.js";

function fakeLocator(visible: boolean) {
  return { click: vi.fn(async () => {}), isVisible: vi.fn(async () => visible), count: vi.fn(async () => 0), innerText: vi.fn(async () => ""), fill: vi.fn(async () => {}), waitFor: vi.fn(async () => {}) };
}
function fakePage(locator: ReturnType<typeof fakeLocator>) {
  return { goto: vi.fn(async () => {}), url: vi.fn(() => "https://example.test/x"), getByTestId: vi.fn(() => locator), getByRole: vi.fn(() => locator), getByLabel: vi.fn(() => locator), getByText: vi.fn(() => locator), locator: vi.fn(() => locator) };
}
function makeFailingActor() {
  return async () => CastActor.named("cli").whoCan(new BrowseTheWeb({ page: fakePage(fakeLocator(false)), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []));
}

// Real timers (not `vi.useFakeTimers()`) deliberately: `runRegressionCapture`
// starts with a REAL `readFile` (fs I/O, resolved on a genuine event-loop
// tick, not a microtask) before any interpreter postcondition poll ever
// starts — advancing a mocked clock up front races that I/O and the
// interpreter's first (fake) `setTimeout` is scheduled only after the fake
// clock has already finished ticking, hanging forever. 2 reproduce attempts
// each really wait out the interpreter's default 5000ms bounded-retry
// postcondition-poll window (see `@jevitate/interpreter`'s `assertion.ts`)
// — a generous 20s real per-test timeout comfortably covers that.
test(
  "capture end to end: reproduce -> minimize -> commit, from a failing-recording file",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-regr-"));
    const failingRecordingPath = join(dir, "input.json");
    await writeFile(
      failingRecordingPath,
      JSON.stringify({
        version: "1.0",
        site: "https://example.test",
        pages: [{ url: "/x", steps: [{ step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
      }),
    );

    const regressionsDir = join(dir, "regressions");
    const result = await runRegressionCapture({
      failingRecordingPath,
      id: "bug-1",
      regressionsDir,
      attempts: 2,
      makeActor: makeFailingActor(),
    });

    expect(result).toMatchObject({ recordingPath: expect.stringContaining("bug-1.recording.json") });
    expect((await readdir(regressionsDir)).sort()).toEqual(["bug-1.meta.json", "bug-1.recording.json"]);
  },
  20000,
);
