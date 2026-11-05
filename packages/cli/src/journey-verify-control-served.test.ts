import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { controlFailureIndications, verifyJourneyMutations, type JourneyVerifyReport } from "./journey-verify.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

const TOKEN = "opaque-draft-token-785";
/** Past the page monitor's 5s long-poll threshold, so settling alone gives up on the POST. */
const SLOW_POST_MS = 7_000;

/**
 * The issue's shape: a click opens a panel and sends a POST whose answer writes a token to
 * `sessionStorage` and prefills the panel; after a reload, a marker renders from that storage.
 * `gapMs`: how long after the answer the write lands, on a worker's timer the page monitor cannot see.
 */
const page = (gapMs: number): string => `<!doctype html><html><head><title>Draft</title></head><body><h1>Draft</h1>
<button id="open">Open draft</button><section id="panel" hidden><h2>Reply draft</h2><p id="prefill"></p></section><p id="marker"></p>
<script>
if (sessionStorage.getItem('draft-token') !== null) document.getElementById('marker').textContent = 'draft-restored';
const gap = () => new Promise((done) => {
  if (${gapMs} === 0) return done();
  const worker = new Worker(URL.createObjectURL(new Blob(['setTimeout(() => postMessage(1), ${gapMs})'])));
  worker.onmessage = done;
});
document.getElementById('open').addEventListener('click', async () => {
  document.getElementById('panel').hidden = false;
  try {
    const r = await fetch('/api/draft', { method: 'POST' });
    const body = await r.json();
    await gap();
    sessionStorage.setItem('draft-token', body.token);
    document.getElementById('prefill').textContent = 'Prefilled reply';
  } catch {}
});
</script></body></html>`;

type Answer = (posts: number) => number | "hold";

/** Serves the page; `answer` says how long the n-th POST (1-based) takes, or that it is never answered. */
async function serve(gapMs: number, answer: Answer): Promise<{ origin: string; close: () => Promise<void> }> {
  let posts = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") return void res.writeHead(200, { "content-type": "text/html" }).end(page(gapMs));
    posts += 1;
    const ms = answer(posts);
    if (ms === "hold") return;
    clock.setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: TOKEN })), ms);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function draftJourney(site: string, extraPairs: readonly { check: string; mustFailWhen: string }[] = []): Journey {
  return {
    metadata: {
      id: "draft",
      name: "Open draft",
      params: [],
      promoted: false,
      createdAtIso: "2026-11-04T00:00:00Z",
      mutationPairs: [
        { check: "step-request:2:0", mustFailWhen: "block-write:2" },
        { check: "step:3", mustFailWhen: "skip:2" },
        { check: "end-state:0", mustFailWhen: "skip:2" },
        ...extraPairs,
      ],
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "#marker" }, text: "draft-restored" } }],
    },
    recording: {
      version: "1",
      site,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { css: "#open" } } } },
            {
              step: { kind: "click", target: { css: "#open" }, expect: { kind: "visible", target: { css: "#panel" } } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/draft", status: { class: 2 } }],
            },
            { step: { kind: "assert", check: { kind: "textIncludes", target: { css: "#prefill" }, text: "Prefilled reply" } } },
          ],
        },
      ],
    },
  } as Journey;
}

async function prove(journey: Journey): Promise<JourneyVerifyReport> {
  const dir = await mkdtemp(join(tmpdir(), "jev-785-served-"));
  await new FsJourneyStore(dir).put(journey);
  return verifyJourneyMutations({ dir, id: journey.metadata.id, params: {}, browserPortFactory: () => new PlaywrightBrowserPort() });
}

const endStateProof = (report: JourneyVerifyReport, mutation: string) => report.mutations.find((m) => m.id === mutation)?.targeted?.find((t) => t.site === "end-state:0");

// #785 [realtime]: a server holding its answer past the page monitor's real long-poll threshold.
describe("[realtime] #785 a targeted control keeps the waiting of the sites it relaxes", () => {
  describe("a POST slower than settling", () => {
    let report: JourneyVerifyReport;
    beforeAll(async () => {
      const served = await serve(0, () => SLOW_POST_MS);
      report = await prove(draftJourney(served.origin)).finally(served.close);
    }, 180_000);

    it("reaches a proven verdict", () => {
      expect(report.verdict).toBe("proven");
    });
    it("passes the unmutated control", () => {
      expect(endStateProof(report, "skip:2")?.control).toBe("passed");
    });
    it("still fails the reload end-state when the click is skipped", () => {
      expect(endStateProof(report, "skip:2")?.failedSites).toEqual([{ where: "end-state", index: 0 }]);
    });
  });

  describe("a POST slower than settling, with the prefill check paired with block-write", () => {
    let report: JourneyVerifyReport;
    beforeAll(async () => {
      const served = await serve(0, () => SLOW_POST_MS);
      report = await prove(draftJourney(served.origin, [{ check: "step:3", mustFailWhen: "block-write:2" }])).finally(served.close);
    }, 180_000);

    it("still fails the reload end-state when the click's write is blocked", () => {
      expect(endStateProof(report, "block-write:2")?.failedSites).toEqual([{ where: "end-state", index: 0 }]);
    });
  });

  describe("a storage write landing in a quiet gap after the answer", () => {
    let report: JourneyVerifyReport;
    beforeAll(async () => {
      const served = await serve(3_000, () => 0);
      report = await prove(draftJourney(served.origin)).finally(served.close);
    }, 180_000);

    it("reaches a proven verdict", () => {
      expect(report.verdict).toBe("proven");
    });
  });
});

describe("#785 a control whose POST is never answered", () => {
  useSkippingTime({ per: "all", heldMs: 500 });
  let report: JourneyVerifyReport;
  beforeAll(async () => {
    const served = await serve(0, (n) => (n === 1 ? 0 : "hold"));
    report = await prove(draftJourney(served.origin)).finally(served.close);
  }, 120_000);

  it("is refused at its bound instead of hanging", () => {
    expect(endStateProof(report, "skip:2")?.control).toBe("failed");
  });
  it("has its bounded response wait end in a timeout", () => {
    expect(endStateProof(report, "skip:2")?.controlDiagnostics?.control.relaxedWaits.find((w) => w.site === "step-request:2:0")?.ending).toBe("timeout");
  });
  it("is told apart as end-state timing", () => {
    expect(endStateProof(report, "skip:2")?.controlDiagnostics?.indicates).toEqual(["end-state-timing"]);
  });
  it("reports the base replay's storage as a count", () => {
    expect(endStateProof(report, "skip:2")?.controlDiagnostics?.base?.storageBeforeEndState?.sessionStorageKeys).toBe(1);
  });
  it("carries no storage value in its report", () => {
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });
});

type Diagnostics = Parameters<typeof controlFailureIndications>[0];
const replayed = (over: Partial<Diagnostics> = {}): Diagnostics => ({
  stepsTotal: 3,
  stepsCompleted: 3,
  sessionsOpened: 1,
  pageReplaced: false,
  writesSent: 1,
  writesAnswered: 1,
  writesAborted: 0,
  writesUnfinished: 0,
  storageBeforeEndState: { sessionStorageKeys: 1, localStorageKeys: 0, cookies: 0 },
  storageAfterEndState: { sessionStorageKeys: 1, localStorageKeys: 0, cookies: 0 },
  relaxedWaits: [],
  ...over,
});
const none = { sessionStorageKeys: 0, localStorageKeys: 0, cookies: 0 };

describe("#785 a failed control is told apart", () => {
  it.each([
    ["a step that did not complete", replayed({ stepsCompleted: 2 }), true, ["action-omission"]],
    ["a write that was never sent", replayed({ writesSent: 0, writesAnswered: 0 }), true, ["action-omission"]],
    ["a replaced page", replayed({ pageReplaced: true }), true, ["browser-context-replacement"]],
    ["a session opened differently", replayed(), false, ["browser-context-replacement"]],
    ["a write still unanswered", replayed({ writesAnswered: 0, writesUnfinished: 1, storageBeforeEndState: none, storageAfterEndState: none }), true, ["end-state-timing"]],
    ["storage not yet written before the reload", replayed({ storageBeforeEndState: none, storageAfterEndState: none }), true, ["end-state-timing"]],
    ["storage lost across the reload", replayed({ storageAfterEndState: none }), true, ["storage-clearing"]],
    ["a replay matching the base", replayed(), true, []],
  ] as const)("%s", (_name, control, sameOptions, indicates) => {
    expect(controlFailureIndications(control, replayed(), sameOptions)).toEqual(indicates);
  });
});
