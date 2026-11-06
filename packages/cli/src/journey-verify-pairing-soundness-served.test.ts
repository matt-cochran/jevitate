import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { verifyJourneyMutations, type JourneyVerifyReport } from "./journey-verify.js";

/**
 * A final network check pairs with the step that recorded its request, but recorded requests are
 * placed by time. These shapes keep that pairing from proving a check its step had no part in.
 *
 * Real Chromium and a real clock: the page's own timer sending a request is real time.
 */

const TIMER_MS = 1_200;
/** Longer than a replay takes to reach its end state once B, which waits for the timer, is skipped. */
const LONG_TIMER_MS = 6_000;
const NOCLAIM = { kind: "urlIncludes", text: "" } as const;
const CHECK = (pathGlob: string) => [{ kind: "responseStatus", method: "POST", pathGlob, status: { class: 2 } }];
const WROTE = (path: string) => ({ delta: { verdict: "no-change", why: "w", changes: [], requests: [`POST ${path} → 200`], overheadMs: 1 } });
const click = (css: string, recorded: object = {}) => ({ step: { kind: "click", target: { css }, expect: NOCLAIM }, ...recorded });
const nav = (css: string) => ({ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { css } } } });

const journey = (id: string, site: string, steps: readonly unknown[], endState: readonly unknown[]): Journey =>
  ({ metadata: { id, name: id, params: [], promoted: false, createdAtIso: "2026-11-06T00:00:00.000Z", endState }, recording: { version: "1", site, pages: [{ url: "/", steps }] } }) as unknown as Journey;

/** BROWSER CODE. A's timer sends the write and enables B, so B's window is open when it goes out. B sends nothing. */
const timerPage = (timerMs: number): string => `<!doctype html><html><head><title>T</title></head><body>
  <button id="a">A</button><button id="b" disabled>B</button><button id="c">C</button><p id="said"></p>
  <script>
    const $ = (id) => document.getElementById(id);
    $("a").onclick = () => { setTimeout(() => {
      const sent = fetch("/api/sync", { method: "POST" }).catch(() => undefined);
      $("b").disabled = false;
      sent.finally(() => { $("said").insertAdjacentHTML("beforeend", '<i id="synced">synced</i>'); });
    }, ${timerMs}); };
    $("b").onclick = () => { $("said").append("B"); };
    $("c").onclick = () => { fetch("/api/last", { method: "POST" }).catch(() => undefined); };
  </script></body></html>`;

/** BROWSER CODE. Each button sends its own write at once. */
const directPage = `<!doctype html><html><head><title>T</title></head><body>
  <button id="a">A</button><button id="b">B</button>
  <script>for (const id of ["a", "b"]) document.getElementById(id).onclick = () => { fetch("/api/" + id, { method: "POST" }).catch(() => undefined); };</script>
</body></html>`;

/** BROWSER CODE. The preview shows a constant, whatever was typed; opening it reads something. */
const constantPage = `<!doctype html><html><head><title>T</title></head><body>
  <label>Reply <input aria-label="Reply"></label><button id="preview">Preview</button><p id="out"></p>
  <script>document.getElementById("preview").onclick = () => { fetch("/api/telemetry").catch(() => undefined); document.getElementById("out").textContent = "Reply: Fixed reply"; };</script>
</body></html>`;

/** BROWSER CODE. The button sends a read RPC over POST. */
const readPage = `<!doctype html><html><head><title>T</title></head><body>
  <button id="open">Open</button>
  <script>document.getElementById("open").onclick = () => { fetch("/board.v1.Items/GetItem", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined); };</script>
</body></html>`;

let server: Server;
let origin: string;
let dir: string;

function serve(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  req.resume();
  if (path.startsWith("/api/") || path.startsWith("/board.v1.Items/")) {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  const page = path === "/direct" ? directPage : path === "/read" ? readPage : path === "/constant" ? constantPage : timerPage(path === "/timer-long" ? LONG_TIMER_MS : TIMER_MS);
  res.writeHead(200, { "content-type": "text/html" }).end(page);
}

async function prove(j: Journey, path: string, params: Record<string, string> = {}): Promise<JourneyVerifyReport> {
  j.recording.pages[0]!.url = path;
  for (const s of j.recording.pages[0]!.steps) if (s.step.kind === "navigate") s.step.url = path;
  const at = join(dir, j.metadata.id);
  await new FsJourneyStore(at).put(j);
  return verifyJourneyMutations({ dir: at, id: j.metadata.id, params, browserPortFactory: () => new PlaywrightBrowserPort() });
}

const reading = (r: JourneyVerifyReport, site: string): string | undefined => r.assertions.find((a) => a.site === site)?.verdict;
const outcome = (r: JourneyVerifyReport, id: string): string | undefined => r.mutations.find((m) => m.id === id)?.outcome;

let timerThenWait: JourneyVerifyReport;
let timerHeldByB: JourneyVerifyReport;
let direct: JourneyVerifyReport;
let readDelta: JourneyVerifyReport;
let readGlob: JourneyVerifyReport;
let constant: JourneyVerifyReport;

beforeAll(async () => {
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-pairing-"));
  // A's timer fires inside B's window, and the recording credits B. A later step waits on the write.
  timerThenWait = await prove(
    journey("timer-then-wait", origin, [nav("#a"), click("#a"), click("#b", WROTE("/api/sync")), { step: { kind: "waitFor", target: { css: "#synced" }, state: "visible" } }], CHECK("/api/sync")),
    "/timer",
  );
  // The same, but B's own wait for its button is all that gave the timer time. C is the last write.
  timerHeldByB = await prove(journey("timer-held-by-b", origin, [nav("#a"), click("#a"), click("#b", WROTE("/api/sync")), click("#c", WROTE("/api/last"))], CHECK("/api/sync")), "/timer-long");
  direct = await prove(journey("direct", origin, [nav("#a"), click("#a", WROTE("/api/a")), click("#b", WROTE("/api/b"))], CHECK("/api/a")), "/direct");
  readDelta = await prove(journey("read-delta", origin, [nav("#open"), click("#open", WROTE("/board.v1.Items/GetItem"))], CHECK("/board.v1.Items/Get*")), "/read");
  readGlob = await prove(
    journey("read-glob", origin, [nav("#open"), { ...click("#open"), expectRequests: CHECK("/board.v1.Items/Get*") }], []),
    "/read",
  );
  const fixed = journey(
    "constant",
    origin,
    [
      nav("#preview"),
      { variableName: "reply", step: { kind: "fill", target: { label: "Reply" }, value: { var: "reply" }, expect: { kind: "valueEquals", target: { label: "Reply" }, value: { var: "reply" } } } },
      { step: { kind: "click", target: { css: "#preview" }, expect: { kind: "textIncludes", target: { css: "#out" }, text: "Reply:" } }, delta: { verdict: "relevant-change", why: "preview", changes: ["Reply:"], requests: ["GET /api/telemetry → 200"], overheadMs: 1 } },
    ],
    [{ kind: "page", assertion: { kind: "textIncludes", target: { css: "#out" }, text: "Reply: ${reply}" } }],
  );
  fixed.metadata.params = ["reply"];
  constant = await prove(fixed, "/constant", { reply: "Fixed reply" });
}, 600_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** Only this fixture's adjudication fields are exposed when an assertion fails. */
function diagnostics(report: JourneyVerifyReport): string {
  return JSON.stringify({
    verdict: report.verdict,
    mutations: report.mutations.map(({ id, outcome, reason, failedSites }) => ({ id, outcome, reason, failedSites })),
    assertions: report.assertions.map(({ site, verdict }) => ({ site, verdict })),
  });
}

describe("[realtime] a final network check is not proven by a step that did not send its request", () => {
  it("A's timer recorded under B, later step waits: B's block aborts it and B's skip does not matter", () => {
    expect(outcome(timerThenWait, "skip:3"), diagnostics(timerThenWait)).toBe("passed");
    expect(reading(timerThenWait, "end-state:0"), diagnostics(timerThenWait)).toBe("insensitive");
    expect(timerThenWait.verdict, diagnostics(timerThenWait)).toBe("insensitive");
  });

  it("A's timer recorded under B, B's own wait held the time: skipping B still gives the timer that time", () => {
    expect(outcome(timerHeldByB, "skip:3"), diagnostics(timerHeldByB)).toBe("passed");
    expect(reading(timerHeldByB, "end-state:0"), diagnostics(timerHeldByB)).toBe("insensitive");
    expect(timerHeldByB.verdict, diagnostics(timerHeldByB)).toBe("insensitive");
  });

  it("a request the step really sends stays proven, by both its skip and its block", () => {
    expect(outcome(direct, "skip:2"), diagnostics(direct)).toBe("failed");
    expect(outcome(direct, "block-write:2"), diagnostics(direct)).toBe("failed");
    expect(reading(direct, "end-state:0"), diagnostics(direct)).toBe("sensitive");
    expect(direct.verdict, diagnostics(direct)).toBe("proven");
  });

  it("a read RPC a check names by glob gets no write step and stays inconclusive", () => {
    expect(readDelta.mutations.map((m) => m.id), diagnostics(readDelta)).toEqual([]);
    expect(reading(readDelta, "end-state:0"), diagnostics(readDelta)).toBe("unpaired");
    expect(readDelta.verdict, diagnostics(readDelta)).toBe("inconclusive");
  });

  it("a read RPC a step's own check names by glob is no write either", () => {
    expect(readGlob.mutations.filter((m) => m.kind === "block-write"), diagnostics(readGlob)).toEqual([]);
    expect(readGlob.verdict, diagnostics(readGlob)).not.toBe("proven");
  });

  it("a page ignoring the parameter is not proven because skipping a read-only click also breaks the check", () => {
    expect(constant.mutations.find((m) => m.id === "swap-param:reply")?.relaxed?.outcome, diagnostics(constant)).toBe("passed");
    expect(reading(constant, "end-state:0"), diagnostics(constant)).toBe("insensitive");
    expect(constant.verdict, diagnostics(constant)).toBe("insensitive");
  });
});
