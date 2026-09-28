import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { verifyFix, type VerifySession } from "./verify-fix.js";

/**
 * #213 dogfood: an inconclusive verify-fix whose replay could not reach the defect's step because
 * the target itself was unreachable used to say only "failed at step N" — the real cause (a
 * connection refused) never reached the human REASON, so a re-runner chased the wrong thing. The
 * replay's own `replay.error` (e.g. `net::ERR_CONNECTION_REFUSED at http://…`) must show in `reason`.
 */

async function unreachableOrigin(): Promise<string> {
  // A real server, closed immediately: its port is unused, so a connection to it is REFUSED — not
  // just slow/timed-out, which lets the test assert on the real error rather than race a timeout.
  const server: Server = createServer((_req, res) => res.writeHead(200).end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return origin;
}

const recording = (origin: string): Recording => ({
  version: "1.0.0",
  site: "test",
  pages: [{ url: origin, steps: [{ step: { kind: "navigate", url: origin, expect: { kind: "urlIncludes", text: origin } } }] }],
});

describe("verifyFix — an unreachable target's REASON names the real cause, never just 'failed'", () => {
  it("navigation refused at the defect's step: reason includes the connection-refused error, not just 'failed at step N'", async () => {
    const origin = await unreachableOrigin();
    const port = new PlaywrightBrowserPort();
    const openSession = async (): Promise<VerifySession> => {
      const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      const actor = CastActor.named("verify").whoCan(new BrowseTheWeb(session, [origin]));
      return { page: session.page, actor, close: () => session.close() };
    };
    const r = await verifyFix({
      recording: recording(origin),
      recordingStepIndex: 0,
      fingerprint: "deadbeefdeadbeef",
      defectKind: "http-5xx",
      openSession,
      settleCeilingMs: 1_000,
      targetTimeoutMs: 3_000,
      replays: 1,
    });
    expect(r.verdict).toBe("inconclusive");
    expect(r.reason).toMatch(/refused|ERR_CONNECTION_REFUSED|ECONNREFUSED/i);
    expect(r.reason).not.toBe("replay could not reach the defect's step (failed at step 0); absence of the signal proves nothing");
  }, 20_000);
});
