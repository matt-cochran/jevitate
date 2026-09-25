import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { busyIndicatorOf, replayAndDetectHang, type ReproduceHangParams } from "./hang-repro.js";
import type { HangSignal } from "./hang.js";
import { perceive } from "./perceive.js";
import { verifyFix, type VerifySession } from "./verify-fix.js";

/**
 * #108 — a busy-indicator `ui-no-progress` hang: the original evidence was a specific spinner/
 * progressbar (`HangSignal.element` set) that never cleared. Reproduction must re-check THAT
 * indicator, not fall back to "landed on the same page signature" — a fixed, settled page has a
 * perfectly stable signature too, so that rule alone can never let a real fix read as fixed.
 */

let server: Server;
let origin: string;
// Toggled per test: the served page's busy indicator either clears (fixed) or never does (broken).
let broken = true;

const page = (): string => `<!doctype html><html><body>
  <h1>Loading</h1>
  <div role="progressbar" data-testid="spinner" style="width:24px;height:24px"${broken ? "" : ' aria-valuenow="50"'}></div>
  <button type="button">Refresh</button>
</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/busy-page") {
      res.writeHead(200, { "content-type": "text/html" }).end(page());
      return;
    }
    res.writeHead(404).end();
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
async function freshSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  const actor = CastActor.named("verify").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

const recording: Recording = {
  version: "1.0.0",
  site: "test",
  pages: [
    {
      url: "/busy-page",
      steps: [{ step: { kind: "navigate", url: "/busy-page", expect: { kind: "urlIncludes", text: "/busy-page" } } }],
    },
  ],
};

// The original hang's evidence: a specific busy indicator (its element identity is set — #108's
// distinguishing signal), never a stalled-state hang (which would leave `element` undefined).
const busyIndicatorHang: HangSignal = {
  kind: "ui-no-progress",
  detail: 'a busy indicator ([data-testid=spinner] <div>) never went away within 15000ms',
  route: "/busy-page",
  url: `${origin}/busy-page`,
  pending: [],
  lastState: { signature: "irrelevant-to-this-rule", controls: [] },
  element: "[data-testid=spinner]",
};

function params(): ReproduceHangParams {
  return {
    recording,
    recordingStepIndex: 0,
    hang: busyIndicatorHang,
    openSession: freshSession,
    perceive: { renderWaitMs: 1_500, hangProbeMs: 500 },
  };
}

describe("#108 — replayAndDetectHang re-checks the SAME busy indicator, not the page signature", () => {
  it("the busy indicator is gone and the page settled: verifies FIXED, never 'still reproduces'", async () => {
    broken = false;
    const attempt = await replayAndDetectHang(params());
    expect(attempt.ran).toBe(true);
    expect(attempt.reproduced).toBe(false);
    expect(attempt.detail).toMatch(/busy-indicator rule/);
    expect(attempt.detail).toMatch(/gone|fixed/);
  }, 30_000);

  it("the SAME busy indicator is still there: still reproduces", async () => {
    broken = true;
    const attempt = await replayAndDetectHang(params());
    expect(attempt.ran).toBe(true);
    expect(attempt.reproduced).toBe(true);
    expect(attempt.kind).toBe("ui-no-progress");
    expect(attempt.detail).toMatch(/busy-indicator rule/);
    expect(attempt.detail).toMatch(/is back/);
  }, 30_000);

  it("a DIFFERENT busy indicator on the fixed page is not treated as the same hang reproducing", async () => {
    broken = false;
    // A page that shows a DIFFERENT indicator (no aria-valuenow issue for THIS element — describes
    // differently) must not count as the original hang coming back.
    const differentElementHang: HangSignal = { ...busyIndicatorHang, element: "[data-testid=some-other-spinner]" };
    const attempt = await replayAndDetectHang({ ...params(), hang: differentElementHang });
    expect(attempt.reproduced).toBe(false);
  }, 30_000);
});

describe("#164 — a busy-indicator hang persisted WITHOUT `element` (pre-#87 engine) is still judged by its indicator", () => {
  // The round-3 evidence: the signal carries no `element`, and its indicator is named only in the
  // detail, in the old `<selector> <tag>` form. Its lastState signature is the page's REAL one — a
  // fixed page that settles on that same state must never read as "the same stalled state".
  const legacy = (signature: string): HangSignal => ({
    kind: "ui-no-progress",
    detail: 'a busy indicator ([role="progressbar"]:not([aria-valuenow]) <div>) never went away within 15000ms',
    route: "/busy-page",
    url: `${origin}/busy-page`,
    pending: [],
    lastState: { signature, controls: [] },
  });
  async function realSignature(): Promise<string> {
    const s = await freshSession();
    try {
      await s.page.goto(`${origin}/busy-page`);
      return (await perceive(s.page, { renderWaitMs: 1_500, hangProbeMs: 500 })).snapshot.signature;
    } finally {
      await s.close();
    }
  }
  const noSleep = { stallMs: 1, sleep: async (): Promise<void> => undefined };

  it("busyIndicatorOf recovers the indicator from the detail; a no-indicator stall stays a stalled-state hang", () => {
    expect(busyIndicatorOf(legacy("s"))).toBe('[role="progressbar"]:not([aria-valuenow]) <div>');
    expect(busyIndicatorOf({ kind: "ui-no-progress", detail: "the UI made no progress" })).toBeNull();
    expect(busyIndicatorOf({ kind: "ui-no-progress", detail: "x", element: "[data-testid=a]" })).toBe("[data-testid=a]");
    expect(busyIndicatorOf({ kind: "never-settled", detail: "a busy indicator (x) never went away within 1ms" })).toBeNull();
  });

  it("the indicator is gone (app fixed) on the same settled state: FIXED by the busy-indicator rule, never 'still reproduces'", async () => {
    broken = false;
    const hang = legacy(await realSignature());
    const attempt = await replayAndDetectHang({ ...params(), hang, ...noSleep });
    expect(attempt.ran).toBe(true);
    expect(attempt.reproduced).toBe(false);
    expect(attempt.rule).toBe("busy-indicator");
    expect(attempt.busyIndicators).toBe(0);
    expect(attempt.detail).not.toMatch(/stalled-state/);
  }, 30_000);

  it("the same (legacy-described) indicator is still stuck: still reproduces", async () => {
    broken = true;
    const hang = legacy(await realSignature());
    const attempt = await replayAndDetectHang({ ...params(), hang, ...noSleep });
    expect(attempt.reproduced).toBe(true);
    expect(attempt.rule).toBe("busy-indicator");
    expect(attempt.busyIndicators).toBe(1);
  }, 30_000);

  it("verifyFix reads FIXED and records the attempt (rule + indicator count)", async () => {
    broken = false;
    const hang = legacy(await realSignature());
    const r = await verifyFix({
      defectKind: "hang",
      fingerprint: "f",
      recording,
      recordingStepIndex: 0,
      hang,
      openSession: freshSession,
      perceive: { renderWaitMs: 1_500, hangProbeMs: 500 },
      stallMs: 1,
    });
    expect(r.verdict).toBe("fixed");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts?.[0]).toMatchObject({ ran: true, fired: false, rule: "busy-indicator", busyIndicators: 0 });
  }, 30_000);
});
