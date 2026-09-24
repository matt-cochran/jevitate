import { expect, test, vi } from "vitest";
import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { runRegressionCapture, NoFailureToReproduceError } from "./regression-api.js";

function fakeLocator(visible: boolean) {
  return { click: vi.fn(async () => {}), isVisible: vi.fn(async () => visible), count: vi.fn(async () => 1) /* the recorded target resolves uniquely */, innerText: vi.fn(async () => ""), fill: vi.fn(async () => {}), waitFor: vi.fn(async () => {}) };
}
function fakePage(locator: ReturnType<typeof fakeLocator>) {
  return { goto: vi.fn(async () => {}), url: vi.fn(() => "https://example.test/x"), getByTestId: vi.fn(() => locator), getByRole: vi.fn(() => locator), getByLabel: vi.fn(() => locator), getByText: vi.fn(() => locator), locator: vi.fn(() => locator) };
}
function makeFailingActor() {
  return async () => CastActor.named("cli").whoCan(new BrowseTheWeb({ page: fakePage(fakeLocator(false)), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []));
}
function makePassingActor() {
  return async () => CastActor.named("cli").whoCan(new BrowseTheWeb({ page: fakePage(fakeLocator(true)), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []));
}

/** A page whose `pay` testId target is never visible (the "Pay stays disabled" oracle); every other target resolves and is visible. */
function twoTargetPage() {
  const passing = fakeLocator(true);
  const failing = fakeLocator(false);
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.test/x"),
    getByTestId: vi.fn((id: string) => (id === "pay" ? failing : passing)),
    getByRole: vi.fn(() => passing),
    getByLabel: vi.fn(() => passing),
    getByText: vi.fn(() => passing),
    locator: vi.fn(() => passing),
  };
}
function makeOracleActor() {
  return async () => CastActor.named("cli").whoCan(new BrowseTheWeb({ page: twoTargetPage(), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []));
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

// #81 item 1: a Recording whose replay never fails carries no reproducible failure — capture
// must refuse it (never "minimize" it into a vacuous, always-passing regression).
test("capture from a PASSING Recording refuses with a clear, actionable error (#81)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-regr-pass-"));
  const passingRecordingPath = join(dir, "passing.json");
  await writeFile(
    passingRecordingPath,
    JSON.stringify({
      version: "1.0",
      site: "https://example.test",
      pages: [{ url: "/x", steps: [{ step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
    }),
  );

  await expect(
    runRegressionCapture({
      failingRecordingPath: passingRecordingPath,
      id: "bug-passing",
      regressionsDir: join(dir, "regressions"),
      attempts: 1,
      makeActor: makePassingActor(),
    }),
  ).rejects.toThrow(NoFailureToReproduceError);
  await expect(
    runRegressionCapture({
      failingRecordingPath: passingRecordingPath,
      id: "bug-passing",
      regressionsDir: join(dir, "regressions"),
      attempts: 1,
      makeActor: makePassingActor(),
    }),
  ).rejects.toThrow(/contains no failure to reproduce; pass --result <result\.json> --fingerprint <fp>/);
});

// #81 item 2: the Recording itself only has the SUCCESSFUL steps (a disabled "Pay" click is never
// recorded — see `@jevitate/explore`'s `RunRecorder`). `--result` supplies the mission's own last
// failed action (with its target descriptor) as the failure oracle, so capture minimizes against
// THAT — never an unrelated, incidentally-failing step.
test(
  "capture with --result derives an oracle from the mission's failed action + failed check, and commits a regression that reproduces THAT failure (#81)",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-regr-oracle-"));
    const recordingPath = join(dir, "goal-recording.json");
    // Only the successful click (selecting the credit pack) was ever recorded — the disabled
    // "Pay" click that actually failed the mission left no trace here, by design.
    await writeFile(
      recordingPath,
      JSON.stringify({
        version: "1.0",
        site: "https://example.test",
        pages: [
          {
            url: "/x",
            steps: [
              { step: { kind: "click", target: { testId: "credit-pack-pack_25" }, expect: { kind: "visible", target: { testId: "credit-pack-pack_25" } } } },
            ],
          },
        ],
      }),
    );
    const resultPath = join(dir, "goal-recording.result.json");
    await writeFile(
      resultPath,
      JSON.stringify({
        result: {
          checks: [{ check: "visible:testId=credit-success", passed: false, detail: "credit-success never became visible" }],
          transcript: [
            { step: 1, op: "click", actOk: true, url: "/x", descriptor: { testId: "credit-pack-pack_25" } },
            { step: 2, op: "click", actOk: false, reason: "target not enabled", url: "/x", descriptor: { testId: "pay" } },
          ],
        },
      }),
    );

    const regressionsDir = join(dir, "regressions");
    const result = await runRegressionCapture({
      failingRecordingPath: recordingPath,
      id: "pay-disabled",
      regressionsDir,
      attempts: 1,
      resultPath,
      makeActor: makeOracleActor(),
    });

    expect(result).toMatchObject({ recordingPath: expect.stringContaining("pay-disabled.recording.json") });
    const meta = JSON.parse(await readFile(join(regressionsDir, "pay-disabled.meta.json"), "utf8"));
    expect(meta.reproduction.rate).toBe(1);
    // The committed, minimized recording's failure step is the oracle (the "pay" click), not the
    // unrelated pack-selection click.
    expect(meta.fingerprint.stepSignature).toContain("pay");
    const minimized = JSON.parse(await readFile(join(regressionsDir, "pay-disabled.recording.json"), "utf8"));
    const allSteps = minimized.pages.flatMap((p: { steps: { step: { target?: { testId?: string } } }[] }) => p.steps);
    expect(allSteps.some((s: { step: { target?: { testId?: string } } }) => s.step.target?.testId === "pay")).toBe(true);
  },
  20000,
);
