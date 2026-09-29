import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectDuplicateCreates,
  detectFailedSubmits,
  detectRepeatedReplies,
  detectSignals,
  detectStuckJobs,
  detectUrlMismatches,
  type RunSignalCapture,
  type SignalRequest,
  type SignalScreen,
  type SignalStep,
} from "./signals.js";

// #131: the defect shapes the Preveti dogfood runs walked past without a usability finding. The
// fixtures under test-fixtures/preveti are built from the round-1/round-2 transcripts (redacted;
// each file's `_source` says what is real and what is reconstructed).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "preveti");

function fixture(name: string): RunSignalCapture {
  const { _source, ...capture } = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as RunSignalCapture & { _source: string };
  expect(_source.length).toBeGreaterThan(0);
  return capture;
}

const URL = "http://app.test/jobs";

function step(n: number, op: string, over: Partial<SignalStep> = {}): SignalStep {
  return { step: n, op, target: null, actOk: true, url: URL, ...over };
}
function click(n: number, name: string, over: Partial<SignalStep> = {}): SignalStep {
  return step(n, "click", { target: `button "${name}"`, descriptor: { role: "button", name }, ...over });
}
function req(id: number, n: number, over: Partial<SignalRequest> = {}): SignalRequest {
  return { id, method: "POST", endpoint: "POST /api/things", url: "http://app.test/api/things", resourceType: "fetch", startedAt: n * 1000, endedAt: n * 1000 + 50, status: 201, step: n, ...over };
}
function screen(index: number, n: number, text: string, over: Partial<SignalScreen> = {}): SignalScreen {
  return { index, step: n, at: n * 1000 + 500, url: URL, signature: `sig-${index}`, visibleText: text, busy: false, screenshot: `/out/screen-${index}.png`, ...over };
}

describe("#131 known-defect fixtures (Preveti) — each is surfaced with cited evidence", () => {
  it("P-12: a started simulation shows no result for minutes while “Run the simulation →” is still offered (stuck job)", () => {
    const c = fixture("p12-stuck-job.json");
    const [f, ...rest] = detectStuckJobs(c);
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ rubricItemId: "signal-stuck-job", tier: "signal", severity: "major" });
    expect(f!.observation).toContain("Run the simulation");
    expect(f!.observation).toMatch(/clicked it again \(step 6\)/);
    expect(f!.signal!.steps).toEqual(expect.arrayContaining([2, 6]));
    expect(f!.signal!.requests[0]).toMatchObject({ method: "POST", status: 200, step: 2 });
    expect(f!.signal!.text).toContain("Run the simulation");
    expect(f!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("P-2: the same canned fallback came back as the assistant reply on 6 of 8 turns (repeated reply)", () => {
    const [f, ...rest] = detectRepeatedReplies(fixture("p2-repeated-reply.json"));
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ rubricItemId: "signal-repeated-reply", severity: "major", occurrences: 6 });
    expect(f!.observation).toMatch(/6 of 8 sent message/);
    expect(f!.quotes[0]).toContain("Guided AI framing is unavailable right now");
    expect(f!.signal!.steps).toEqual([1, 2, 4, 5, 7, 8]);
  });

  it("P-14: the same participant saved twice, listed twice, no warning (duplicate create) — reported once, not also as a duplicate write", () => {
    const c = fixture("p14-duplicate-create.json");
    const [f, ...rest] = detectDuplicateCreates(c);
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ rubricItemId: "signal-duplicate-create", severity: "major", occurrences: 2 });
    expect(f!.observation).toContain("POST /v1/participants");
    expect(f!.observation).toMatch(/lists it 2 times/);
    expect(f!.signal!.requests.map((r) => [r.id, r.status])).toEqual([
      [1, 200],
      [2, 200],
    ]);
    expect(f!.signal!.text).toContain("dana@example.com");
    const all = detectSignals(c);
    expect(all.filter((x) => x.rubricItemId === "signal-duplicate-write")).toHaveLength(0);
    expect(all.filter((x) => x.rubricItemId === "signal-duplicate-create")).toHaveLength(1);
  });

  it("P-4: POST …/answer returned 503 and the next screen only said “Something went wrong” (failed submit)", () => {
    const [f, ...rest] = detectFailedSubmits(fixture("p4-failed-submit.json"));
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ rubricItemId: "signal-failed-submit", severity: "major" });
    expect(f!.observation).toMatch(/POST \/v1\/elicit\/:id\/answer, which returned 503/);
    expect(f!.quotes).toEqual(["Something went wrong"]);
    expect(f!.signal!.requests).toEqual([expect.objectContaining({ status: 503, step: 3 })]);
    expect(f!.signal!.steps).toEqual([3, 4]);
  });

  it("P-16: onboarding content under /login after login + 2FA (url mismatch)", () => {
    const [f, ...rest] = detectUrlMismatches(fixture("p16-url-mismatch.json"));
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ rubricItemId: "signal-url-mismatch", route: "/login", severity: "minor" });
    expect(f!.observation).toContain("Welcome to Preveti");
    expect(f!.observation).toContain("Enter your authentication code");
    expect(f!.signal!.steps).toEqual([6, 7]);
  });

  it("recall benchmark: every known-defect fixture is surfaced by detectSignals (target ≥ 70%)", () => {
    const expected: Record<string, string> = {
      "p12-stuck-job.json": "signal-stuck-job",
      "p2-repeated-reply.json": "signal-repeated-reply",
      "p14-duplicate-create.json": "signal-duplicate-create",
      "p4-failed-submit.json": "signal-failed-submit",
      "p16-url-mismatch.json": "signal-url-mismatch",
    };
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(Object.keys(expected).sort());
    const surfaced = files.filter((f) => detectSignals(fixture(f)).some((x) => x.rubricItemId === expected[f]));
    const recall = surfaced.length / files.length;
    expect(recall).toBeGreaterThanOrEqual(0.7);
    expect(surfaced.sort()).toEqual(files.sort());
  });
});

describe("#131 journey oracles — no finding without the defect", () => {
  it("stuck job: none when the job completes (the start action is no longer offered) or the wait is short", () => {
    const base: RunSignalCapture = {
      steps: [click(1, "Start job"), step(2, "wait", { reason: "waited 3.0s (the page did not change)" }), step(3, "wait")],
      requests: [req(0, 1), req(1, 0, { method: "GET", endpoint: "GET /api/x" }), req(2, 0, { method: "GET", endpoint: "GET /api/y" })],
      screens: [screen(0, 1, "Job\nStart job"), screen(1, 2, "Job\nStart job"), screen(2, 3, "Job\nStart job", { at: 100_000 })],
      endedAt: 120_000,
    };
    expect(detectStuckJobs(base)).toHaveLength(1);
    expect(detectStuckJobs({ ...base, screens: [screen(0, 1, "Job\nStart job"), screen(1, 2, "Job\nDone: 3 results"), screen(2, 3, "Job\nDone: 3 results", { at: 100_000 })] })).toHaveLength(0);
    expect(detectStuckJobs({ ...base, screens: base.screens.map((s) => ({ ...s, at: 2_000 + s.index })), endedAt: 10_000 })).toHaveLength(0);
    // No in-progress sign at all (no wait, retry, busy screen or polling): the user simply moved on.
    expect(detectStuckJobs({ ...base, steps: [click(1, "Start job"), step(2, "scroll_down"), step(3, "scroll_up")] })).toHaveLength(0);
  });

  it("repeated reply: none for varied replies, or a non-error reply repeated only twice", () => {
    const sends = (replies: string[]): RunSignalCapture => ({
      steps: replies.map((r, i) => step(i + 1, "send", { message: `m${i}`, reply: r })),
      requests: [],
      screens: [screen(0, 1, "Chat")],
      endedAt: 10_000,
    });
    expect(detectRepeatedReplies(sends(["What is your goal here?", "Which users matter most?", "What would change your mind?"]))).toHaveLength(0);
    expect(detectRepeatedReplies(sends(["Tell me more about that please.", "Tell me more about that please."]))).toHaveLength(0);
    expect(detectRepeatedReplies(sends(["Tell me more about that please.", "Tell me more about that please.", "Tell me more about that please."]))).toHaveLength(1);
  });

  it("duplicate create: none for different values, or when the app warns that it already exists", () => {
    const run = (second: string, after: string): RunSignalCapture => ({
      steps: [step(1, "type", { value: "Ada" }), click(2, "Save"), step(3, "type", { value: second }), click(4, "Save")],
      requests: [req(0, 2), req(1, 4)],
      screens: [screen(0, 1, "People"), screen(1, 3, "People\nAda"), screen(2, 5, after)],
      endedAt: 10_000,
    });
    expect(detectDuplicateCreates(run("Grace", "People\nAda\nGrace"))).toHaveLength(0);
    expect(detectDuplicateCreates(run("Ada", "People\nAda\nA person named Ada already exists"))).toHaveLength(0);
    expect(detectDuplicateCreates(run("Ada", "People\nAda\nAda"))).toHaveLength(1);
    // The same body digest is enough on its own (no typed values needed).
    const digest: RunSignalCapture = {
      steps: [click(1, "Add"), click(2, "Add")],
      requests: [req(0, 1, { payloadKey: "k1" }), req(1, 2, { payloadKey: "k1" })],
      screens: [screen(0, 1, "List"), screen(1, 3, "List")],
      endedAt: 5_000,
    };
    expect(detectDuplicateCreates(digest)[0]!.signal!.detail).toMatch(/identical body digest/);
    expect(detectDuplicateCreates({ ...digest, requests: [req(0, 1, { payloadKey: "k1" }), req(1, 2, { payloadKey: "k2" })] })).toHaveLength(0);
  });

  it("failed submit: none when a specific error is shown, when the page navigates, or when the write succeeded", () => {
    const run = (after: string, over: Partial<SignalRequest> = {}, afterUrl = URL): RunSignalCapture => ({
      steps: [click(1, "Submit")],
      requests: [req(0, 1, { status: 422, ...over })],
      screens: [screen(0, 1, "Form\nSubmit"), screen(1, 2, after, { url: afterUrl })],
      endedAt: 5_000,
    });
    expect(detectFailedSubmits(run("Form\nSubmit"))[0]!.observation).toMatch(/showed no error at all/);
    expect(detectFailedSubmits(run("Form\nEmail is invalid\nSubmit"))).toHaveLength(0);
    expect(detectFailedSubmits(run("Signed out", {}, "http://app.test/login"))).toHaveLength(0);
    expect(detectFailedSubmits(run("Form\nSubmit", { status: 201 }))).toHaveLength(0);
    expect(detectFailedSubmits(run("Form\nSubmit", { method: "GET", endpoint: "GET /api/things" }))).toHaveLength(0);
  });

  it("url mismatch: none for tabs under an ordinary route, or content matching its route", () => {
    const tabs: RunSignalCapture = {
      steps: [click(1, "Billing")],
      requests: [],
      screens: [
        screen(0, 1, "Settings\nProfile", { url: "http://app.test/settings", heading: "Settings" }),
        screen(1, 2, "Billing\nPlan", { url: "http://app.test/settings", heading: "Billing" }),
      ],
      endedAt: 5_000,
    };
    expect(detectUrlMismatches(tabs)).toHaveLength(0);
    // A heading seen under its own route elsewhere, shown under another route, is a mismatch even off the known list.
    const moved: RunSignalCapture = {
      ...tabs,
      screens: [
        screen(0, 1, "Billing", { url: "http://app.test/billing", heading: "Billing" }),
        screen(1, 2, "Billing", { url: "http://app.test/settings", heading: "Billing" }),
      ],
    };
    expect(detectUrlMismatches(moved)).toEqual([expect.objectContaining({ rubricItemId: "signal-url-mismatch", route: "/settings" })]);
  });
});
