import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page, Request } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeClassifier } from "@jevitate/recording";
import { ReadOnlyGuard } from "@jevitate/explore";
import { useSkippingTime } from "../../explore/src/testkit.js";
import type { BrowserSession } from "./browser-port.js";
import { PlaywrightBrowserPort } from "./playwright-browser-port.js";

useSkippingTime({ per: "all" });

/**
 * #521 option A — the opt-in navigation guard, in real Chromium against two local origins: the app
 * (allowed) and an "other" origin (not allowed) that serves a page, a script, an image and a CORS fetch.
 */

let app: Server;
let other: Server;
let APP = "";
let OTHER = "";
const otherHits: string[] = [];
let posts = 0;

function appHtml(path: string): string {
  switch (path) {
    case "/subresources":
      return `<!doctype html><html><body><script>
        window.loaded = Promise.all([
          new Promise((r) => { const s = document.createElement("script"); s.src = "${OTHER}/script.js"; s.onload = () => r(window.otherScriptRan === true); s.onerror = () => r(false); document.body.appendChild(s); }),
          new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = "${OTHER}/pixel.svg"; }),
          fetch("${OTHER}/data").then((res) => res.json()).then((j) => j.ok === true, () => false),
        ]);
      </script></body></html>`;
    case "/iframe":
      return `<!doctype html><html><body><iframe src="${OTHER}/page?embed=1"></iframe></body></html>`;
    default:
      return `<!doctype html><html><body>
        <a id="leave" href="${OTHER}/page?token=secret#frag">Leave</a>
        <a id="popup" href="${OTHER}/page" target="_blank">Popup</a>
        <form method="post" action="/api/save"><button>Save</button></form>
      </body></html>`;
  }
}

beforeAll(async () => {
  other = createServer((req, res) => {
    otherHits.push(req.url ?? "");
    const path = (req.url ?? "/").split("?")[0];
    const cors = { "access-control-allow-origin": "*" };
    if (path === "/script.js") res.writeHead(200, { ...cors, "content-type": "text/javascript" }).end("window.otherScriptRan = true;");
    else if (path === "/pixel.svg") res.writeHead(200, { ...cors, "content-type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    else if (path === "/data") res.writeHead(200, { ...cors, "content-type": "application/json" }).end('{"ok":true}');
    else res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html><body><h1>Other origin</h1></body></html>");
  });
  app = createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(200, { "content-type": "text/html" }).end(appHtml((req.url ?? "/").split("?")[0]!));
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  OTHER = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  APP = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await Promise.all([app, other].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const port = new PlaywrightBrowserPort({ liveness: false });

async function withGuard<T>(guarded: boolean, body: (session: BrowserSession) => Promise<T>): Promise<T> {
  const session = await port.open({ headless: true, allowedOrigins: [APP], baseUrl: APP, ...(guarded ? { blockOffAllowlistNavigation: true } : {}) });
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

/**
 * Resolves once the context's next request to `OTHER` ends — finished, or failed (a navigation
 * answered `204` ends as `net::ERR_ABORTED`: the browser stays on the current document).
 */
function otherRequestEnded(page: Page): Promise<void> {
  const context = page.context();
  return new Promise<void>((resolve) => {
    const done = (r: Request): void => {
      if (!r.url().startsWith(OTHER)) return;
      context.off("requestfinished", done);
      context.off("requestfailed", done);
      resolve();
    };
    context.on("requestfinished", done);
    context.on("requestfailed", done);
  });
}

/** Clicks `selector` and waits until the request it starts to `OTHER` has ended. */
async function clickToOther(page: Page, selector: string): Promise<void> {
  await Promise.all([otherRequestEnded(page), page.click(selector)]);
}

describe("navigation guard armed (blockOffAllowlistNavigation, real Chromium)", () => {
  it("a blocked link navigation leaves the page on its allowed URL, not chrome-error://", async () => {
    const url = await withGuard(true, async (s) => {
      await s.page.goto(`${APP}/`);
      await clickToOther(s.page, "#leave");
      return s.page.url();
    });
    expect(url).toBe(`${APP}/`);
  });

  it("a blocked link navigation is drained as a main-frame departure carrying its target URL without query or fragment", async () => {
    const drained = await withGuard(true, async (s) => {
      await s.page.goto(`${APP}/`);
      await clickToOther(s.page, "#leave");
      return s.drainBlockedNavigations?.();
    });
    expect(drained).toEqual([{ url: `${OTHER}/page`, at: expect.any(Number), frame: "main" }]);
  });

  it("a drain empties the record", async () => {
    const second = await withGuard(true, async (s) => {
      await s.page.goto(`${APP}/`);
      await clickToOther(s.page, "#leave");
      s.drainBlockedNavigations?.();
      return s.drainBlockedNavigations?.();
    });
    expect(second).toEqual([]);
  });

  it("a blocked navigation never reaches the other origin's server", async () => {
    otherHits.length = 0;
    await withGuard(true, async (s) => {
      await s.page.goto(`${APP}/`);
      await clickToOther(s.page, "#leave");
    });
    expect(otherHits).toEqual([]);
  });

  it("a blocked navigation emits no console error and no requestfailed but the 204's own net::ERR_ABORTED", async () => {
    const noise = await withGuard(true, async (s) => {
      const seen: string[] = [];
      s.page.on("requestfailed", (r) => {
        if (r.failure()?.errorText !== "net::ERR_ABORTED") seen.push(`requestfailed ${r.url()} ${r.failure()?.errorText ?? ""}`);
      });
      s.page.on("console", (m) => {
        if (m.type() === "error") seen.push(`console ${m.text()}`);
      });
      await s.page.goto(`${APP}/`);
      await clickToOther(s.page, "#leave");
      return seen;
    });
    expect(noise).toEqual([]);
  });

  it("a popup's off-allowlist navigation is blocked too (the guard is on the context)", async () => {
    const drained = await withGuard(true, async (s) => {
      await s.page.goto(`${APP}/`);
      await clickToOther(s.page, "#popup");
      return s.drainBlockedNavigations?.().map((b) => b.url);
    });
    expect(drained).toEqual([`${OTHER}/page`]);
  });

  it("an off-allowlist iframe navigation is drained as a subframe stop", async () => {
    const drained = await withGuard(true, async (s) => {
      await Promise.all([otherRequestEnded(s.page), s.page.goto(`${APP}/iframe`)]);
      return s.drainBlockedNavigations?.().map((b) => b.frame);
    });
    expect(drained).toEqual(["sub"]);
  });

  it("cross-origin script, image and fetch still load", async () => {
    const loaded = await withGuard(true, async (s) => {
      await s.page.goto(`${APP}/subresources`);
      return s.page.evaluate(() => (window as unknown as { loaded: Promise<boolean[]> }).loaded);
    });
    expect(loaded).toEqual([true, true, true]);
  });

  it("composes with ReadOnlyGuard: a held form POST is still answered in the browser and listed", async () => {
    posts = 0;
    const result = await withGuard(true, async (s) => {
      await s.page.goto(`${APP}/`);
      const guard = new ReadOnlyGuard(writeClassifier({}), { allowlist: [APP] });
      await guard.arm(s.page);
      guard.beginAction();
      await Promise.all([s.page.waitForEvent("requestfailed", (r) => r.method() === "POST"), s.page.click("button")]);
      guard.settled();
      const blocked = guard.drain().length;
      await guard.disarm();
      return { blocked, posts };
    });
    expect(result).toEqual({ blocked: 1, posts: 0 });
  });

  it("composes with ReadOnlyGuard: an off-allowlist link is still stopped through the read-only guard's fallback", async () => {
    const drained = await withGuard(true, async (s) => {
      await s.page.goto(`${APP}/`);
      const guard = new ReadOnlyGuard(writeClassifier({}), { allowlist: [APP] });
      await guard.arm(s.page);
      guard.beginAction();
      await clickToOther(s.page, "#leave");
      guard.settled();
      await guard.disarm();
      return s.drainBlockedNavigations?.().map((b) => b.url);
    });
    expect(drained).toEqual([`${OTHER}/page`]);
  });
});

describe("navigation guard off (the default, real Chromium)", () => {
  it("an off-allowlist link navigation proceeds as today", async () => {
    const url = await withGuard(false, async (s) => {
      await s.page.goto(`${APP}/`);
      await Promise.all([s.page.waitForURL(`${OTHER}/**`), s.page.click("#leave")]);
      return s.page.url();
    });
    expect(url).toBe(`${OTHER}/page?token=secret#frag`);
  });

  it("the session drains no blocked navigations", async () => {
    const drained = await withGuard(false, async (s) => {
      await s.page.goto(`${APP}/`);
      await Promise.all([s.page.waitForURL(`${OTHER}/**`), s.page.click("#leave")]);
      return s.drainBlockedNavigations?.();
    });
    expect(drained).toEqual([]);
  });

  it("cross-origin script, image and fetch load (allowedOrigins does not block subresources)", async () => {
    const loaded = await withGuard(false, async (s) => {
      await s.page.goto(`${APP}/subresources`);
      return s.page.evaluate(() => (window as unknown as { loaded: Promise<boolean[]> }).loaded);
    });
    expect(loaded).toEqual([true, true, true]);
  });
});
