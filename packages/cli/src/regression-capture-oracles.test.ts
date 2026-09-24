import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { Recording } from "@jevitate/recording";
import { CastActor, BrowseTheWeb, type Actor } from "@jevitate/screenplay";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import {
  runRegressionCapture,
  runRegressionRun,
  NoFailureToReproduceError,
  NoOracleInResultError,
  FingerprintMismatchError,
} from "./regression-api.js";

/**
 * #119/#129: `regression capture` must accept every defect kind `verify-fix` does (a declared
 * invariant, a failed network check), never jevitate's own engine refusal, and its errors must be
 * accurate. This file covers the four scenarios the tickets' test plan calls out; the pre-existing
 * `regression-api.test.ts` keeps the step-oracle (#81) coverage.
 */

// ---------------------------------------------------------------------------
// Scenario 1 (#129 planted-defect flow): a save that swaps first/last name, a goal whose transcript
// contains an engine refusal (the repeated-side-effect guard, #92) AND a failed `reloadThen` check —
// capture must pick the reloadThen check, never the engine refusal, and the resulting regression must
// fail on a "buggy" replay and pass on a "fixed" one.
// ---------------------------------------------------------------------------

function fakeValueLocator(value: string) {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
    count: vi.fn(async () => 1),
    innerText: vi.fn(async () => ""),
    waitFor: vi.fn(async () => {}),
    inputValue: vi.fn(async () => value),
  };
}
function fakeValuePage(locator: ReturnType<typeof fakeValueLocator>) {
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.test/x"),
    getByTestId: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
  };
}
function makeValueActor(lastName: string): () => Promise<Actor> {
  return async () =>
    CastActor.named("cli").whoCan(
      new BrowseTheWeb({ page: fakeValuePage(fakeValueLocator(lastName)), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []),
    );
}

const swapRecording: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [
    {
      url: "/x",
      steps: [{ step: { kind: "click", target: { testId: "profile-save-btn" }, expect: { kind: "visible", target: { testId: "profile-save-btn" } } } }],
    },
  ],
};

const swapResult = {
  result: {
    checks: [
      { check: "requestMade:POST /api/v1/tool/profile", passed: true, detail: "1 matching request(s)" },
      { check: "responseStatus:POST /api/v1/tool/profile=2xx", passed: true, detail: "1 matching request(s), status 200" },
      {
        check: "reloadThen:valueEquals:testId=profile-general-lastName|LitmusThree",
        passed: false,
        detail: "expected LitmusThree, got Cochran",
      },
    ],
    transcript: [
      { step: 1, op: "type", actOk: true, url: "/x", descriptor: { testId: "profile-general-lastName" } },
      { step: 2, op: "click", actOk: true, url: "/x", descriptor: { testId: "profile-save-btn" } },
      {
        step: 3,
        op: "click",
        actOk: false,
        origin: "engine",
        reason:
          'repeated side effect refused: "Save Preferences" already sent POST /api/v1/tool/profile → 200 on this page and the page does not offer a retry — clicking it again would repeat that action',
        url: "/x",
        descriptor: { testId: "profile-save-btn" },
      },
    ],
  },
};

test(
  "#129 planted-defect flow: capture picks the failed reloadThen check (never the engine refusal), and the regression fails on the buggy app + passes on the fixed one",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-regr-swap-"));
    const recordingPath = join(dir, "swap.json");
    const resultPath = join(dir, "swap.result.json");
    await writeFile(recordingPath, JSON.stringify(swapRecording));
    await writeFile(resultPath, JSON.stringify(swapResult));
    const regressionsDir = join(dir, "regressions");

    const result = await runRegressionCapture({
      failingRecordingPath: recordingPath,
      id: "name-swap",
      regressionsDir,
      attempts: 1,
      resultPath,
      makeActor: makeValueActor("Cochran"), // the buggy app: last name never actually became "LitmusThree"
    });
    expect(result).toMatchObject({ recordingPath: expect.stringContaining("name-swap.recording.json") });

    const meta = JSON.parse(await readFile(join(regressionsDir, "name-swap.meta.json"), "utf8"));
    // The oracle is the reloadThen check's assertion, never the engine's own repeated-side-effect refusal.
    expect(meta.oracle).toBeUndefined(); // a page/reloadThen oracle is the Recording's own trailing `assert` step
    const minimized = JSON.parse(await readFile(join(regressionsDir, "name-swap.recording.json"), "utf8"));
    const lastStep = minimized.pages.at(-1).steps.at(-1).step;
    expect(lastStep).toEqual({ kind: "assert", check: { kind: "valueEquals", target: { testId: "profile-general-lastName" }, value: "LitmusThree" } });

    // The committed regression still reproduces against the buggy app…
    const buggy = await runRegressionRun({ id: "name-swap", regressionsDir, makeActor: makeValueActor("Cochran") });
    expect(buggy.verdict).toBe("reproduces");
    // …and passes once the app is fixed (the value now persists as expected).
    const fixed = await runRegressionRun({ id: "name-swap", regressionsDir, makeActor: makeValueActor("LitmusThree") });
    expect(fixed.verdict).toBe("fixed");
  },
  60000,
);

// ---------------------------------------------------------------------------
// Scenario 2 (#119): a failed `responseStatus` network check is captured (never silently skipped).
// Real server + real browser — a network check is evaluated over ACTUAL captured traffic, which a
// fake locator-only actor cannot produce.
// ---------------------------------------------------------------------------

let broken = true;
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/profile") {
      res.writeHead(broken ? 500 : 200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        `<!doctype html><html><body><button data-testid="save" type="button">Save</button>${
          broken ? "" : `<div data-testid="confirm-banner">Saved</div>`
        }<script>document.querySelector('[data-testid=save]').addEventListener('click',()=>fetch('/api/profile',{method:'POST'}));</script></body></html>`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const port = new PlaywrightBrowserPort();
async function realActor(): Promise<{ actor: Actor; close: () => Promise<void> }> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  const actor = CastActor.named("t").whoCan(new BrowseTheWeb(session, [origin]));
  return { actor, close: () => session.close() };
}

test(
  "#119 a failed responseStatus check is captured as a regression (never refused as 'no failed check')",
  async () => {
    broken = true;
    const dir = await mkdtemp(join(tmpdir(), "cli-regr-status-"));
    const recording: Recording = {
      version: "1.0.0",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } },
            { step: { kind: "click", target: { testId: "save" }, expect: { kind: "visible", target: { testId: "save" } } } },
          ],
        },
      ],
    };
    const recordingPath = join(dir, "status.json");
    await writeFile(recordingPath, JSON.stringify(recording));
    const resultPath = join(dir, "status.result.json");
    await writeFile(
      resultPath,
      JSON.stringify({
        result: {
          checks: [{ check: "responseStatus:POST /api/profile=2xx", passed: false, detail: "expected 2xx, got 500" }],
          transcript: [{ step: 1, op: "click", actOk: true, url: origin + "/", descriptor: { testId: "save" } }],
        },
      }),
    );
    const regressionsDir = join(dir, "regressions");
    const opened: Array<() => Promise<void>> = [];
    try {
      const result = await runRegressionCapture({
        failingRecordingPath: recordingPath,
        id: "status-500",
        regressionsDir,
        attempts: 1,
        resultPath,
        makeActor: async () => {
          const { actor, close } = await realActor();
          opened.push(close);
          return actor;
        },
      });
      expect(result).toMatchObject({ recordingPath: expect.stringContaining("status-500.recording.json") });
      const meta = JSON.parse(await readFile(join(regressionsDir, "status-500.meta.json"), "utf8"));
      expect(meta.oracle).toMatchObject({ kind: "network", check: { kind: "responseStatus", method: "POST", pathGlob: "/api/profile" } });

      // Reproduces against the still-broken server…
      const stillBroken = await runRegressionRun({
        id: "status-500",
        regressionsDir,
        makeActor: async () => {
          const { actor, close } = await realActor();
          opened.push(close);
          return actor;
        },
      });
      expect(stillBroken.verdict).toBe("reproduces");
      // …and is fixed once the server starts returning 2xx.
      broken = false;
      const fixed = await runRegressionRun({
        id: "status-500",
        regressionsDir,
        makeActor: async () => {
          const { actor, close } = await realActor();
          opened.push(close);
          return actor;
        },
      });
      expect(fixed.verdict).toBe("fixed");
    } finally {
      broken = true;
      for (const close of opened) await close();
    }
  },
  30000,
);

// ---------------------------------------------------------------------------
// Scenario 3 (#119): a declared-invariant defect, matched by its OWN fingerprint (the one every
// other command — verify-fix — uses), is captured by re-checking the invariant, never by inventing a
// Recording assertion for it.
// ---------------------------------------------------------------------------

test(
  "#119 a declared-invariant defect is captured when --fingerprint matches the mission's own invariant finding",
  async () => {
    broken = true; // irrelevant to this page, but keep the shared server's default state
    const dir = await mkdtemp(join(tmpdir(), "cli-regr-invariant-"));
    const invariantRecording: Recording = {
      version: "1.0.0",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } },
            { step: { kind: "click", target: { testId: "save" }, expect: { kind: "visible", target: { testId: "save" } } } },
          ],
        },
      ],
    };
    const recordingPath = join(dir, "invariant.json");
    await writeFile(recordingPath, JSON.stringify(invariantRecording));
    const fp = "b".repeat(16);
    const resultPath = join(dir, "invariant.result.json");
    await writeFile(
      resultPath,
      JSON.stringify({
        result: {
          target: { seedUrl: origin, allowlist: [origin] },
          recording: invariantRecording,
          defects: [{ fingerprint: fp, kind: "invariant", invariant: { id: "confirm-banner-visible" }, repro: { recordingStepIndex: 1 } }],
          invariantSpec: { invariants: [{ id: "confirm-banner-visible", always: { kind: "visible", target: { testId: "confirm-banner" } } }] },
        },
      }),
    );
    const regressionsDir = join(dir, "regressions");
    const opened: Array<() => Promise<void>> = [];
    try {
      const result = await runRegressionCapture({
        failingRecordingPath: recordingPath,
        id: "confirm-banner",
        regressionsDir,
        attempts: 1,
        resultPath,
        fingerprint: fp, // the DEFECT fingerprint, not a step signature
        makeActor: async () => {
          const { actor, close } = await realActor();
          opened.push(close);
          return actor;
        },
      });
      expect(result).toMatchObject({ recordingPath: expect.stringContaining("confirm-banner.recording.json") });
      const meta = JSON.parse(await readFile(join(regressionsDir, "confirm-banner.meta.json"), "utf8"));
      expect(meta.oracle).toMatchObject({ kind: "invariant", invariantId: "confirm-banner-visible", defectFingerprint: fp });

      const run = await runRegressionRun({
        id: "confirm-banner",
        regressionsDir,
        attempts: 1,
        makeActor: async () => {
          const { actor, close } = await realActor();
          opened.push(close);
          return actor;
        },
      });
      expect(run.verdict).toBe("reproduces"); // the banner never renders on this page — still violated
    } finally {
      for (const close of opened) await close();
    }
  },
  60000,
);

// ---------------------------------------------------------------------------
// Scenario 4 (#119): the error messages are accurate — never "pass --result" when it was passed,
// never "no failed check" when one WAS found (just unusable/engine-refused).
// ---------------------------------------------------------------------------

const neverCalledActor = async (): Promise<Actor> => {
  throw new Error("must not open a browser when there is nothing to reproduce");
};

test("no usable oracle: the error names what WAS found (an engine refusal), not a generic 'no failed check'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-regr-msg-"));
  const recordingPath = join(dir, "r.json");
  await writeFile(recordingPath, JSON.stringify(swapRecording));
  const resultPath = join(dir, "r.result.json");
  await writeFile(
    resultPath,
    JSON.stringify({
      result: {
        checks: [{ check: "visible:testId=next", passed: true, detail: "ok" }],
        transcript: [
          {
            step: 1,
            op: "click",
            actOk: false,
            origin: "engine",
            reason: 'repeated side effect refused: "Save" already sent POST /x — clicking it again would repeat that action',
            url: "/x",
            descriptor: { testId: "save" },
          },
        ],
      },
    }),
  );
  await expect(
    runRegressionCapture({ failingRecordingPath: recordingPath, id: "x", regressionsDir: join(dir, "regressions"), resultPath, makeActor: neverCalledActor }),
  ).rejects.toThrow(NoOracleInResultError);
  await expect(
    runRegressionCapture({ failingRecordingPath: recordingPath, id: "x", regressionsDir: join(dir, "regressions"), resultPath, makeActor: neverCalledActor }),
  ).rejects.toThrow(/engine refusal/);
});

test("a failed check that could not be parsed is named as such, not reported as 'no failed check'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-regr-msg2-"));
  const recordingPath = join(dir, "r.json");
  await writeFile(recordingPath, JSON.stringify(swapRecording));
  const resultPath = join(dir, "r.result.json");
  await writeFile(
    resultPath,
    JSON.stringify({ result: { checks: [{ check: "not-a-real-check-kind:garbage", passed: false, detail: "?" }], transcript: [] } }),
  );
  await expect(
    runRegressionCapture({ failingRecordingPath: recordingPath, id: "x", regressionsDir: join(dir, "regressions"), resultPath, makeActor: neverCalledActor }),
  ).rejects.toThrow(/1 failed check\(s\) could not be parsed into an oracle/);
});

test("--fingerprint mismatch names the derived oracle it disagreed with, never claims no check failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-regr-msg3-"));
  const recordingPath = join(dir, "r.json");
  await writeFile(recordingPath, JSON.stringify(swapRecording));
  const resultPath = join(dir, "r.result.json");
  await writeFile(resultPath, JSON.stringify(swapResult));
  await expect(
    runRegressionCapture({
      failingRecordingPath: recordingPath,
      id: "x",
      regressionsDir: join(dir, "regressions"),
      resultPath,
      fingerprint: "not-a-real-fingerprint",
      makeActor: neverCalledActor,
    }),
  ).rejects.toThrow(FingerprintMismatchError);
  await expect(
    runRegressionCapture({
      failingRecordingPath: recordingPath,
      id: "x",
      regressionsDir: join(dir, "regressions"),
      resultPath,
      fingerprint: "not-a-real-fingerprint",
      makeActor: neverCalledActor,
    }),
  ).rejects.toThrow(/does not match the oracle derived from --result/);
});

test("a Recording that never fails, with no --result, still gets #81's original message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-regr-msg4-"));
  const recordingPath = join(dir, "r.json");
  await writeFile(recordingPath, JSON.stringify(swapRecording));
  await expect(
    runRegressionCapture({
      failingRecordingPath: recordingPath,
      id: "x",
      regressionsDir: join(dir, "regressions"),
      attempts: 1,
      makeActor: makeValueActor("anything"), // no --result, no --fingerprint: the interpreter runs the Recording as-is (no `assert`/oracle step) and never "fails"
    }),
  ).rejects.toThrow(NoFailureToReproduceError);
});

// ---------------------------------------------------------------------------
// #129 item 5: the `jevitate regression capture` / `jevitate regression run` CLI commands
// themselves (Commander wiring, --storage-state, exit codes) — real server + real browser, end to
// end through `buildProgram`, mirroring `verify-fix-api.test.ts`'s "CLI surface" tests.
// ---------------------------------------------------------------------------

test(
  "regression capture / regression run — CLI surface: reproduces (exit 1) while broken, fixed (exit 0) once fixed",
  async () => {
    broken = true;
    const dir = await mkdtemp(join(tmpdir(), "cli-regr-cmd-"));
    // A network-check oracle (#119/#129): committed AS-IS, never minimized — unlike the default
    // step-oracle path, so this wiring test isn't at the mercy of `minimizeRecording` collapsing the
    // navigate step (a structurally-matching-but-differently-caused failure on a blank page is a
    // separate, pre-existing characteristic of ddmin-style minimization, not something this ticket
    // touches).
    const recording: Recording = {
      version: "1.0.0",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } },
            { step: { kind: "click", target: { testId: "save" }, expect: { kind: "visible", target: { testId: "save" } } } },
          ],
        },
      ],
    };
    const fromPath = join(dir, "cmd.json");
    await writeFile(fromPath, JSON.stringify(recording));
    const resultPath = join(dir, "cmd.result.json");
    await writeFile(
      resultPath,
      JSON.stringify({
        result: {
          checks: [{ check: "responseStatus:POST /api/profile=2xx", passed: false, detail: "expected 2xx, got 500" }],
          transcript: [{ step: 1, op: "click", actOk: true, url: origin + "/", descriptor: { testId: "save" } }],
        },
      }),
    );
    const regressionsDir = join(dir, "regressions");

    const capture = buildProgram({ profiles: {} as unknown as ProfileManager });
    await capture.parseAsync([
      "node",
      "jevitate",
      "regression",
      "capture",
      "--from",
      fromPath,
      "--id",
      "cli-cmd",
      "--dir",
      regressionsDir,
      "--attempts",
      "1",
      "--result",
      resultPath,
      "--json",
    ]);
    expect(JSON.parse(await readFile(join(regressionsDir, "cli-cmd.meta.json"), "utf8")).oracle).toMatchObject({ kind: "network" });

    const runStillBroken = buildProgram({ profiles: {} as unknown as ProfileManager });
    await runStillBroken.parseAsync(["node", "jevitate", "regression", "run", "cli-cmd", "--dir", regressionsDir, "--json"]);
    expect(runStillBroken.exitCode ?? process.exitCode).toBe(1);

    broken = false;
    const runFixed = buildProgram({ profiles: {} as unknown as ProfileManager });
    await runFixed.parseAsync(["node", "jevitate", "regression", "run", "cli-cmd", "--dir", regressionsDir, "--json"]);
    expect(runFixed.exitCode ?? process.exitCode).toBe(0);
  },
  60000,
);
