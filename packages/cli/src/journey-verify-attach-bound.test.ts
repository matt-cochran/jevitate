import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort, type BrowserPort, type BrowserSession } from "@jevitate/playwright";
import { verifyJourneyMutations, type JourneyVerifyReport } from "./journey-verify.js";

/**
 * The proof's body watcher attaches to the page's CDP session with a 2 s bound. A browser slow to
 * attach, or one that never answers, must not hold the proof past that bound.
 */

const HTML = `<!doctype html><html><head><title>Save</title></head><body>
<button id="save">Save</button><p id="status">Ready</p>
<script>document.getElementById('save').onclick = () => { document.getElementById('status').textContent = 'Saved'; };</script>
</body></html>`;

const attachWith = (mode: "delayed" | "hung"): (() => BrowserPort) => {
  const port = new PlaywrightBrowserPort();
  return () => ({
    open: async (opts): Promise<BrowserSession> => {
      const session = await port.open(opts);
      const context = session.page.context();
      const attach = context.newCDPSession.bind(context);
      Object.assign(context, {
        newCDPSession:
          mode === "hung"
            ? () => new Promise(() => undefined)
            : async (target: Parameters<typeof attach>[0]) => {
                await new Promise((resolve) => setTimeout(resolve, 2_500));
                return attach(target);
              },
      });
      return session;
    },
  });
};

let server: Server;
let origin: string;
let dir: string;

const journey = (): Journey =>
  ({
    metadata: {
      id: "save",
      name: "Save",
      promoted: false,
      params: [],
      createdAtIso: "2026-11-06T00:00:00.000Z",
      mutationPairs: [{ check: "step:2", mustFailWhen: "skip:1" }],
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { css: "#save" } } } },
            {
              step: { kind: "click", target: { css: "#save" }, expect: { kind: "textIncludes", target: { css: "#status" }, text: "Saved" } },
              delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: [], overheadMs: 1 },
            },
          ],
        },
      ],
    },
  }) as Journey;

const prove = (mode: "delayed" | "hung"): Promise<JourneyVerifyReport> =>
  verifyJourneyMutations({ dir, id: "save", params: {}, browserPortFactory: attachWith(mode) });

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-attach-bound-"));
  await new FsJourneyStore(dir).put(journey());
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("[realtime] a proof whose browser attach is slow or hung", () => {
  it("a browser attach delayed past the 2 s bound still returns a verdict", async () => {
    const report = await prove("delayed");
    expect(report.verdict).toBe("proven");
  }, 120_000);

  it("a browser attach that never returns still returns a verdict", async () => {
    const report = await prove("hung");
    expect(report.verdict).toBe("proven");
  }, 120_000);
});
