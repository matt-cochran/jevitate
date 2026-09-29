import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import { computeDescriptor } from "./descriptor.js";

/**
 * Replay fidelity: a recorded target is found again EXACTLY — never a substring/prefix match,
 * never a guess among same-named elements. Recorded with the real recorder, replayed with the real
 * interpreter, on served pages.
 */

const PAGES: Record<string, string> = {
  // Two rows, the same "Delete" button in each.
  "/dupes": `<ul><li>Alpha <button type="button" onclick="document.body.dataset.hit='alpha'">Delete</button></li>
               <li>Beta <button type="button" onclick="document.body.dataset.hit='beta'">Delete</button></li></ul>`,
  // Names that share a prefix — the case that broke hang replays.
  "/prefix": `<a href="#one" onclick="document.body.dataset.hit='one'">Stuck report</a>
              <a href="#two" onclick="document.body.dataset.hit='two'">Stuck report again</a>`,
  "/prefix-only-long": `<a href="#two" onclick="document.body.dataset.hit='two'">Stuck report again</a>`,
  // A test id beats the (duplicated) name.
  "/testid": `<button type="button" onclick="document.body.dataset.hit='plain'">Save</button>
              <button type="button" data-testid="save-main" onclick="document.body.dataset.hit='testid'">Save</button>`,
  // An id anchor: recorded on this page…
  "/anchor": `<button type="button" onclick="document.body.dataset.hit='other'">Save</button>
              <button type="button" id="primary-save" onclick="document.body.dataset.hit='anchored'">Save</button>`,
  // …and replayed after the page changed: a third "Save" appeared first, so the index moved.
  "/anchor-moved": `<button type="button" onclick="document.body.dataset.hit='new'">Save</button>
              <button type="button" onclick="document.body.dataset.hit='other'">Save</button>
              <button type="button" id="primary-save" onclick="document.body.dataset.hit='anchored'">Save</button>`,
  // The same page without the anchor: the index moved and nothing tells them apart.
  "/dupes-moved": `<ul><li>New <button type="button" onclick="document.body.dataset.hit='new'">Delete</button></li>
               <li>Alpha <button type="button" onclick="document.body.dataset.hit='alpha'">Delete</button></li>
               <li>Beta <button type="button" onclick="document.body.dataset.hit='beta'">Delete</button></li></ul>`,
  "/two-go": `<button type="button">Go</button><button type="button">Go</button>`,
};

let server: Server;
let origin: string;
const port = new PlaywrightBrowserPort();

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[(req.url ?? "").split(/[?#]/)[0] ?? ""];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body>${body}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function withPage<T>(body: (session: BrowserSession) => Promise<T>): Promise<T> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

/** Records the descriptor of the `index`-th element matching `selector` on `path`. */
async function record(path: string, selector: string, index: number): Promise<TargetDescriptor> {
  return withPage(async (s) => {
    await s.page.goto(`${origin}${path}`);
    const handle = await s.page.locator(selector).nth(index).elementHandle();
    if (handle === null) throw new Error("no element");
    return (await computeDescriptor(s.page, handle)).descriptor;
  });
}

function clickRecording(path: string, target: TargetDescriptor): Recording {
  return {
    version: "1.0.0",
    site: "test",
    pages: [
      {
        url: path,
        steps: [
          { step: { kind: "navigate", url: path, expect: { kind: "urlIncludes", text: path } } },
          { step: { kind: "click", target, expect: { kind: "urlIncludes", text: path } } },
        ],
      },
    ],
  };
}

/** Replays the click on `path` and reports what was hit (or the typed failure). */
async function replay(path: string, target: TargetDescriptor) {
  return withPage(async (s) => {
    const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(s, [origin]));
    const result = await new RecordingInterpreter({ targetTimeoutMs: 800 }).run(actor, clickRecording(path, target));
    const hit = await (s.page as Page).evaluate(() => document.body.dataset.hit ?? null);
    return { result, hit };
  });
}

describe("replay finds the recorded element EXACTLY", () => {
  it("duplicate names: the recorded nth among equally-named candidates", async () => {
    const d = await record("/dupes", "button", 1);
    expect(d).toEqual({ role: "button", name: "Delete", ordinal: 1, candidates: 2 });
    const { result, hit } = await replay("/dupes", d);
    expect(result.outcome).toBe("completed");
    expect(hit).toBe("beta");
  });

  it("prefix-sharing names: 'Stuck report' is never 'Stuck report again'", async () => {
    const d = await record("/prefix", "a", 0);
    expect(d).toEqual({ role: "link", name: "Stuck report" }); // unique under EXACT matching
    const { result, hit } = await replay("/prefix", d);
    expect(result.outcome).toBe("completed");
    expect(hit).toBe("one");
    // And a page that only has the longer name is NOT a match (no substring fallback).
    const gone = await replay("/prefix-only-long", d);
    expect(gone.result).toMatchObject({ outcome: "failed", at: 1, reason: "replay-target-not-found" });
    expect(gone.hit).toBeNull();
  });

  it("a test id is preferred over a duplicated name", async () => {
    const d = await record("/testid", "button", 1);
    expect(d).toEqual({ testId: "save-main" });
    expect((await replay("/testid", d)).hit).toBe("testid");
  });

  it("a recorded id anchor is preferred, and survives the page gaining another same-named element", async () => {
    const d = await record("/anchor", "button", 1);
    expect(d).toEqual({ role: "button", name: "Save", ordinal: 1, candidates: 2, anchor: { id: "primary-save" } });
    expect((await replay("/anchor", d)).hit).toBe("anchored");
    const moved = await replay("/anchor-moved", d);
    expect(moved.result.outcome).toBe("completed");
    expect(moved.hit).toBe("anchored"); // not "other", which now sits at index 1
  });
});

describe("an ambiguous or missing target is a typed failure — never a guess", () => {
  it("two equally-named elements and nothing recorded to tell them apart → ambiguous; nothing clicked", async () => {
    const old: TargetDescriptor = { role: "button", name: "Go" }; // an older recording: no ordinal, no anchor
    const { result, hit } = await replay("/two-go", old);
    expect(result).toMatchObject({ outcome: "failed", at: 1, reason: "ambiguous" });
    expect(hit).toBeNull();
  });

  it("the index moved (a new same-named element) and no anchor → ambiguous, not the wrong row", async () => {
    const d = await record("/dupes", "button", 1);
    const { result, hit } = await replay("/dupes-moved", d);
    expect(result).toMatchObject({ outcome: "failed", reason: "ambiguous" });
    expect(hit).toBeNull();
  });

  it("older recordings without the new fields still replay by exact name + nth", async () => {
    const legacy: TargetDescriptor = { role: "button", name: "Delete", ordinal: 1 };
    const { result, hit } = await replay("/dupes", legacy);
    expect(result.outcome).toBe("completed");
    expect(hit).toBe("beta");
  });
});
