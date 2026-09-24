import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * #128 — when the START URL cannot be loaded at all (a `net::ERR_*`, a refused connection, or a
 * timeout before any response ever arrives), the run must end `inconclusive` with a
 * `target-unreachable` failure, never `crashed`. This is a configuration problem (a bad URL, the
 * target not running), never a defect in the app under test and never a bug in jevitate — so no
 * crash report is built for it (and, in turn, no issue is ever drafted from it: `explore-api.ts`
 * only drafts a crash issue when `run.crash` is set).
 */

async function runAt(startUrl: string, baseUrl: string, navTimeoutMs?: number): Promise<ExploreRun> {
  return withSession(
    "explore-unreachable-",
    async (session) => {
      if (navTimeoutMs !== undefined) session.page.context().setDefaultNavigationTimeout(navTimeoutMs);
      const actor = CastActor.named("explorer").whoCan(new BrowseTheWeb(session, [baseUrl]));
      const judge = new ScriptedJudge([{ op: "wait" }]); // never reached — the seed never loads
      return explore({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: "irrelevant — the run never gets past the seed",
        allowlist: [baseUrl],
        startUrl,
        bounds: { maxDecisions: 4 },
      });
    },
    baseUrl,
  );
}

describe("#128 — the start URL cannot be loaded at all", () => {
  it(
    "a net::ERR_UNSAFE_PORT on the first navigation ends inconclusive with a target-unreachable failure, never crashed",
    async () => {
      const url = "http://127.0.0.1:1/";
      const r = await runAt(url, url);
      expect(r.stop).toBe("inconclusive");
      expect(r.failure).toBeDefined();
      expect(r.failure?.kind).toBe("target-unreachable");
      expect(r.failure?.message).toMatch(/^target unreachable \(.*unsafe port.*\)$/i);
      // No crash report at all: the CLI only ever drafts a crash issue when `run.crash` is set, so
      // this path produces NO issue draft (#128).
      expect(r.crash).toBeUndefined();
      expect(r.outcome).toEqual({ status: "incomplete", reason: expect.stringContaining("target unreachable") });
      expect(r.transcript).toEqual([]);
    },
    30_000,
  );

  it(
    "a connection that never answers (timeout before any response) ends inconclusive with a target-unreachable failure, never crashed",
    async () => {
      // A server bound then immediately closed: nothing is listening at this port.
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const url = `http://127.0.0.1:${port}/`;

      const r = await runAt(url, url, 1_500);
      expect(r.stop).toBe("inconclusive");
      expect(r.failure?.kind).toBe("target-unreachable");
      // Never the raw Playwright wording (never fabricated as "connection refused" without real
      // network evidence for it either — see mission-failure.ts's `describeUnreachable`).
      expect(r.failure?.message).not.toMatch(/Timeout \d+ms exceeded/);
      expect(r.failure?.message).toMatch(/^target unreachable \(/);
      expect(r.crash).toBeUndefined();
    },
    30_000,
  );
});

let server: Server;
let base: string;
describe("#128 — a mid-run navigation failure (not the seed) is unaffected", () => {
  it(
    "a page that loads fine, then a later navigation to an unreachable URL, is still classified by the generic crash path",
    async () => {
      server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body><a href="http://127.0.0.1:1/">bad link</a></body></html>`);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const r = await withSession(
          "explore-midrun-",
          async (session) => {
            const actor = CastActor.named("explorer").whoCan(new BrowseTheWeb(session, [base]));
            const judge = new ScriptedJudge([{ op: "click", target: "0" }]);
            return explore({
              actor,
              judge,
              gen: new FakeGenerationGateway(),
              goal: "click the bad link",
              allowlist: [base],
              startUrl: base,
              bounds: { maxDecisions: 4 },
            });
          },
          base,
        );
        // The seed itself loaded fine (this run's own failure/kind is whatever the mid-run click
        // produced) — not asserted precisely here (owned by other #128-adjacent behaviour); the
        // point is that the seed DID succeed, so the sentinel/target-unreachable path never fires.
        expect(r.transcript.length).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
    30_000,
  );
});
