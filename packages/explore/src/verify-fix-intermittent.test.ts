import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { verifyFix, verifyReplayVerdict, type ReplayAttemptEvidence, type VerifySession } from "./verify-fix.js";
import { signalFingerprint } from "./adversarial/defect-fingerprint.js";

/**
 * #74: verify-fix must not say `fixed` after a single clean replay of an INTERMITTENT signal.
 * A fake page whose signal fires on every 2nd load must give `intermittent`, never `fixed`.
 */

describe("verifyReplayVerdict — only attempts that RAN count, and a mix is never `fixed`", () => {
  const run = (ran: boolean, fired: boolean): Pick<ReplayAttemptEvidence, "ran" | "fired"> => ({ ran, fired });

  it.each<[string, Array<Pick<ReplayAttemptEvidence, "ran" | "fired">>, string]>([
    ["absent on every attempt that ran → fixed", [run(true, false), run(true, false), run(true, false)], "fixed"],
    ["fired on every attempt that ran → still-reproduces", [run(true, true), run(true, true)], "still-reproduces"],
    ["fired on some, absent on others → intermittent, never fixed", [run(true, true), run(true, false), run(true, true)], "intermittent"],
    ["fired once out of three → still intermittent, not fixed", [run(true, true), run(true, false), run(true, false)], "intermittent"],
    ["no attempt ran → inconclusive", [run(false, false), run(false, false)], "inconclusive"],
    ["a run that never ran is not evidence: one clean run + one that never ran → fixed", [run(true, false), run(false, false)], "fixed"],
    ["nothing attempted → inconclusive", [], "inconclusive"],
  ])("%s", (_name, runs, want) => {
    expect(verifyReplayVerdict(runs)).toBe(want);
  });
});

describe("verifyFix — a signal that fires on every 2nd load", () => {
  let server: Server;
  let origin: string;
  let n = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (path === "/api/flaky") {
        n += 1;
        // Fires (500) on odd loads, clean (200) on even loads: exactly every-other.
        res.writeHead(n % 2 === 1 ? 500 : 200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (path === "/flaky-page") {
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body>ok<script>fetch("/api/flaky")</script></body></html>`);
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
        url: "/flaky-page",
        steps: [{ step: { kind: "navigate", url: "/flaky-page", expect: { kind: "urlIncludes", text: "/flaky-page" } } }],
      },
    ],
  };

  const fingerprint = signalFingerprint({ kind: "http-5xx", detail: "500", url: "http://x/api/flaky", status: 500 });

  it(
    "never reports `fixed` for an intermittent signal — a single replay would have wrongly cleared it",
    async () => {
      n = 0; // fresh count for this test
      const result = await verifyFix({
        recording,
        recordingStepIndex: 0,
        fingerprint,
        defectKind: "http-5xx",
        openSession: freshSession,
        settleCeilingMs: 3_000,
        replays: 4,
      });
      // Loads 1,3 fire (500); loads 2,4 don't: 2/4 ran fired → neither fixed nor still-reproduces.
      expect(result.verdict).toBe("intermittent");
      expect(result.attempts).toHaveLength(4);
      expect(result.attempts?.map((a) => a.ran)).toEqual([true, true, true, true]);
      expect(result.attempts?.filter((a) => a.fired)).toHaveLength(2);
      // Crucially: NOT fixed, even though half the replays were individually clean.
      expect(result.verdict).not.toBe("fixed");
    },
    60_000,
  );

  it(
    "with the default replay count (3), a single clean replay never reads as `fixed`",
    async () => {
      n = 0;
      const result = await verifyFix({
        recording,
        recordingStepIndex: 0,
        fingerprint,
        defectKind: "http-5xx",
        openSession: freshSession,
        settleCeilingMs: 3_000,
      });
      // 3 replays: fire, clean, fire → intermittent (never fixed on the strength of the one clean run).
      expect(result.attempts).toHaveLength(3);
      expect(result.verdict).not.toBe("fixed");
    },
    60_000,
  );
});
