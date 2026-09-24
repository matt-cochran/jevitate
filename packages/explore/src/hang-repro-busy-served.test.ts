import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { replayAndDetectHang, type ReproduceHangParams } from "./hang-repro.js";
import type { HangSignal } from "./hang.js";
import type { VerifySession } from "./verify-fix.js";

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
