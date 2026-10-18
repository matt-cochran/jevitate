import { expect, test, vi } from "vitest";
import type { PageSegment, Recording, RecordedStep } from "@jevitate/recording";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter } from "./interpreter.js";
import { runStep, SelectAlternativeUnavailableError } from "./run-step.js";

// #579 — a swap-param feeding a `select` selects a DIFFERENT enabled live option, rather than a
// generated value Playwright would time out on. When no other enabled option exists it fails closed
// with `SelectAlternativeUnavailableError`, never a guess.

function fakeLocator(overrides: Partial<Record<string, any>> = {}) {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
    count: vi.fn(async () => 1), // the recorded target resolves uniquely
    waitFor: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakePage(locator: ReturnType<typeof fakeLocator>) {
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.test/form"),
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
  const segments: PageSegment[] = pages.map((steps, i) => ({ url: `https://example.test/page${i}`, steps }));
  return { version: "1.0", site: "https://example.test", pages: segments };
}

/** A locator whose live `options` are the given ones. */
function locatorWithOptions(options: readonly { disabled: boolean; value: string }[]) {
  return fakeLocator({ evaluate: vi.fn(async (fn: any, arg: any) => fn({ options }, arg)) });
}

const selectStep: RecordedStep = {
  step: {
    kind: "select",
    target: { testId: "country" },
    value: { var: "country" },
    expect: { kind: "visible", target: { testId: "country" } },
  },
};

test("run: selectAlternative chooses a different enabled option for the select step (#579)", async () => {
  const locator = locatorWithOptions([
    { disabled: false, value: "US" },
    { disabled: false, value: "CA" },
  ]);
  const actor = actorWithPage(fakePage(locator));
  const interp = new RecordingInterpreter({ selectAlternative: (index) => (index === 0 ? { avoid: "US" } : undefined) });

  await interp.run(actor as any, recording([[selectStep]]), { country: "US" });

  expect(locator.selectOption).toHaveBeenCalledWith("CA");
});

test("run: selectAlternative fails the run with a no-alternative error when every other option is disabled or empty (#579)", async () => {
  const locator = locatorWithOptions([
    { disabled: false, value: "US" },
    { disabled: true, value: "CA" },
    { disabled: false, value: "" },
  ]);
  const actor = actorWithPage(fakePage(locator));
  const interp = new RecordingInterpreter({ selectAlternative: (index) => (index === 0 ? { avoid: "US" } : undefined) });

  const result = await interp.run(actor as any, recording([[selectStep]]), { country: "US" });

  expect(result).toMatchObject({ outcome: "failed", error: expect.stringContaining("no-alternative") });
});

test("runStep: selectAlternative rejects with SelectAlternativeUnavailableError when there is no other enabled option (#579)", async () => {
  const locator = locatorWithOptions([
    { disabled: false, value: "US" },
    { disabled: true, value: "CA" },
  ]);
  const actor = actorWithPage(fakePage(locator));

  const err = await runStep(actor as any, selectStep, new Map([["country", "US"]]), 0, {
    selectAlternative: () => ({ avoid: "US" }),
  }).catch((e) => e);

  expect(err).toBeInstanceOf(SelectAlternativeUnavailableError);
});
