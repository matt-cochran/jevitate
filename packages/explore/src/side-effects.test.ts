import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import type { CapturedRequest, InflightRequest, PageMonitor, RequestCapture } from "./page-monitor.js";
import { SideEffectGuard, SideEffectLog, isBookkeepingRequest, requestSignature, screenState } from "./side-effects.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #92 — the Preveti J7 shape: "Run the simulation →" POSTs a paid job; the loop waits a moment,
 * reloads, and tries the same button again. The second click is refused as a repeated side effect
 * (recorded with its reason) and the POST fires exactly once.
 */
const SIM_HTML = `<!doctype html><html><body>
<h1>Pressure-test the bet</h1>
<button type="button" id="run">Run the simulation →</button>
<p id="state">Not run yet</p>
<script>
  document.getElementById("run").addEventListener("click", async () => {
    document.getElementById("state").textContent = "Simulating…";
    const r = await fetch("/api/simulations", { method: "POST", body: "{}" });
    document.getElementById("state").textContent = r.ok ? "Simulation queued" : "Simulation failed";
  });
</script>
</body></html>`;

let posts = 0;
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/simulations" && req.method === "POST") {
      posts += 1;
      setTimeout(() => res.writeHead(202, { "content-type": "application/json" }).end('{"job":"j1"}'), 300);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SIM_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Picks, per step, the first offered action whose id or description matches (repeating the last). */
class PickingJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly steps: readonly RegExp[]) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const q = args.questions.action;
    if (q === undefined) {
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "noul", value: false, probability: 0.1 };
      return out;
    }
    if (q.kind !== "choice") throw new Error("expected a choice");
    const pattern = this.steps[Math.min(this.#i, this.steps.length - 1)] as RegExp;
    this.#i += 1;
    const pick = q.options.find((o) => pattern.test(o) || pattern.test(q.descriptions?.[o] ?? ""));
    if (pick === undefined) throw new Error(`no option matches ${String(pattern)}: ${q.options.join(", ")}`);
    return { action: { kind: "choice", value: pick, confidence: 0.9 } };
  }
}

describe("#92 — a click that fired a write is not re-fired after wait + reload", () => {
  it("refuses the repeated click with a recorded reason; the POST fires exactly once", async () => {
    posts = 0;
    const run = await withSession(
      "side-effect-repeat-",
      async (session) => {
        const actor = CastActor.named("sim").whoCan(new BrowseTheWeb(session, [base]));
        return explore({
          actor,
          judge: new PickingJudge([/Run the simulation/, /^wait$/, /^reload$/, /Run the simulation/, /Run the simulation/, /^blocked$/]),
          gen: new FakeGenerationGateway(),
          goal: "run the simulation and read the verdict",
          allowlist: [base],
          startUrl: `${base}/decisions/demo`,
          bounds: { maxDecisions: 8 },
          waitOpMs: 500,
        });
      },
      base,
    );
    expect(posts).toBe(1);
    const clicks = run.transcript.filter((e) => e.op === "click");
    expect(clicks[0]?.actOk).toBe(true);
    const refused = clicks.filter((e) => /repeated side effect refused/.test(e.reason ?? ""));
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0]?.actOk).toBe(false);
    expect(refused[0]?.reason).toContain("POST /api/simulations");
    // The reload itself went ahead (nothing was in flight any more) — only the repeat was refused.
    expect(run.transcript.some((e) => e.op === "reload" && e.actOk)).toBe(true);
    // A refusal is never a success.
    expect(run.outcome.status).toBe("incomplete");
  }, 90_000);
});

/** A PageMonitor stand-in: a capture fed by hand and a settable in-flight list. */
function fakeMonitor(): { monitor: PageMonitor; finish: (r: CapturedRequest) => void; inflight: InflightRequest[] } {
  let capture: { add(r: CapturedRequest): void; requests(): CapturedRequest[] } | null = null;
  const inflight: InflightRequest[] = [];
  const monitor = {
    startCapture() {
      const got: CapturedRequest[] = [];
      capture = { add: (r) => got.push(r), requests: () => [...got] };
      return capture as unknown as RequestCapture;
    },
    stopCapture() {
      capture = null;
    },
    pending: () => [...inflight],
    unfinished: () => [...inflight],
  } as unknown as PageMonitor;
  return { monitor, finish: (r) => capture?.add(r), inflight };
}

const PAGE = { controlNames: ["Run the simulation →"], alerts: [] as string[] };
const post = (status: number | null, failed = false): CapturedRequest => ({
  method: "POST",
  url: "http://x/api/simulations",
  path: "/api/simulations",
  status,
  failed,
});

describe("SideEffectGuard (#92)", () => {
  it("allows a click that fired no write, and anything on another route", () => {
    const { monitor } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Open menu", "/a", 0);
    g.settle();
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });
  });

  it("refuses a repeat while the write is in flight, and after it went through", () => {
    const { monitor, inflight, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Run", "/a", 100);
    const req: InflightRequest = { url: "http://x/api/simulations", method: "POST", resourceType: "fetch", startedAt: 150 };
    inflight.push(req);
    g.settle();
    const v = g.check("k", "/a", PAGE);
    expect(v).toMatchObject({ refuse: true, inflight: true });
    expect(g.inflight()).toHaveLength(1);
    inflight.length = 0;
    expect(g.check("k", "/a", PAGE)).toMatchObject({ refuse: true, inflight: false });
    expect(g.check("k", "/elsewhere", PAGE)).toEqual({ refuse: false });
    // A finished 2xx write refuses too.
    g.beginClick("k2", "Save", "/a", 200);
    finish(post(201));
    g.settle();
    expect(g.check("k2", "/a", PAGE)).toMatchObject({ refuse: true, inflight: false });
  });

  it("allows a retry when every write was rejected, or the page offers a retry / shows an error", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Run", "/a", 0);
    finish(post(500));
    g.settle();
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });

    g.beginClick("k2", "Run", "/a", 0);
    finish(post(200));
    g.settle();
    expect(g.check("k2", "/a", PAGE).refuse).toBe(true);
    expect(g.check("k2", "/a", { controlNames: ["Try again"], alerts: [] })).toEqual({ refuse: false });
    expect(g.check("k2", "/a", { controlNames: [], alerts: ["Something went wrong"] })).toEqual({ refuse: false });
  });

  it("an input change clears the guard (a repeat now sends something new)", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Save", "/a", 0);
    finish(post(200));
    g.settle();
    expect(g.check("k", "/a", PAGE).refuse).toBe(true);
    g.inputChanged();
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });
  });

  it("compares the input values (#123): the same values again are no change, different ones are", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.inputChanged("name", "Dana Ruiz");
    g.inputChanged("email", "dana@example.com");
    g.beginClick("k", "Save", "/a", 0);
    finish(post(201));
    g.settle();
    g.inputChanged("name", "Dana Ruiz");
    g.inputChanged("email", "dana@example.com");
    const v = g.check("k", "/a", PAGE);
    expect(v).toMatchObject({ refuse: true, inflight: false });
    expect(v.refuse && v.reason).toContain("the inputs hold the same values");
    g.inputChanged("name", "Lee Park");
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });
    // A checkbox toggled twice is back where it was.
    g.inputChanged("name", "Dana Ruiz");
    g.inputChanged("agree", { toggled: true });
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });
    g.inputChanged("agree", { toggled: true });
    expect(g.check("k", "/a", PAGE).refuse).toBe(true);
  });

  it("a gRPC-web/Connect read is not a write (#110); --read-rpc patterns mark more reads", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Open question", "/a", 0);
    finish({ method: "POST", url: "http://x/pkg.WorkspaceService/ListNodeTests", path: "/pkg.WorkspaceService/ListNodeTests", status: 200, failed: false, requestContentType: "application/grpc-web+proto" });
    g.settle();
    expect(g.check("k", "/a", PAGE)).toEqual({ refuse: false });
  });

  it("never guards a sign-in, and a back / start-over click lifts the guard on its route (#110)", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("login", "Log in", "/login", 0);
    finish({ ...post(200), path: "/api/session" });
    g.settle();
    expect(g.check("login", "/login", PAGE)).toEqual({ refuse: false });
    g.beginClick("send", "Send code", "/login", 0);
    finish({ ...post(200), path: "/api/otp" });
    g.settle();
    expect(g.check("send", "/login", PAGE).refuse).toBe(true);
    g.beginClick("back", "Back to sign in", "/login", 0);
    g.settle();
    expect(g.check("send", "/login", PAGE)).toEqual({ refuse: false });
  });
});

describe("SideEffectGuard — only the app's writes are guarded (#274, #284)", () => {
  const APP = "http://app.example.test";
  const beacon = (url: string): CapturedRequest => ({ method: "POST", url, path: new URL(url).pathname, status: 200, failed: false });

  it("a third-party beacon is not the control's side effect: the safe control may be clicked again", () => {
    const { monitor, finish, inflight } = fakeMonitor();
    const g = new SideEffectGuard(monitor, { allowlist: [APP] });
    g.beginClick("menu", "Open user menu", "/a", 0);
    finish(beacon("https://m.stripe.com/6"));
    finish(beacon("https://q.stripe.com/csp-report"));
    inflight.push({ url: "https://third-party.example/csp-report", method: "POST", resourceType: "ping", startedAt: 10 });
    g.settle();
    expect(g.check("menu", "/a", PAGE)).toEqual({ refuse: false });
    expect(g.inflight()).toEqual([]);
    expect(g.lastClick()?.writes).toEqual([]);
  });

  it("a --settle-ignore'd request is not the control's side effect, even on the app's own origin", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor, { allowlist: [APP], ignoreRequests: (u) => u.includes("m.stripe.com") || u.endsWith("/telemetry") });
    g.beginClick("nav", "Research", "/a", 0);
    finish(beacon(`${APP}/telemetry`));
    g.settle();
    expect(g.check("nav", "/a", PAGE)).toEqual({ refuse: false });
  });

  it("still refuses a repeated first-party write fired alongside the beacons", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor, { allowlist: [APP] });
    g.beginClick("run", "Run the simulation →", "/a", 0);
    finish(beacon("https://m.stripe.com/6"));
    finish({ ...post(202), url: `${APP}/api/simulations` });
    g.settle();
    const v = g.check("run", "/a", PAGE);
    expect(v).toMatchObject({ refuse: true, inflight: false });
    expect(v.refuse && v.reason).toContain("POST /api/simulations");
    expect(v.refuse && v.reason).not.toContain("stripe");
  });
});

describe("SideEffectLog (#116)", () => {
  it("attributes each write to the action that began before it, skips reads, and marks the risk", () => {
    let t = 0;
    const got: CapturedRequest[] = [];
    const inflight: InflightRequest[] = [];
    const monitor = {
      startCapture: () => ({ add: (r: CapturedRequest) => got.push(r), requests: () => [...got] }) as unknown as RequestCapture,
      stopCapture() {},
      pending: () => [...inflight],
    unfinished: () => [...inflight],
    } as unknown as PageMonitor;
    const log = new SideEffectLog({ now: () => t });
    log.attach(monitor);
    got.push({ method: "POST", url: "http://x/api/boot", path: "/api/boot", status: 200, failed: false, startedAt: 1 }); // before any action
    t = 10;
    log.mark(1, "Open question");
    got.push({ method: "POST", url: "http://x/p.Svc/GetThing", path: "/p.Svc/GetThing", status: 200, failed: false, startedAt: 11 });
    t = 20;
    log.mark(2, "Delete account", "destructive");
    got.push({ method: "DELETE", url: "http://x/api/account", path: "/api/account", status: 204, failed: false, startedAt: 21 });
    inflight.push({ method: "POST", url: "http://x/api/jobs", resourceType: "fetch", startedAt: 22 });
    expect(log.entries()).toEqual({
      sideEffects: [
        { step: 2, control: "Delete account", request: { method: "DELETE", endpoint: "/api/account", status: 204 }, risk: "destructive" },
        { step: 2, control: "Delete account", request: { method: "POST", endpoint: "/api/jobs", status: null }, risk: "destructive" },
      ],
      truncated: 0,
    });
  });
});

describe("SideEffectGuard — an action is what it is and does, not its label (#356)", () => {
  const at = (path: string, status = 200): CapturedRequest => ({ method: "POST", url: `http://x${path}`, path, status, failed: false });
  const PAGE2 = { controlNames: ["Continue"], alerts: [] as string[] };

  it("a same-labelled control in another context on the same route is a different action", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    const el = JSON.stringify({ role: "button", name: "Continue" });
    const a = { element: el, context: JSON.stringify([null, null, null, "Step 1"]) };
    const b = { element: el, context: JSON.stringify([null, null, null, "Step 2"]) };
    g.beginClick(a, "Continue", "/flow", 0);
    finish(at("/api/a"));
    g.settle();
    // Screen B's "Continue" is not screen A's: allowed.
    expect(g.check(b, "/flow", PAGE2)).toEqual({ refuse: false });
    g.beginClick(b, "Continue", "/flow", 10);
    finish(at("/api/b"));
    g.settle();
    // The SAME action (route + element + context) is still refused, named by the request it sent.
    const again = g.check(b, "/flow", PAGE2);
    expect(again).toMatchObject({ refuse: true, inflight: false });
    expect(again.refuse && again.reason).toContain("POST /api/b");
    expect(again.refuse && again.reason).not.toContain("/api/a");
    expect(g.check(a, "/flow", PAGE2)).toMatchObject({ refuse: true, inflight: false });
  });

  it("a write still in flight is waited for whatever the context now says", () => {
    const { monitor, inflight } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    const el = JSON.stringify({ role: "button", name: "Run" });
    g.beginClick({ element: el, context: '"before"' }, "Run", "/a", 100);
    inflight.push({ url: "http://x/api/simulations", method: "POST", resourceType: "fetch", startedAt: 150 });
    g.settle();
    expect(g.check({ element: el, context: '"after"' }, "/a", PAGE)).toMatchObject({ refuse: true, inflight: true });
    // Another element is never held up by it.
    expect(g.check({ element: "other", context: '"after"' }, "/a", PAGE)).toEqual({ refuse: false });
  });

  it("a record on one route is not overwritten by the same element on another", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("k", "Continue", "/one", 0);
    finish(at("/api/a"));
    g.settle();
    g.beginClick("k", "Continue", "/two", 10);
    finish(at("/api/b"));
    g.settle();
    expect(g.check("k", "/one", PAGE2)).toMatchObject({ refuse: true });
    expect(g.check("k", "/two", PAGE2)).toMatchObject({ refuse: true });
  });

  it("requestSignature: method + templated path, carrying an RPC method", () => {
    expect(requestSignature("post", "/api/items/42")).toBe("POST /api/items/:id");
    expect(requestSignature("POST", "/pkg.v1.ShareService/RetryShareDomain")).toBe("POST /pkg.v1.ShareService/RetryShareDomain");
  });
});

describe("SideEffectGuard — bookkeeping is not a side effect (#374)", () => {
  const req = (path: string, extra: Partial<CapturedRequest> = {}): CapturedRequest => ({
    method: "POST",
    url: `http://x${path}`,
    path,
    status: 200,
    failed: false,
    requestContentType: "application/connect+json",
    ...extra,
  });

  it("classifies analytics events, beacons and read markers — never a real write", () => {
    for (const path of [
      "/showcase.v1.ShowcaseService/RecordShowcaseEvent",
      "/inbox.v1.InboxService/MarkConversationRead",
      "/app.v1.Telemetry/TrackPageView",
      "/api/analytics/events",
      "/telemetry",
      "/api/messages/42/read",
      "/api/notifications/7/mark-as-seen",
      "/api/metrics",
      "/v1/rum/batch",
    ])
      expect(isBookkeepingRequest({ path }), path).toBe(true);
    expect(isBookkeepingRequest({ path: "/api/whatever", resourceType: "ping" })).toBe(true);
    // …so the guard still refuses re-firing them.
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    for (const [k, path] of [["pay", "/payments/collect"], ["track", "/orders/1/track"]] as const) {
      g.beginClick(k, k, "/a", 0);
      finish({ method: "POST", url: `http://x${path}`, path, status: 200, failed: false });
      g.settle();
      expect(g.check(k, "/a", PAGE), path).toMatchObject({ refuse: true, inflight: false });
    }
    for (const path of [
      "/share.v1.ShareService/RetryShareDomain",
      "/cal.v1.CalendarService/CreateEvent",
      "/api/events",
      "/api/notes",
      "/read",
      "/api/simulations",
      // Real writes whose path merely names a tracking-ish word (#374 review): never bookkeeping.
      "/payments/collect",
      "/orders/1/track",
      "/api/telemetryx/settings",
    ])
      expect(isBookkeepingRequest({ path }), path).toBe(false);
  });

  it("a click that only fired bookkeeping may be clicked again; a real write fired alongside is still guarded", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("chat", "Chat with us", "/a", 0);
    finish(req("/showcase.v1.ShowcaseService/RecordShowcaseEvent"));
    finish(req("/api/analytics/events", { requestContentType: "application/json" }));
    g.settle();
    expect(g.check("chat", "/a", PAGE)).toEqual({ refuse: false });
    expect(g.lastClick()?.writes).toEqual([]);
    g.beginClick("row", "Alex Morgan", "/a", 10);
    finish(req("/inbox.v1.InboxService/MarkConversationRead"));
    g.settle();
    expect(g.check("row", "/a", PAGE)).toEqual({ refuse: false });
    g.beginClick("send", "Send", "/a", 20);
    finish(req("/inbox.v1.InboxService/MarkConversationRead"));
    finish(req("/inbox.v1.InboxService/SendMessage"));
    g.settle();
    const v = g.check("send", "/a", PAGE);
    expect(v).toMatchObject({ refuse: true, inflight: false });
    expect(v.refuse && v.reason).toContain("SendMessage");
    expect(v.refuse && v.reason).not.toContain("MarkConversationRead");
  });
});

describe("SideEffectGuard — the screen moved on (#380)", () => {
  const CONTROLS = [{ role: "button", name: "I've changed my nameservers", enabled: true }];
  const rpc = (method: string, status: number | null = 200): CapturedRequest => ({
    method: "POST",
    url: `http://x/share.v1.ShareService/${method}`,
    path: `/share.v1.ShareService/${method}`,
    status,
    // null + not failed: the outcome is unknown (the page navigated away) — the server may have run it.
    failed: false,
  });
  const S0 = screenState(CONTROLS, "Point your nameservers at ns1, then tell us.");
  const S1 = screenState(CONTROLS, "Checking your nameservers.");
  const S2 = screenState(CONTROLS, "The nameservers still point elsewhere. Tell us again.");
  const page = (state?: string) => ({ ...PAGE, ...(state === undefined ? {} : { state }) });

  it("re-allows a finished write's control once the screen differs from before AND after it", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("changed", "I've changed my nameservers", "/domain", 0, S0);
    finish(rpc("RefreshShareDomain"));
    g.settle(S1);
    // The screen it produced, unchanged: a true repeat.
    const same = g.check("changed", "/domain", page(S1));
    expect(same).toMatchObject({ refuse: true, inflight: false });
    expect(same.refuse && same.reason).toContain("POST /share.v1.ShareService/RefreshShareDomain");
    expect(same.refuse && same.reason).toContain("its part of the page has not moved on since");
    // Back where it was clicked (a toast gone, a reload): still the same action.
    expect(g.check("changed", "/domain", page(S0)).refuse).toBe(true);
    // No state given (a paid / destructive control): the rule never applies.
    expect(g.check("changed", "/domain", page()).refuse).toBe(true);
    // The screen moved on: allowed — and the next click is recorded by what IT sends.
    expect(g.check("changed", "/domain", page(S2))).toEqual({ refuse: false });
    g.beginClick("changed", "I've changed my nameservers", "/domain", 10, S2);
    finish(rpc("RetryShareDomain"));
    const S3 = screenState(CONTROLS, "Domain connected.");
    g.settle(S3);
    const again = g.check("changed", "/domain", page(S3));
    expect(again.refuse && again.reason).toContain("RetryShareDomain");
  });

  it("a write with no known outcome never lifts it, and digits alone are no new state", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("changed", "I've changed my nameservers", "/domain", 0, S0);
    finish(rpc("RefreshShareDomain", null));
    g.settle(S1);
    expect(g.check("changed", "/domain", page(S2)).refuse).toBe(true);
    expect(screenState(CONTROLS, "Last checked 12 s ago")).toBe(screenState(CONTROLS, "Last checked  9 s ago"));
    expect(screenState(CONTROLS, "a")).not.toBe(screenState([{ role: "button", name: "Check status", enabled: true }], "a"));
  });

  it("#391: a control used beside it (same region) allows ONE re-click, judged by what it sends", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    const CARD = "html:0>body:1>main:1>section:1";
    g.beginClick("changed", "I've changed my nameservers", "/domain", 0, S0, CARD);
    finish(rpc("RefreshShareDomain"));
    g.settle(S1);
    // A control elsewhere (a header menu): no change — a true repeat.
    g.beginClick("help", "Help", "/domain", 5, "h", "html:0>body:1>header:0");
    g.settle("h2");
    expect(g.check("changed", "/domain", page(S1)).refuse).toBe(true);
    // "Review instructions" in the same card: the card looks the same, but the click is allowed…
    g.beginClick("review", "Review instructions", "/domain", 10, S1, CARD);
    g.settle(S1);
    expect(g.check("changed", "/domain", page(S1))).toEqual({ refuse: false });
    // …never for a paid / destructive control (no state), nor on another route.
    expect(g.check("changed", "/domain", page()).refuse).toBe(true);
    g.beginClick("changed", "I've changed my nameservers", "/domain", 20, S1, CARD);
    finish(rpc("RetryShareDomain"));
    g.settle(S1);
    // …once: nothing used since, the same click again is a true repeat of the write it just sent.
    const again = g.check("changed", "/domain", page(S1));
    expect(again).toMatchObject({ refuse: true, inflight: false });
    expect(again.refuse && again.reason).toContain("POST /share.v1.ShareService/RetryShareDomain");
  });

  it("#391: a write with no known outcome is never re-allowed by a control used beside it", () => {
    const { monitor, finish } = fakeMonitor();
    const g = new SideEffectGuard(monitor);
    g.beginClick("changed", "I've changed my nameservers", "/domain", 0, S0, "card");
    finish(rpc("RefreshShareDomain", null));
    g.settle(S1);
    g.beginClick("review", "Review instructions", "/domain", 10, S1, "card");
    g.settle(S1);
    expect(g.check("changed", "/domain", page(S1)).refuse).toBe(true);
  });
});
