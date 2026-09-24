import { describe, expect, it } from "vitest";
import {
  detectDuplicateWrites,
  detectHungRequests,
  detectInertControls,
  detectInternalIds,
  detectSignals,
  makeSignalFinding,
  withSignalFindings,
  type RunSignalCapture,
  type SignalRequest,
  type SignalScreen,
  type SignalStep,
} from "./signals.js";
import { buildReport } from "./report.js";
import type { AnalysisOutcome } from "./types.js";

const URL = "http://app.test/bets/7";

function screen(index: number, step: number, at: number, over: Partial<SignalScreen> = {}): SignalScreen {
  return { index, step, at, url: URL, signature: `sig-${index}`, visibleText: "Bet 7\nRun simulation", busy: false, screenshot: `/out/s/screen-${index}.png`, ...over };
}

function req(id: number, step: number, startedAt: number, endedAt: number | null, over: Partial<SignalRequest> = {}): SignalRequest {
  return {
    id,
    method: "GET",
    endpoint: "GET /api/bets/:id",
    url: "http://app.test/api/bets/7",
    resourceType: "fetch",
    startedAt,
    endedAt,
    status: endedAt === null ? null : 200,
    step,
    ...over,
  };
}

function click(step: number, name: string, over: Partial<SignalStep> = {}): SignalStep {
  return { step, op: "click", target: `button "${name}"`, actOk: true, url: URL, descriptor: { role: "button", name }, ...over };
}

function capture(over: Partial<RunSignalCapture>): RunSignalCapture {
  return { steps: [], requests: [], screens: [], endedAt: 100_000, ...over };
}

describe("detectHungRequests", () => {
  const typical = [req(0, 0, 0, 100), req(1, 0, 200, 300), req(2, 1, 400, 520)];

  it("flags a request pending far past the run's typical time while no screen shows status", () => {
    const c = capture({
      steps: [click(1, "Run simulation")],
      requests: [...typical, req(3, 1, 1_000, null, { method: "POST", endpoint: "POST /api/simulations", url: "http://app.test/api/simulations" })],
      screens: [screen(0, 1, 500), screen(1, 2, 20_000), screen(2, 3, 60_000)],
      endedAt: 90_000,
    });
    const [f, ...rest] = detectHungRequests(c);
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ rubricItemId: "signal-hung-request", tier: "signal", severity: "major", route: "/bets/:id" }); // #95: dynamic segments are templated
    expect(f!.observation).toContain("POST /api/simulations");
    expect(f!.observation).toContain("still pending");
    expect(f!.signal).toMatchObject({ kind: "hung-request", screenshot: "/out/s/screen-2.png" });
    expect(f!.signal!.requests[0]).toMatchObject({ id: 3, pending: true, durationMs: 89_000, step: 1 });
    expect(f!.signal!.steps).toContain(1);
    expect(f!.evidenceRefs.map((r) => r.id)).toEqual(expect.arrayContaining(["step:1", "request:3", "screenshot:/out/s/screen-2.png"]));
    expect(f!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("is silent when a screen in the window shows status (DOM busy flag or progress text)", () => {
    const hung = req(3, 1, 1_000, null, { endpoint: "POST /api/simulations" });
    expect(detectHungRequests(capture({ requests: [...typical, hung], screens: [screen(1, 2, 20_000, { busy: true })] }))).toHaveLength(0);
    expect(
      detectHungRequests(capture({ requests: [...typical, hung], screens: [screen(1, 2, 20_000, { visibleText: "Simulation running (42%)" })] })),
    ).toHaveLength(0);
  });

  it("is silent under the threshold, with no screen in the window, and for assets", () => {
    expect(detectHungRequests(capture({ requests: [...typical, req(3, 1, 1_000, 9_000)], screens: [screen(1, 2, 5_000)] }))).toHaveLength(0);
    expect(detectHungRequests(capture({ requests: [...typical, req(3, 1, 1_000, null)], screens: [screen(1, 1, 500)] }))).toHaveLength(0);
    expect(
      detectHungRequests(capture({ requests: [...typical, req(3, 1, 1_000, null, { resourceType: "image" })], screens: [screen(1, 2, 20_000)] })),
    ).toHaveLength(0);
  });

  it("scales the threshold with the run's own typical time", () => {
    const slow = [req(0, 0, 0, 5_000), req(1, 0, 0, 5_000), req(2, 0, 0, 5_000)];
    // 10× a 5s p50 = 50s: a 30s wait is not hung on this app.
    const c = capture({ requests: [...slow, req(3, 1, 1_000, 31_000)], screens: [screen(1, 2, 20_000)] });
    expect(detectHungRequests(c)).toHaveLength(0);
    expect(detectHungRequests(c, { hungFactor: 2, hungFloorMs: 1_000 })).toHaveLength(1);
  });
});

describe("detectDuplicateWrites", () => {
  const post = (id: number, step: number, status = 201) =>
    req(id, step, step * 1_000, step * 1_000 + 50, { method: "POST", endpoint: "POST /api/launches", url: "http://app.test/api/launches", status });

  it("flags the same control clicked twice where the same write succeeded twice", () => {
    const c = capture({
      steps: [click(1, "Launch"), click(2, "Launch")],
      requests: [post(0, 1), post(1, 2)],
      screens: [screen(0, 1, 500), screen(1, 2, 1_500), screen(2, 3, 2_500)],
    });
    const [f] = detectDuplicateWrites(c);
    expect(f).toMatchObject({ rubricItemId: "signal-duplicate-write", severity: "major", controls: ['button "Launch"'], occurrences: 2 });
    expect(f!.signal!.steps).toEqual([1, 2]);
    expect(f!.signal!.requests.map((r) => r.id)).toEqual([0, 1]);
    expect(f!.signal!.screenshot).toBe("/out/s/screen-1.png");
    expect(f!.confidence).toBe(0.8);
  });

  it("flags one click that fired the same write twice (the app double-submits)", () => {
    const c = capture({ steps: [click(1, "Launch")], requests: [post(0, 1), post(1, 1)], screens: [screen(0, 1, 500)] });
    const [f] = detectDuplicateWrites(c);
    expect(f).toMatchObject({ rubricItemId: "signal-duplicate-write", occurrences: 2 });
    expect(f!.signal!.steps).toEqual([1]);
    expect(f!.confidence).toBe(0.8);
  });

  it("flags an unguarded control the run refused to re-click after its write succeeded (#92), at lower confidence", () => {
    const refused = {
      ...click(2, "Launch"),
      actOk: false,
      reason: 'repeated side effect refused: "Launch" already sent POST /api/launches on this page and the page does not offer a retry — clicking it again would repeat that action',
    };
    const c = capture({ steps: [click(1, "Launch"), refused], requests: [post(0, 1)], screens: [screen(0, 1, 500), screen(1, 2, 1_500)] });
    const [f] = detectDuplicateWrites(c);
    expect(f).toMatchObject({ rubricItemId: "signal-duplicate-write", controls: ['button "Launch"'], occurrences: 1 });
    expect(f!.signal!.steps).toEqual([1, 2]);
    expect(f!.confidence).toBe(0.55);
    expect(f!.observation).toMatch(/jevitate declined to repeat it/);
    // Still in flight, not "already sent": waiting was right, and nothing is flagged.
    const inFlight = { ...refused, reason: 'repeated side effect refused: "Launch" already sent POST, still in flight — waiting for it instead of re-clicking' };
    expect(detectDuplicateWrites(capture({ steps: [click(1, "Launch"), inFlight], requests: [post(0, 1)] }))).toHaveLength(0);
  });

  it("is silent when the repeat was rejected, for reads, and for different controls", () => {
    expect(detectDuplicateWrites(capture({ steps: [click(1, "Launch"), click(2, "Launch")], requests: [post(0, 1), post(1, 2, 409)] }))).toHaveLength(0);
    expect(
      detectDuplicateWrites(capture({ steps: [click(1, "Launch"), click(2, "Launch")], requests: [req(0, 1, 0, 10), req(1, 2, 20, 30)] })),
    ).toHaveLength(0);
    expect(detectDuplicateWrites(capture({ steps: [click(1, "Launch"), click(2, "Save")], requests: [post(0, 1), post(1, 2)] }))).toHaveLength(0);
  });

  it("lowers confidence when input was edited between the clicks", () => {
    const [f] = detectDuplicateWrites(
      capture({
        steps: [click(1, "Launch"), { step: 2, op: "type", target: "Name", actOk: true, url: URL }, click(3, "Launch")],
        requests: [post(0, 1), post(1, 3)],
      }),
    );
    expect(f!.confidence).toBeLessThan(0.6);
    expect(f!.observation).toContain("edited");
  });
});

describe("detectInternalIds", () => {
  const uuid = "3f2b8c1e-9a4d-4e7f-8b21-6c5d4a3b2e10";

  it("flags a UUID rendered in user-facing text, citing the line and screenshot", () => {
    const [f, ...rest] = detectInternalIds(capture({ screens: [screen(0, 2, 0, { visibleText: `Approval\nDecision maker ${uuid}\nApprove` })] }));
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ rubricItemId: "signal-internal-id", severity: "minor", quotes: [`Decision maker ${uuid}`] });
    expect(f!.signal).toMatchObject({ kind: "internal-id", steps: [2], text: `Decision maker ${uuid}`, screenshot: "/out/s/screen-0.png" });
    expect(f!.confidence).toBe(0.8);
  });

  it("skips ids the run typed itself, and halves confidence for a labeled reference", () => {
    expect(detectInternalIds(capture({ typedValues: [uuid], screens: [screen(0, 1, 0, { visibleText: `Title ${uuid}` })] }))).toHaveLength(0);
    const [f] = detectInternalIds(capture({ screens: [screen(0, 1, 0, { visibleText: `Request ID: ${uuid}` })] }));
    expect(f!.confidence).toBe(0.4);
  });

  it("recognizes ObjectId and prefixed ids but not plain words or numbers", () => {
    const found = detectInternalIds(
      capture({ screens: [screen(0, 1, 0, { visibleText: "Owner 64b7f0c2a1e3d4b5c6a7f8e9\nCustomer cus_9aB3kLmN0pQrStUv1\nTotal 1234567890\nsnake_case_words_here" })] }),
    );
    expect(found.map((f) => f.observation)).toEqual([expect.stringContaining("ObjectId"), expect.stringContaining("prefixed internal id")]);
  });
});

describe("detectInertControls", () => {
  it("flags a click after which url, screen, text are unchanged and no request fired", () => {
    const c = capture({
      steps: [click(1, "Double down"), click(2, "Double down")],
      screens: [screen(0, 1, 0, { signature: "same" }), screen(1, 2, 1_000, { signature: "same" }), screen(2, 3, 2_000, { signature: "same" })],
    });
    const [f] = detectInertControls(c);
    expect(f).toMatchObject({ rubricItemId: "signal-inert-control", controls: ['button "Double down"'], occurrences: 2, confidence: 0.7 });
    expect(f!.signal).toMatchObject({ steps: [1, 2], screenshot: "/out/s/screen-2.png" });
  });

  it("is silent when the click sent a request, changed the screen, or was the last step", () => {
    const same = { signature: "same" };
    expect(
      detectInertControls(capture({ steps: [click(1, "Go")], requests: [req(0, 1, 10, 20)], screens: [screen(0, 1, 0, same), screen(1, 2, 1, same)] })),
    ).toHaveLength(0);
    expect(detectInertControls(capture({ steps: [click(1, "Go")], screens: [screen(0, 1, 0, same), screen(1, 2, 1, { signature: "other" })] }))).toHaveLength(0);
    expect(
      detectInertControls(capture({ steps: [click(1, "Go")], screens: [screen(0, 1, 0, same), screen(1, 2, 1, { ...same, visibleText: "Saved" })] })),
    ).toHaveLength(0);
    expect(detectInertControls(capture({ steps: [click(1, "Go")], screens: [screen(0, 1, 0, same)] }))).toHaveLength(0);
  });

  describe("#127 — a link to the CURRENT page doing nothing is not inert", () => {
    const same = { signature: "same" };
    const unchanged = (over: Partial<SignalStep> = {}) =>
      capture({
        steps: [click(1, "Applications", over)],
        screens: [screen(0, 1, 0, same), screen(1, 2, 1_000, same)],
      });

    it("is silent when the clicked link's href resolves to the page it was clicked on", () => {
      expect(detectInertControls(unchanged({ href: URL }))).toHaveLength(0);
    });

    it("ignores a hash and a trailing slash when comparing href to the current URL", () => {
      expect(detectInertControls(unchanged({ href: `${URL}#section` }))).toHaveLength(0);
      expect(detectInertControls(unchanged({ href: `${URL}/` }))).toHaveLength(0);
    });

    it("is silent when the control carries aria-current", () => {
      expect(detectInertControls(unchanged({ ariaCurrent: "page" }))).toHaveLength(0);
      expect(detectInertControls(unchanged({ ariaCurrent: "true" }))).toHaveLength(0);
    });

    it("aria-current=\"false\" is explicitly NOT current — still flagged inert", () => {
      expect(detectInertControls(unchanged({ ariaCurrent: "false" }))).toHaveLength(1);
    });

    it("a link to a DIFFERENT page doing nothing is still flagged inert", () => {
      expect(detectInertControls(unchanged({ href: "http://app.test/bets/8" }))).toHaveLength(1);
    });

    it("a control with no href and no aria-current is still flagged inert (unchanged behaviour)", () => {
      expect(detectInertControls(unchanged())).toHaveLength(1);
    });
  });
});

describe("signal findings through the report", () => {
  const analyzed: AnalysisOutcome = { kind: "analyzed", findings: [], coverage: { totalItems: 1, evaluated: 1, skipped: [], budgetTruncated: [] } };
  const signals = detectSignals(
    capture({
      steps: [click(1, "Go")],
      screens: [screen(0, 1, 0, { signature: "same" }), screen(1, 2, 1, { signature: "same", visibleText: "Owner 3f2b8c1e-9a4d-4e7f-8b21-6c5d4a3b2e10" })],
    }),
  );

  it("pass through --min-confidence like every other finding (suppressed, counted, never dropped)", () => {
    expect(signals.map((f) => f.rubricItemId).sort()).toEqual(["signal-internal-id"]);
    const kept = buildReport(withSignalFindings(analyzed, signals), { minConfidence: 0.3 });
    expect(kept.findings.map((f) => f.rubricItemId)).toEqual(["signal-internal-id"]);
    const cut = buildReport(withSignalFindings(analyzed, signals), { minConfidence: 0.9 });
    expect(cut.findings).toHaveLength(0);
    expect(cut.suppressed.byReason["below-min-confidence"]).toBe(1);
    expect(cut.suppressed.byRubricItem["signal-internal-id"]).toBe(1);
    expect(cut.clean).toBe(false);
  });

  it("the finding gate refuses an evidence-less signal finding", () => {
    expect(() =>
      makeSignalFinding({
        kind: "inert-control",
        confidence: 0.5,
        url: URL,
        screenId: "s",
        observation: "o",
        userImpact: "u",
        recommendation: "r",
        evidence: { kind: "inert-control", steps: [], requests: [], detail: "d" },
      }),
    ).toThrow(/evidence gate/);
  });
});
