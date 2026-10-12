import { describe, expect, it } from "vitest";
import { ANCHOR_NAME_RULE_RE, JourneySchema, anchorAddCommand, suggestAnchors, type Journey } from "./index.js";

/** #487 part 2: anchors are suggested where the recorded flow changes state. */

type StepSpec = Record<string, unknown>;
const EXPECT = { kind: "urlIncludes", text: "/" };

function journey(pages: { url: string; steps: StepSpec[] }[], anchors?: Journey["metadata"]["anchors"]): Journey {
  return JourneySchema.parse({
    metadata: { id: "order", name: "Order", promoted: false, params: [], createdAtIso: "2026-10-01T00:00:00.000Z", ...(anchors === undefined ? {} : { anchors }) },
    recording: { version: "1", site: "http://127.0.0.1:1", pages },
  });
}
const nav = (url: string, id: string): StepSpec => ({ stepId: id, step: { kind: "navigate", url, expect: EXPECT } });
const click = (name: string, id: string, extra: StepSpec = {}): StepSpec => ({ stepId: id, step: { kind: "click", target: { role: "button", name }, expect: EXPECT }, ...extra });
const fill = (name: string, id: string, extra: StepSpec = {}): StepSpec => ({ stepId: id, step: { kind: "fill", target: { label: name }, value: { redacted: false, value: "x" }, expect: EXPECT }, ...extra });
const delta = (d: Record<string, unknown>): StepSpec => ({ delta: { verdict: "relevant-change", why: "w", changes: [], overheadMs: 1, ...d } });

describe("suggestAnchors", () => {
  it("suggests a write anchor at a step whose recorded request is a POST", () => {
    const j = journey([{ url: "/cart", steps: [nav("/cart", "s-a"), click("Place order", "s-b", delta({ requests: ["POST /api/orders → 201"] }))] }]);
    expect(suggestAnchors(j).map((s) => [s.kind, s.step, s.stepId])).toEqual([["write", 2, "s-b"]]);
  });

  it("does not suggest a write anchor for a recorded GET", () => {
    const j = journey([{ url: "/cart", steps: [nav("/cart", "s-a"), click("Refresh", "s-b", delta({ requests: ["GET /api/orders → 200"] }))] }]);
    expect(suggestAnchors(j)).toEqual([]);
  });

  it("suggests a new-page anchor when the url path changes between steps", () => {
    const j = journey([{ url: "/cart", steps: [nav("/cart", "s-a"), click("Next", "s-b", delta({ url: { before: "/cart", after: "/pay" } }))] }]);
    expect(suggestAnchors(j).map((s) => [s.kind, s.name])).toEqual([["new-page", "pay-page"]]);
  });

  it("does not treat a query-only change as a new page", () => {
    const j = journey([{ url: "/cart", steps: [nav("/cart", "s-a"), click("Sort", "s-b", delta({ url: { before: "/cart", after: "/cart?sort=1" } }))] }]);
    expect(suggestAnchors(j)).toEqual([]);
  });

  it("credits a segment change with no url delta to the last step of the previous segment", () => {
    const j = journey([
      { url: "/cart", steps: [nav("/cart", "s-a")] },
      { url: "/done", steps: [{ stepId: "s-b", step: { kind: "assert", check: EXPECT } }] },
    ]);
    expect(suggestAnchors(j).map((s) => [s.kind, s.step])).toEqual([["new-page", 1]]);
  });

  it("suggests a form-valid anchor at the last fill before a submit click", () => {
    const j = journey([{ url: "/signup", steps: [nav("/signup", "s-a"), fill("Email", "s-b"), fill("Password", "s-c"), click("Sign up", "s-d")] }]);
    expect(suggestAnchors(j).map((s) => [s.kind, s.step, s.name])).toEqual([["form-valid", 3, "sign-up-ready"]]);
  });

  it("suggests a form-valid anchor when a fill's delta reports a control enabled", () => {
    const j = journey([{ url: "/f", steps: [nav("/f", "s-a"), fill("Email", "s-b", delta({ changes: ["button 'Go' became enabled"] }))] }]);
    expect(suggestAnchors(j).map((s) => s.kind)).toEqual(["form-valid"]);
  });

  it("prefers the write kind when a step is both a navigation and a write", () => {
    const j = journey([{ url: "/cart", steps: [nav("/cart", "s-a"), click("Pay", "s-b", delta({ url: { before: "/cart", after: "/thanks" }, requests: ["POST /api/pay → 200"] }))] }]);
    expect(suggestAnchors(j).map((s) => s.kind)).toEqual(["write"]);
  });

  it("skips a step that already carries an anchor by id", () => {
    const j = journey([{ url: "/cart", steps: [nav("/cart", "s-a"), click("Pay", "s-b", delta({ requests: ["POST /api/pay → 200"] }))] }], [{ name: "paid", step: 2, stepId: "s-b" }]);
    expect(suggestAnchors(j)).toEqual([]);
  });

  it("skips a step that already carries a number-only anchor", () => {
    const j = journey([{ url: "/cart", steps: [nav("/cart", "s-a"), click("Pay", "s-b", delta({ requests: ["POST /api/pay → 200"] }))] }], [{ name: "paid", step: 2 }]);
    expect(suggestAnchors(j)).toEqual([]);
  });

  it("gives write suggestions the double-submit, reload, replay and second-tab probes", () => {
    const j = journey([{ url: "/cart", steps: [nav("/cart", "s-a"), click("Pay", "s-b", delta({ requests: ["POST /api/pay → 200"] }))] }]);
    expect(suggestAnchors(j)[0]?.probes).toEqual(["double submit", "back/reload", "replay the write", "a second tab"]);
  });

  it("gives new-page suggestions the reload and second-tab probes", () => {
    const j = journey([{ url: "/a", steps: [nav("/a", "s-a"), click("Next", "s-b", delta({ url: { before: "/a", after: "/b" } }))] }]);
    expect(suggestAnchors(j)[0]?.probes).toEqual(["back/reload", "a second tab"]);
  });

  it("gives form-valid suggestions the double-submit and reload probes", () => {
    const j = journey([{ url: "/f", steps: [nav("/f", "s-a"), fill("Email", "s-b"), click("Save", "s-c")] }]);
    expect(suggestAnchors(j)[0]?.probes).toEqual(["double submit", "back/reload"]);
  });

  it("keeps every suggested name unique and within the anchor name rule", () => {
    const w = (id: string): StepSpec => click("Pay", id, delta({ requests: ["POST /api/pay → 200"] }));
    const names = suggestAnchors(journey([{ url: "/c", steps: [nav("/c", "s-a"), w("s-b"), w("s-c")] }])).map((s) => s.name);
    expect(names).toEqual(["pay-written", "pay-written-2"]);
  });

  it("avoids the name of an existing anchor", () => {
    const j = journey([{ url: "/c", steps: [nav("/c", "s-a"), click("Pay", "s-b", delta({ requests: ["POST /api/pay → 200"] })), click("Pay", "s-c")] }], [{ name: "pay-written", step: 3, stepId: "s-c" }]);
    expect(suggestAnchors(j)[0]?.name).toBe("pay-written-2");
  });
});

/** #506: recordings without step deltas keep their requests only in `timing.page.requests`. */
const timed = (endpoint: string, status = 200): StepSpec => ({
  timing: { atMs: 0, durationMs: 1, gapBeforeMs: 0, page: { route: "/", kind: "transition", settled: true, requests: { count: 1, pending: 0, slowest: [{ endpoint, url: `http://127.0.0.1:1${endpoint.split(" ")[1]}`, status, durationMs: 5 }] } } },
});
const withMeta = (j: Journey, meta: Record<string, unknown>): Journey => JourneySchema.parse({ ...j, metadata: { ...j.metadata, ...meta } });

describe("suggestAnchors on recordings without step deltas (#506)", () => {
  const filesIssue = (): Journey =>
    withMeta(
      journey([
        { url: "/clusters", steps: [nav("/clusters", "s-a"), click("Open cluster", "s-b")] },
        { url: "/clusters/abc12345", steps: [click("Create GitHub issue", "s-c", timed("POST /api/ClusterService/FileIssue"))] },
      ]),
      { endState: [{ kind: "responseStatus", method: "POST", pathGlob: "*/FileIssue", status: { class: 2 } }] },
    );

  it("suggests a write anchor at the step whose timing records a write request", () => {
    expect(suggestAnchors(filesIssue()).filter((s) => s.kind === "write").map((s) => s.step)).toEqual([3]);
  });

  it("suggests the new page at the click that navigated", () => {
    expect(suggestAnchors(filesIssue()).filter((s) => s.kind === "new-page").map((s) => s.step)).toEqual([2]);
  });

  it("names the end state in a write reason it matches", () => {
    expect(suggestAnchors(filesIssue()).find((s) => s.kind === "write")?.reason).toContain("named by the end state");
  });

  it("suggests a write anchor at each of two timing-only writes", () => {
    const j = journey([{ url: "/site", steps: [nav("/site", "s-a"), click("Save site", "s-b", timed("PUT /api/sites/1")), click("Next", "s-c"), click("Invite", "s-d", timed("POST /api/invites"))] }]);
    expect(suggestAnchors(j).filter((s) => s.kind === "write").map((s) => s.step)).toEqual([2, 4]);
  });

  it("does not suggest a write anchor for a timing-only GET", () => {
    const j = journey([{ url: "/a", steps: [nav("/a", "s-a"), click("Refresh", "s-b", timed("GET /api/items"))] }]);
    expect(suggestAnchors(j)).toEqual([]);
  });

  it("does not suggest a write anchor for a timing-only write that failed", () => {
    const j = journey([{ url: "/a", steps: [nav("/a", "s-a"), click("Save", "s-b", timed("POST /api/items", 500))] }]);
    expect(suggestAnchors(j)).toEqual([]);
  });

  it("proposes the last step as a fallback end anchor for a job-linked Journey with no other suggestion", () => {
    const j = withMeta(journey([{ url: "/invite", steps: [nav("/invite", "s-a"), click("Look", "s-b")] }]), { job: "accept-invite" });
    expect(suggestAnchors(j).map((s) => [s.kind, s.step])).toEqual([["job-end", 2]]);
  });

  it("gives the job fallback an anchor-rule-conforming name and a fallback reason", () => {
    const j = withMeta(journey([{ url: "/invite", steps: [nav("/invite", "s-a"), click("Look", "s-b")] }]), { job: "accept-invite" });
    const s = suggestAnchors(j)[0]!;
    expect([ANCHOR_NAME_RULE_RE.test(s.name), s.reason.startsWith("fallback")]).toEqual([true, true]);
  });

  it("does not add the job fallback when another suggestion exists", () => {
    const j = withMeta(journey([{ url: "/invite", steps: [nav("/invite", "s-a"), click("Accept", "s-b", timed("POST /api/invites/accept"))] }]), { job: "accept-invite" });
    expect(suggestAnchors(j).map((s) => s.kind)).toEqual(["write"]);
  });

  it("proposes no job fallback for a Journey without a job", () => {
    expect(suggestAnchors(journey([{ url: "/a", steps: [nav("/a", "s-a")] }]))).toEqual([]);
  });
});

describe("anchorAddCommand", () => {
  it("prints the journey anchor add command naming the step id and probes", () => {
    expect(anchorAddCommand("order", { name: "pay-written", step: 2, stepId: "s-b", kind: "new-page", reason: "r", probes: ["back/reload"] })).toBe(
      "jevitate journey anchor add order --name pay-written --step s-b --probe 'back/reload'",
    );
  });
});
