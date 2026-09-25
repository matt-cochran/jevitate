import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { replayAndDetectHang } from "./hang-repro.js";
import type { HangSignal } from "./hang.js";
import { verifyFix, type VerifySession } from "./verify-fix.js";

/**
 * #164 (second part) — a hang replay declared `replay-target-not-found` for a control that only
 * renders once a lazily loaded route finishes (a Save button ~2s after load on a dev server). The
 * replay waits for a step's target with the same bounded render wait the explore loop uses
 * (`renderWaitMs`), then proceeds; a target that never renders within that bound is still
 * `replay-target-not-found` — `inconclusive`, never `fixed`.
 */

let server: Server;
let origin: string;
/** Toggled per test: after Save, the busy indicator either never clears (broken) or is determinate (fixed). */
let broken = true;
/** How long the lazy route takes to render the Save button (ms); null: it never renders. */
let renderAfterMs: number | null = 2_000;

const page = (): string => `<!doctype html><html><body>
  <h1>Profile</h1>
  <div id="route"></div>
  <script>
    const show = () => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Save";
      b.dataset.testid = "profile-save-btn";
      b.addEventListener("click", () => {
        const p = document.createElement("div");
        p.setAttribute("role", "progressbar");
        p.dataset.testid = "save-spinner";
        p.style.cssText = "width:24px;height:24px";
        ${broken ? "" : 'p.setAttribute("aria-valuenow", "100");'}
        document.body.appendChild(p);
      });
      document.getElementById("route").appendChild(b);
    };
    ${renderAfterMs === null ? "" : `setTimeout(show, ${renderAfterMs});`}
  </script>
</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/profile") {
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
      url: "/profile",
      steps: [
        { step: { kind: "navigate", url: "/profile", expect: { kind: "urlIncludes", text: "/profile" } } },
        { step: { kind: "click", target: { testId: "profile-save-btn" }, expect: { kind: "urlIncludes", text: "/profile" } } },
      ],
    },
  ],
};

const hang = (): HangSignal => ({
  kind: "ui-no-progress",
  detail: "a busy indicator ([data-testid=save-spinner]) never went away within 15000ms",
  route: "/profile",
  url: `${origin}/profile`,
  pending: [],
  lastState: { signature: "irrelevant", controls: [] },
  element: "[data-testid=save-spinner]",
});

// The render-wait bound: long enough for the 2s route, short enough to keep the "never" case quick.
const perceiveOpts = { renderWaitMs: 4_000, hangProbeMs: 500 };

describe("#164 — a hang replay waits (bounded by renderWaitMs) for a lazily rendered step target", () => {
  it("the target renders after ~2s: the replay proceeds and the hang still reproduces", async () => {
    broken = true;
    renderAfterMs = 2_000;
    const attempt = await replayAndDetectHang({ recording, recordingStepIndex: 1, hang: hang(), openSession: freshSession, perceive: perceiveOpts });
    expect(attempt.replay).toBe("completed");
    expect(attempt.ran).toBe(true);
    expect(attempt.reproduced).toBe(true);
    expect(attempt.rule).toBe("busy-indicator");
  }, 60_000);

  it("the target renders after ~2s on the fixed app: verify-fix reads FIXED, not inconclusive", async () => {
    broken = false;
    renderAfterMs = 2_000;
    const r = await verifyFix({ defectKind: "hang", fingerprint: "f", recording, recordingStepIndex: 1, hang: hang(), openSession: freshSession, perceive: perceiveOpts });
    expect(r.replay).toEqual({ outcome: "completed" });
    expect(r.verdict).toBe("fixed");
  }, 60_000);

  it("a target that never renders within the bound is still replay-target-not-found: inconclusive, never fixed", async () => {
    broken = false;
    renderAfterMs = null;
    const t0 = Date.now();
    const r = await verifyFix({ defectKind: "hang", fingerprint: "f", recording, recordingStepIndex: 1, hang: hang(), openSession: freshSession, perceive: perceiveOpts });
    expect(r.verdict).toBe("inconclusive");
    expect(r.reason).toMatch(/replay-target-not-found/);
    // Bounded by the render wait, not the interpreter's 15s default.
    expect(Date.now() - t0).toBeLessThan(12_000);
  }, 60_000);
});
