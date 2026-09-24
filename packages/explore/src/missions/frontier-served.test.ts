import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runInductionMission, type InductionMissionParams } from "./induction.js";
import { runFeatureMission } from "./feature.js";
import type { TranscriptEntry } from "../transcript.js";

/**
 * Served fixtures for the frontier missions (coverage, exploratory, `--feature`):
 *
 *  - #114: after a departure ("Sign out"), the seed redirects to a login page, or stops answering.
 *    The run used to replay every queued item against the login page (each waiting out a missing
 *    target) and sit idle for minutes; it now ends with a typed stop at once, and a no-progress
 *    watchdog ends any wait that never finishes.
 *  - #115: a sidebar of 8 nav links around 3 in-page controls — the in-page controls come first and
 *    nav is at most 20% of the actions; and exploratory's order measurably differs from coverage's.
 */

let server: Server;
let origin: string;
/** Once set (by visiting /elsewhere), /slow never answers again. */
let slowSeedHangs = false;

const html = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;
const signedIn = (cookie: string | undefined): boolean => /(?:^|;\s*)sid=1(?:;|$)/.test(cookie ?? "");

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const ok = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(html(body));
    switch (path) {
      case "/settings":
        if (!signedIn(req.headers.cookie)) {
          res.writeHead(302, { location: "/login" }).end();
          return;
        }
        ok(
          `<main><button onclick="document.getElementById('d').hidden=false">Show details</button>` +
            `<div id="d" hidden>` +
            `<button onclick="document.cookie='sid=; Max-Age=0; path=/'; location.href='/'">Sign out</button>` +
            [1, 2, 3, 4, 5].map((n) => `<button>Detail ${n}</button>`).join("") +
            `</div></main>`,
        );
        return;
      case "/slow":
        if (slowSeedHangs) return; // never answers
        ok(
          `<main><button onclick="location.href='/elsewhere'">Go elsewhere</button>` +
            `<button onclick="document.getElementById('m').hidden=false">Show more</button>` +
            `<div id="m" hidden><button>More 1</button></div></main>`,
        );
        return;
      case "/elsewhere":
        slowSeedHangs = true;
        ok(`<h1>Elsewhere</h1>`);
        return;
      case "/app/page":
        ok(
          `<aside><nav>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<a href="/other${n}">Section ${n}</a>`).join(" ")}</nav></aside>` +
            `<main><button onclick="this.dataset.n='1'">Refresh</button>` +
            `<button onclick="this.dataset.n='1'">Export</button>` +
            `<button onclick="this.dataset.n='1'">Archive</button></main>`,
        );
        return;
      case "/panels":
        ok(
          `<main>` +
            ["A", "B", "C"]
              .map((p) => `<button onclick="document.getElementById('p${p}').hidden=false">Open ${p}</button>`)
              .join("") +
            ["A", "B", "C"].map((p) => `<div id="p${p}" hidden><button>${p}1</button></div>`).join("") +
            `</main>`,
        );
        return;
      case "/":
        ok(`<h1>Home</h1>`);
        return;
      case "/login":
        ok(`<h1>Log in</h1>`);
        return;
      default:
        if (path.startsWith("/other")) {
          ok(`<h1>${path}</h1>`);
          return;
        }
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

async function withSession<T>(fn: (session: BrowserSession, actor: CastActor) => Promise<T>): Promise<T> {
  const session = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  try {
    await session.page.context().addCookies([{ name: "sid", value: "1", url: origin }]);
    return await fn(session, CastActor.named("frontier-served").whoCan(new BrowseTheWeb(session, [origin])));
  } finally {
    await session.close();
  }
}

function coverage(session: BrowserSession, actor: CastActor, over: Partial<InductionMissionParams>) {
  return runInductionMission({
    page: session.page,
    actor,
    judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
    generation: new FakeGenerationGateway(),
    seedUrl: `${origin}/settings`,
    allowlist: [origin],
    bounds: { maxActions: 20, maxDecisions: 40, maxCandidates: 250 },
    ...over,
  });
}

const acted = (t: readonly TranscriptEntry[]): string[] =>
  t.filter((e) => e.target !== null).map((e) => (e.target ?? "").replace(/^\w+ "([^"]*)".*$/, "$1"));

describe("frontier missions — a departure never leaves the run idle (#114)", () => {
  it(
    "coverage: after 'Sign out' the seed redirects to /login — a typed stop at once, not a replay of every queued item",
    async () => {
      await withSession(async (session, actor) => {
        const start = Date.now();
        const result = await coverage(session, actor, {});
        const elapsedMs = Date.now() - start;
        expect(result.outcome).toBe("scope-unreachable");
        expect(result.failure?.kind).toBe("target-unreachable");
        expect(result.failure?.message).toContain("could not return to the seed after a departure");
        expect(result.failure?.message).toContain("/login");
        expect(acted(result.transcript)).toContain("Sign out");
        expect(result.coverage.scope.departures.map((d) => new URL(d.url).pathname)).toEqual(["/"]);
        // Before #114 each of the five queued "Detail" items replayed "Show details" against the login
        // page and waited out a missing target (15s each). Now: no idle wait at all.
        expect(elapsedMs).toBeLessThan(25_000);
      });
    },
    60_000,
  );

  it(
    "--feature: the same session loss ends typed (`scope-unreachable`), never idle",
    async () => {
      await withSession(async (session, actor) => {
        const start = Date.now();
        const result = await runFeatureMission({
          page: session.page,
          actor,
          seedUrl: `${origin}/settings?tab=profile`,
          allowlist: [origin],
          scope: { name: "account details", originAllowlist: [origin], routeGlobs: ["/settings"] },
          bounds: { maxActions: 20 },
        });
        expect(result.outcome).toBe("scope-unreachable");
        expect(result.failure?.message).toContain("could not return to the seed after a departure");
        expect(Date.now() - start).toBeLessThan(25_000);
        // The seed's query survives into the replayable path (#114): `toPath` alone dropped it.
        const first = result.recordings[0]?.pages[0]?.steps[0]?.step;
        expect(first?.kind === "navigate" ? first.url : null).toBe("/settings?tab=profile");
      });
    },
    60_000,
  );

  it(
    "a seed that stops answering after a departure: the watchdog ends the run `stalled` within its bound",
    async () => {
      slowSeedHangs = false;
      await withSession(async (session, actor) => {
        const start = Date.now();
        const result = await coverage(session, actor, { seedUrl: `${origin}/slow`, stallTimeoutMs: 3_000 });
        const elapsedMs = Date.now() - start;
        expect(result.outcome).toBe("stalled");
        expect(result.failure?.kind).toBe("stalled");
        expect(result.failure?.message).toContain("no step completed within 3s");
        expect(result.failure?.message).toContain("returning to the seed after a departure");
        expect(elapsedMs).toBeLessThan(12_000);
      });
    },
    60_000,
  );

  it(
    "the reset itself is time-boxed: a bounded reach ends the run typed-inconclusive before the watchdog",
    async () => {
      slowSeedHangs = false;
      await withSession(async (session, actor) => {
        const start = Date.now();
        const result = await coverage(session, actor, { seedUrl: `${origin}/slow`, reachTimeoutMs: 2_000 });
        expect(result.outcome).toBe("scope-unreachable");
        expect(result.failure?.message).toMatch(/could not return to the seed after a departure \(.*within 2000ms\)/);
        expect(Date.now() - start).toBeLessThan(12_000);
      });
    },
    60_000,
  );
});

describe("frontier missions — global nav is tried last, and sparingly (#115)", () => {
  const isNav = (name: string): boolean => /^Section \d$/.test(name);

  it(
    "coverage: the 3 in-page controls come first; nav clicks are at most 20% of actions",
    async () => {
      await withSession(async (session, actor) => {
        const result = await coverage(session, actor, { seedUrl: `${origin}/app/page` });
        const names = acted(result.transcript);
        expect(names.slice(0, 3).sort()).toEqual(["Archive", "Export", "Refresh"]);
        const nav = names.filter(isNav).length;
        expect(nav / names.length).toBeLessThanOrEqual(0.2);
        expect(result.coverage.sufficiency.sufficient).toBe(true);
      });
    },
    60_000,
  );

  it(
    "--feature: a chrome/out-of-scope nav link is never chosen ahead of an in-scope control",
    async () => {
      await withSession(async (session, actor) => {
        const result = await runFeatureMission({
          page: session.page,
          actor,
          seedUrl: `${origin}/app/page`,
          allowlist: [origin],
          scope: { name: "export", originAllowlist: [origin], routeGlobs: ["/app/page"] },
          bounds: { maxActions: 20 },
        });
        const names = acted(result.transcript);
        expect(names.slice(0, 3).sort()).toEqual(["Archive", "Export", "Refresh"]);
        expect(names.filter(isNav).length / names.length).toBeLessThanOrEqual(0.2);
        expect(result.transcript.some((e) => /chrome=true/.test(e.reason ?? "") && e.actOk)).toBe(false);
      });
    },
    60_000,
  );
});

describe("exploratory differs from coverage (#115)", () => {
  it(
    "coverage sweeps every 'Open' first; exploratory follows what each action just revealed",
    async () => {
      const run = (strategy: "coverage" | "exploratory") =>
        withSession(async (session, actor) => {
          const r = await coverage(session, actor, { seedUrl: `${origin}/panels`, strategy });
          return { names: acted(r.transcript), strategies: new Set(r.transcript.map((e) => e.strategy)) };
        });
      const cov = await run("coverage");
      const exp = await run("exploratory");
      expect(cov.names.slice(0, 3)).toEqual(["Open A", "Open B", "Open C"]);
      expect(exp.names.slice(0, 4)).toEqual(["Open A", "A1", "Open B", "B1"]);
      expect(exp.names).not.toEqual(cov.names);
      // Both still cover the same controls — the difference is the order they are explored in.
      expect([...new Set(exp.names)].sort()).toEqual([...new Set(cov.names)].sort());
      expect([...cov.strategies]).toEqual(["coverage-frontier"]);
      expect([...exp.strategies]).toEqual(["exploratory-frontier"]);
    },
    90_000,
  );
});
