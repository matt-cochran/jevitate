import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import { verifyFix, type VerifySession } from "./verify-fix.js";
import { signalFingerprint } from "./adversarial/defect-fingerprint.js";

/**
 * verify-fix on a replay that cannot find (or tell apart) a recorded element is INCONCLUSIVE —
 * never "fixed", and not "still reproduces" either: the recorded path was not reproduced, so what
 * the replay saw proves nothing about the defect.
 */

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/boom") {
      res.writeHead(500, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/two-go") {
      // The defect's signal fires on load — but the recorded "Go" cannot be told apart.
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><html><body><button type="button">Go</button><button type="button">Go</button><script>fetch("/api/boom")</script></body></html>`);
      return;
    }
    if (path === "/no-go") {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><html><body><button type="button">Going</button><script>fetch("/api/boom")</script></body></html>`);
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

const recording = (path: string, target: TargetDescriptor): Recording => ({
  version: "1.0.0",
  site: "test",
  pages: [
    {
      url: path,
      steps: [
        { step: { kind: "navigate", url: path, expect: { kind: "urlIncludes", text: path } } },
        { step: { kind: "click", target, expect: { kind: "urlIncludes", text: path } } },
        { step: { kind: "click", target, expect: { kind: "urlIncludes", text: path } } },
      ],
    },
  ],
});

const boom = signalFingerprint({ kind: "http-5xx", detail: "500", url: "http://x/api/boom", status: 500 });

describe("verify-fix never trusts a replay that could not follow the recorded path", () => {
  it.each([
    ["/two-go", "ambiguous"],
    ["/no-go", "replay-target-not-found"],
  ])("%s → the typed %s failure makes the verdict inconclusive", async (path, reason) => {
    const r = await verifyFix({
      recording: recording(path, { role: "button", name: "Go" }),
      recordingStepIndex: 2,
      fingerprint: boom,
      defectKind: "http-5xx",
      openSession: freshSession,
      settleCeilingMs: 3_000,
      targetTimeoutMs: 800,
    });
    expect(r.verdict).toBe("inconclusive");
    expect(r.replay).toMatchObject({ outcome: "failed", at: 1, reason });
    // The defect's signal DID fire on load — it still is not reported as reproducing (or fixed).
    expect(r.observedFingerprints).toContain(boom);
  });
});
