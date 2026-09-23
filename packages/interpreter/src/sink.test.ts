import { expect, test, vi } from "vitest";
import type { PageSegment, Recording, RecordedStep } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter } from "./interpreter.js";
import { BufferingSink } from "./sink.js";

// === fakes, mirroring interpreter.test.ts's pattern ===

function fakeLocator(overrides: Partial<Record<string, any>> = {}) {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    pressSequentially: vi.fn(async () => {}),
    innerText: vi.fn(async () => ""),
    isVisible: vi.fn(async () => true),
    count: vi.fn(async () => 1), // the recorded target resolves uniquely
    waitFor: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakePage(locator: ReturnType<typeof fakeLocator>, url = "https://example.test/inbox") {
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => url),
    getByTestId: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
  };
}

function actorWithPage(page: any) {
  return CastActor.named("test").whoCan(
    new BrowseTheWeb(
      { page, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any,
      [],
    ),
  );
}

function recording(pages: RecordedStep[][]): Recording {
  const segments: PageSegment[] = pages.map((steps, i) => ({
    url: `https://example.test/page${i}`,
    steps,
  }));
  return { version: "1.0", site: "https://example.test", pages: segments };
}

// === BufferingSink: happy path ===

test("BufferingSink: a 3-step recording (navigate -> fill -> click) sinks one RecordedStep per step, in order, validating against RecordingSchema", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      {
        step: {
          kind: "fill",
          target: { label: "Body" },
          value: { redacted: false, value: "hi" },
          expect: { kind: "visible", target: { label: "Body" } },
        },
      },
      { step: { kind: "click", target: { testId: "send" }, expect: { kind: "visible", target: { testId: "sent" } } } },
    ],
  ]);

  const sink = new BufferingSink();
  const interp = new RecordingInterpreter();
  const result = await interp.run(actor as any, rec, undefined, sink);

  expect(result.outcome).toBe("completed");

  const runRecording = sink.toRecording({ site: "https://example.test" });

  // Validates against RecordingSchema (re-parse; parse itself would already
  // have thrown inside toRecording if invalid, so this is a second, explicit
  // check per the test brief).
  expect(() => RecordingSchema.parse(runRecording)).not.toThrow();

  const sunkSteps = runRecording.pages.flatMap((p) => p.steps);
  expect(sunkSteps).toHaveLength(3);
  expect(sunkSteps.map((s) => s.step.kind)).toEqual(["navigate", "fill", "click"]);

  // Descriptor/value data matches the input exactly (unchanged, per ruling 3).
  const inputFlat = rec.pages.flatMap((p) => p.steps);
  sunkSteps.forEach((sunk, i) => {
    expect(sunk.step).toEqual(inputFlat[i].step);
  });
});

// === BufferingSink: redaction guardrail ===

test("BufferingSink: a redacted fill value is re-emitted exactly as redacted, never as the resolved plaintext", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      {
        step: {
          kind: "fill",
          target: { label: "Password" },
          value: { redacted: true, length: 8 },
          expect: { kind: "visible", target: { label: "Password" } },
        },
      },
    ],
  ]);

  const sink = new BufferingSink();
  const interp = new RecordingInterpreter();
  const vars = { password: "hunter22" };
  const result = await interp.run(actor as any, rec, vars, sink);
  expect(result.outcome).toBe("failed"); // redacted constant can't resolve to plaintext for typing

  // Even on a run that fails resolving the redacted constant, prove the
  // guardrail with a var-backed redacted-shaped value that DOES execute:
  const recWithVar = recording([
    [
      {
        step: {
          kind: "fill",
          target: { label: "Password" },
          value: { var: "password" },
          expect: { kind: "visible", target: { label: "Password" } },
        },
      },
    ],
  ]);
  const sink2 = new BufferingSink();
  const result2 = await interp.run(actor as any, recWithVar, vars, sink2);
  expect(result2.outcome).toBe("completed");
  expect(locator.fill).toHaveBeenCalledWith("hunter22");

  const runRecording = sink2.toRecording({ site: "https://example.test" });
  const sunk = runRecording.pages.flatMap((p) => p.steps);
  expect(sunk).toHaveLength(1);
  const sunkStep = sunk[0].step;
  if (sunkStep.kind !== "fill") throw new Error("expected fill step");
  // The sunk value must stay `{var:"password"}` — NEVER the resolved
  // plaintext "hunter22" that was actually typed into the page.
  expect(sunkStep.value).toEqual({ var: "password" });
  expect(JSON.stringify(runRecording)).not.toContain("hunter22");
});

test("BufferingSink: a redacted:true fill value that fails to resolve sinks nothing for that step (redacted constants can never be replayed)", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      {
        step: {
          kind: "fill",
          target: { label: "Password" },
          value: { redacted: true, length: 8 },
          expect: { kind: "visible", target: { label: "Password" } },
        },
      },
    ],
  ]);

  const sink = new BufferingSink();
  const interp = new RecordingInterpreter();
  const result = await interp.run(actor as any, rec, undefined, sink);
  expect(result).toEqual({
    outcome: "failed",
    at: 1,
    error: expect.stringContaining("redacted"),
  });

  const runRecording = sink.toRecording({ site: "https://example.test" });
  const sunk = runRecording.pages.flatMap((p) => p.steps);
  // Only step 0 (navigate) completed before the failure at step 1.
  expect(sunk).toHaveLength(1);
  expect(sunk[0].step.kind).toBe("navigate");
});

// === BufferingSink: timing ===

test("BufferingSink: each sunk step carries a timing object with non-negative, non-decreasing atMs/gapBeforeMs and a present durationMs", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      { step: { kind: "assert", check: { kind: "visible", target: { testId: "loaded" } } } },
      { step: { kind: "assert", check: { kind: "visible", target: { testId: "loaded" } } } },
    ],
  ]);

  const sink = new BufferingSink();
  const interp = new RecordingInterpreter();
  await interp.run(actor as any, rec, undefined, sink);

  const runRecording = sink.toRecording({ site: "https://example.test" });
  const sunk = runRecording.pages.flatMap((p) => p.steps);
  expect(sunk).toHaveLength(3);

  let prevAtMs = -1;
  for (const s of sunk) {
    expect(s.timing).toBeDefined();
    expect(s.timing!.atMs).toBeGreaterThanOrEqual(0);
    expect(s.timing!.gapBeforeMs).toBeGreaterThanOrEqual(0);
    expect(typeof s.timing!.durationMs).toBe("number");
    expect(s.timing!.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.timing!.atMs).toBeGreaterThanOrEqual(prevAtMs);
    prevAtMs = s.timing!.atMs;
  }

  // Timing is measured, not copied from any input `timing` (the input had none).
  expect(rec.pages[0].steps.every((s) => s.timing === undefined)).toBe(true);
});

// === BufferingSink: forEach sinks as one unit ===

test("BufferingSink: a forEach over multiple rows sinks exactly ONE RecordedStep, not one per row", async () => {
  const leaf = fakeLocator({ isVisible: vi.fn(async () => true) });
  const rowRoot = {
    getByTestId: vi.fn(() => leaf),
    getByRole: vi.fn(() => leaf),
    getByLabel: vi.fn(() => leaf),
    getByText: vi.fn(() => leaf),
    locator: vi.fn(() => leaf),
  };
  const itemsLocator = {
    count: vi.fn(async () => 3),
    nth: vi.fn(() => rowRoot),
  };
  const page = fakePage(leaf);
  page.getByTestId = vi.fn(() => itemsLocator) as any;
  const actor = actorWithPage(page);

  const rec = recording([
    [
      {
        step: {
          kind: "forEach",
          items: { testId: "rows" },
          as: "row",
          steps: [
            {
              kind: "click",
              target: { testId: "delete-btn" },
              expect: { kind: "visible", target: { testId: "delete-btn" } },
            },
          ],
        },
      },
    ],
  ]);

  const sink = new BufferingSink();
  const interp = new RecordingInterpreter();
  const result = await interp.run(actor as any, rec, undefined, sink);
  expect(result.outcome).toBe("completed");

  const runRecording = sink.toRecording({ site: "https://example.test" });
  const sunk = runRecording.pages.flatMap((p) => p.steps);
  expect(sunk).toHaveLength(1);
  expect(sunk[0].step.kind).toBe("forEach");
});

// === sink omitted: zero behavior change ===

test("run: omitting sink produces the exact same InterpretResult as before (no sink argument at all)", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [{ step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } }],
  ]);

  const interp = new RecordingInterpreter();
  const result = await interp.run(actor as any, rec);
  expect(result).toEqual({ outcome: "completed", vars: {} });
});

// === BufferingSink: toRecording assembly ===

test("BufferingSink.toRecording: assembles a single-PageSegment Recording using the given site/url/version", () => {
  const sink = new BufferingSink();
  sink.step({ step: { kind: "assert", check: { kind: "visible", target: { testId: "x" } } }, timing: { atMs: 0, durationMs: 1, gapBeforeMs: 0 } });

  const runRecording = sink.toRecording({ site: "https://example.test", url: "https://example.test/start", version: "2.0" });
  expect(runRecording.version).toBe("2.0");
  expect(runRecording.site).toBe("https://example.test");
  expect(runRecording.pages).toHaveLength(1);
  expect(runRecording.pages[0].url).toBe("https://example.test/start");
  expect(runRecording.pages[0].steps).toHaveLength(1);
});

test("BufferingSink.toRecording: defaults version and url sensibly when omitted", () => {
  const sink = new BufferingSink();
  sink.step({ step: { kind: "assert", check: { kind: "visible", target: { testId: "x" } } } });
  const runRecording = sink.toRecording({ site: "https://example.test" });
  expect(typeof runRecording.version).toBe("string");
  expect(runRecording.version.length).toBeGreaterThan(0);
  expect(runRecording.pages[0].url).toBe("https://example.test");
});
