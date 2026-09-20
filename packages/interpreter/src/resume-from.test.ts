import { expect, test, vi } from "vitest";
import type { PageSegment, Recording, RecordedStep } from "@doit/recording";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { RecordingInterpreter } from "./interpreter.js";

// === fakes, mirroring interpreter.test.ts's pattern ===

function fakeLocator(overrides: Partial<Record<string, any>> = {}) {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    pressSequentially: vi.fn(async () => {}),
    innerText: vi.fn(async () => ""),
    isVisible: vi.fn(async () => true),
    count: vi.fn(async () => 0),
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

function threeStepRecording() {
  const navigateLocator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const page = fakePage(navigateLocator);
  const actor = actorWithPage(page);
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      { step: { kind: "assert", check: { kind: "visible", target: { testId: "loaded" } } } },
      { step: { kind: "click", target: { testId: "delete-btn" }, expect: { kind: "visible", target: { testId: "confirm" } } } },
    ],
  ]);
  return { actor, rec, page, locator: navigateLocator };
}

// === resumeFrom ===

test("resumeFrom(2) on a 3-step recording only executes step 2 (steps 0,1 not invoked) and completes", async () => {
  const { actor, rec, page, locator } = threeStepRecording();

  const interp = new RecordingInterpreter();
  const result = await interp.resumeFrom(actor as any, rec, 2);

  // step 0 (navigate) not invoked
  expect(page.goto).not.toHaveBeenCalled();
  // step 1 (assert) and step 2 (click) both read isVisible via the locator,
  // so the strongest signal that step 0/1 were skipped and only step 2 ran
  // is that click (step 2's action) fired exactly once and navigate never did.
  expect(locator.click).toHaveBeenCalledTimes(1);

  expect(result).toEqual({ outcome: "completed", vars: {} });
});

test("resumeFrom(0) on a 3-step recording runs all three steps, equivalent to a full run", async () => {
  const { actor, rec, page, locator } = threeStepRecording();

  const interp = new RecordingInterpreter();
  const result = await interp.resumeFrom(actor as any, rec, 0);

  expect(page.goto).toHaveBeenCalledTimes(1);
  expect(locator.click).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ outcome: "completed", vars: {} });
});
