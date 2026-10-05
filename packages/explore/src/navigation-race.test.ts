import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, perceive } from "./index.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits. The client redirects below are SYNCHRONOUS (inline
// script / load listener), never a page-side timer, so `page.clock` cannot hold them back.
useSkippingTime({ per: "all" });

/**
 * #372: a start URL that 302s to a page which immediately `location.replace`s itself away. Reading
 * the controls raced the second navigation and the run crashed ("Execution context was destroyed").
 * The shared snapshot read now treats that as a navigation signal: wait for it to settle, re-read.
 */

const ENDED = `<!doctype html><html><body><h1>This demo has ended</h1><a href="/about">About</a><button type="button">Restart</button></body></html>`;
// A landing page that renders controls and replaces itself away: `inline` in its body (during parse),
// or on `load` — so the render wait can see a control while the page is already leaving.
const landing = (next: string, how: "inline" | "load"): string =>
  how === "inline"
    ? `<!doctype html><html><body><button type="button">Old page</button><a href="/x">x</a><script>location.replace("${next}")</script></body></html>`
    : `<!doctype html><html><head><script>window.addEventListener("load", () => location.replace("${next}"));</script></head><body><button type="button">Old page</button><a href="/x">x</a></body></html>`;

let server: Server;
let origin: string;
let loops = 0;
let endedDelayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    // /s/<how> 302s to the landing page; /hop/<how>/<n> replaces itself twice more, then to /ended.
    const short = /^\/s\/(inline|load)$/.exec(url);
    if (short !== null) {
      res.writeHead(302, { location: `/hop/${short[1]}/0` }).end();
      return;
    }
    const hop = /^\/hop\/(inline|load)\/(\d+)$/.exec(url);
    if (hop !== null) {
      const n = Number(hop[2]);
      const next = n >= 2 ? "/ended" : `/hop/${hop[1]}/${n + 1}`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(landing(next, hop[1] as "inline" | "load"));
      return;
    }
    if (url === "/ended" || url === "/about") {
      // A real server takes a moment: the client redirect's document is still in flight while the
      // landing page is perceived.
      setTimeout(() => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ENDED), endedDelayMs);
      return;
    }
    if (url.startsWith("/loop/")) {
      // Never stops navigating: every load replaces itself with the next URL.
      loops += 1;
      const n = Number(url.slice("/loop/".length)) + 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<!doctype html><html><head><script>window.addEventListener("load", () => location.replace("/loop/${n}"));</script></head><body><button type="button">Step ${n}</button><a href="/x">x</a></body></html>`,
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("#372 — a start URL that is still redirecting", () => {
  it(
    "server 302 → client location.replace: the goal run reaches its first decision on /ended and succeeds",
    async () => {
      for (const [how, delay] of [["inline", 0], ["load", 0], ["inline", 400], ["load", 400], ["inline", 1500], ["load", 1500]] as const) {
        endedDelayMs = delay;
        const judge = new ScriptedJudge([{ op: "done" }]);
        const run = await withSession(
          "explore-redirect-race-",
          async (session) => {
            const actor = CastActor.named("redirect").whoCan(new BrowseTheWeb(session, [origin]));
            return explore({
              actor,
              judge,
              gen: new FakeGenerationGateway(),
              goal: "see that the demo has ended",
              allowlist: [origin],
              startUrl: `${origin}/s/${how}`,
            });
          },
          origin,
        );
        expect(run.failure).toBeUndefined();
        expect(run.stop).toBe("done");
        expect(judge.states.length).toBeGreaterThanOrEqual(1);
        expect(judge.states[0]?.url).toMatch(/\/ended$/);
        expect(judge.states[0]?.controls.join("\n")).toContain("Restart");
      }
    },
    180_000,
  );

  it(
    "a page that never stops navigating ends perception in a typed, non-crash outcome within bounds",
    async () => {
      await withSession(
        "perceive-nav-loop-",
        async (session) => {
          loops = 0;
          await session.page.goto(`${origin}/loop/0`, { waitUntil: "load" });
          const p = await perceive(session.page, { renderWaitMs: 2_000 });
          expect(p.rendered).toBe(false);
          if (p.rendered) return;
          expect(p.reason).toMatch(/kept navigating/);
          expect(loops).toBeGreaterThan(1);
        },
        origin,
      );
    },
    120_000,
  );

  it(
    "a goal run on a page that never stops navigating ends blocked (fail-closed), never crashed",
    async () => {
      const judge = new ScriptedJudge([{ op: "done" }]);
      const run = await withSession(
        "explore-nav-loop-",
        async (session) => {
          const actor = CastActor.named("loop").whoCan(new BrowseTheWeb(session, [origin]));
          return explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "anything",
            allowlist: [origin],
            startUrl: `${origin}/loop/0`,
            renderWaitMs: 2_000,
          });
        },
        origin,
      );
      expect(run.stop).not.toBe("crashed");
      expect(run.stop).toBe("blocked");
      expect(judge.states).toHaveLength(0);
    },
    120_000,
  );
});
