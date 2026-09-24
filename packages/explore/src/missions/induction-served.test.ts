import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runInductionMission } from "./induction.js";

/**
 * #75 — a visually-hidden "Skip to content" link ate about a third of the coverage/exploratory
 * budget with 30s timeouts, and the frontier never got past global nav into a page's own controls.
 * Served fixture (the issue's own minimal repro): the in-page button gets exercised, there are no
 * skip-link timeouts, and a coverage report that spent its budget on nothing but a failing skip link
 * and global nav is `inconclusive`, never `clean`.
 */

let server: Server;
let origin: string;

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    switch (path) {
      case "/skip-link":
        res.writeHead(200, { "content-type": "text/html" }).end(
          html(
            `<a href="#main" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden">Skip to content</a>` +
              `<nav><a href="/a">A</a> <a href="/b">B</a></nav>` +
              `<main id="main"><button onclick="this.textContent='clicked'">In-page action</button></main>`,
          ),
        );
        return;
      case "/a":
        res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>A</h1>`));
        return;
      case "/b":
        res.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>B</h1>`));
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("runInductionMission — a visually-hidden skip link never burns the budget (#75)", () => {
  it(
    "the in-page button gets exercised, no skip-link timeouts, and the run finishes well within the mission's own bound",
    async () => {
      const browserPort = new PlaywrightBrowserPort();
      const session: BrowserSession = await browserPort.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      try {
        const actor = CastActor.named("coverage-skip-link").whoCan(new BrowseTheWeb(session, [origin]));
        const start = Date.now();
        const result = await runInductionMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${origin}/skip-link`,
          allowlist: [origin],
          bounds: { maxActions: 20, maxDecisions: 40, maxCandidates: 250 },
        });
        const elapsedMs = Date.now() - start;

        expect(result.outcome).toBe("exhausted");
        // Well under even ONE Playwright default actionability timeout (30s) — proves the skip
        // link never made the run wait one out.
        expect(elapsedMs).toBeLessThan(20_000);

        // The skip link failed exactly once (gate refusal) — never retried from /a or /b, which
        // also offer it (same control identity, blacklisted after its first failure).
        expect(result.coverage.failedActions).toBe(1);
        const skipLinkSteps = result.transcript.filter((e) => e.target?.includes("Skip to content") === true);
        expect(skipLinkSteps).toHaveLength(1);
        expect(skipLinkSteps[0]?.actOk).toBe(false);
        expect(skipLinkSteps[0]?.reason).toContain("visually-hidden skip link");

        // The in-page button — a non-nav control — WAS exercised.
        const inPageSteps = result.transcript.filter((e) => e.target?.includes("In-page action") === true);
        expect(inPageSteps.some((e) => e.actOk)).toBe(true);
        expect(result.coverage.sufficiency.nonNavActionsExercised).toBeGreaterThan(0);
        expect(result.coverage.sufficiency.sufficient).toBe(true);
        expect(result.coverage.sufficiency.shortfalls).toEqual([]);
      } finally {
        await session.close();
      }
    },
    30_000,
  );

  it(
    "a run that only ever fails (nothing but a blacklisted skip link, capped before any control lands) reports insufficient coverage",
    async () => {
      const browserPort = new PlaywrightBrowserPort();
      const session: BrowserSession = await browserPort.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      try {
        const actor = CastActor.named("coverage-skip-link-thin").whoCan(new BrowseTheWeb(session, [origin]));
        const result = await runInductionMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${origin}/skip-link`,
          allowlist: [origin],
          // Capped at ONE action: the frontier's first pop is the skip link (it fails), and the
          // run stops before anything else is tried.
          bounds: { maxActions: 1, maxDecisions: 10, maxCandidates: 250 },
        });
        expect(result.coverage.failedActions).toBe(1);
        expect(result.coverage.sufficiency.sufficient).toBe(false);
        expect(result.coverage.sufficiency.shortfalls.length).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
    },
    30_000,
  );
});
