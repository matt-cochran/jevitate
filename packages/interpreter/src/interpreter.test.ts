import { expect, test, vi } from "vitest";
import type { PageSegment, Recording, RecordedStep } from "@doit/recording";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { RecordingInterpreter } from "./interpreter.js";

// === fakes, mirroring run-step.test.ts's pattern ===

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

// === run: happy path ===

test("run: a 3-step recording (navigate -> extract -> assert) all succeed -> completed with extracted vars", async () => {
  const locator = fakeLocator({
    innerText: vi.fn(async () => "Ada Lovelace"),
    isVisible: vi.fn(async () => true),
  });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      {
        step: {
          kind: "extract",
          target: { testId: "name-el" },
          as: "name",
          expect: { kind: "visible", target: { testId: "name-el" } },
        },
      },
      { step: { kind: "assert", check: { kind: "visible", target: { testId: "name-el" } } } },
    ],
  ]);

  const interp = new RecordingInterpreter();
  const result = await interp.run(actor as any, rec);

  expect(result).toEqual({ outcome: "completed", vars: { name: "Ada Lovelace" } });
});

test("run: seeds initial vars and threads them through the whole recording", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      {
        step: {
          kind: "fill",
          target: { label: "Body" },
          value: { var: "greeting" },
          expect: { kind: "visible", target: { label: "Body" } },
        },
      },
    ],
  ]);

  const interp = new RecordingInterpreter();
  const result = await interp.run(actor as any, rec, { greeting: "hello" });

  expect(result).toEqual({ outcome: "completed", vars: { greeting: "hello" } });
  expect(locator.fill).toHaveBeenCalledWith("hello");
});

// === run: PostconditionFailed -> failed{at} ===

test("run: a postcondition failure at step 1 resolves {outcome:'failed', at:1} (not a rejected promise)", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => false) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "urlIncludes", text: "/inbox" } } },
      { step: { kind: "assert", check: { kind: "visible", target: { testId: "banner" } } } },
      { step: { kind: "assert", check: { kind: "visible", target: { testId: "banner" } } } },
    ],
  ]);

  const interp = new RecordingInterpreter();
  await expect(interp.run(actor as any, rec)).resolves.toEqual({
    outcome: "failed",
    at: 1,
    error: expect.stringContaining("postcondition failed"),
  });
});

// === run: handback -> awaiting_human{at}, stops early ===

test("run: a handback step resolves {outcome:'awaiting_human', at, prompt, resume} and runs no later steps", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const resume = { kind: "visible" as const, target: { testId: "done-banner" } };
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      { step: { kind: "handback", prompt: "please confirm", resume } },
      { step: { kind: "click", target: { testId: "should-not-run" }, expect: { kind: "visible", target: { testId: "x" } } } },
    ],
  ]);

  const interp = new RecordingInterpreter();
  const result = await interp.run(actor as any, rec);

  expect(result).toEqual({ outcome: "awaiting_human", at: 1, prompt: "please confirm", resume });
  expect(locator.click).not.toHaveBeenCalled();
});

// === run: multi-page global flat index ===

test("run: a handback on page 2's first step reports the global flat index, not a per-page index", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const resume = { kind: "urlIncludes" as const, text: "/done" };
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      { step: { kind: "assert", check: { kind: "visible", target: { testId: "loaded" } } } },
    ],
    [{ step: { kind: "handback", prompt: "continue?", resume } }],
  ]);

  const interp = new RecordingInterpreter();
  const result = await interp.run(actor as any, rec);

  // page 0 has 2 steps (indexes 0,1); page 1's step 0 is global index 2.
  expect(result).toEqual({ outcome: "awaiting_human", at: 2, prompt: "continue?", resume });
});

// === run: non-PostconditionFailed error propagates uncaught ===

test("run: a non-PostconditionFailed error (unset {var}) propagates OUT of run() as a rejected promise", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      {
        step: {
          kind: "fill",
          target: { label: "Body" },
          value: { var: "missing" },
          expect: { kind: "visible", target: { label: "Body" } },
        },
      },
    ],
  ]);

  const interp = new RecordingInterpreter();
  await expect(interp.run(actor as any, rec)).rejects.toThrow(/unknown variable/i);
});

// === runToCheckpoint ===

test("runToCheckpoint(1) on a 3-step recording only executes steps 0 and 1", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      {
        step: {
          kind: "extract",
          target: { testId: "name-el" },
          as: "name",
          expect: { kind: "visible", target: { testId: "name-el" } },
        },
      },
      { step: { kind: "click", target: { testId: "delete-btn" }, expect: { kind: "visible", target: { testId: "confirm" } } } },
    ],
  ]);

  const interp = new RecordingInterpreter();
  const result = await interp.runToCheckpoint(actor as any, rec, 1);

  expect(result).toEqual({ outcome: "completed", vars: { name: "" } });
  expect(locator.click).not.toHaveBeenCalled();
});

test("runToCheckpoint with an out-of-range stepIndex (past the end) runs the whole recording", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [
      { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
      { step: { kind: "assert", check: { kind: "visible", target: { testId: "loaded" } } } },
      { step: { kind: "click", target: { testId: "delete-btn" }, expect: { kind: "visible", target: { testId: "confirm" } } } },
    ],
  ]);

  const interp = new RecordingInterpreter();
  const result = await interp.runToCheckpoint(actor as any, rec, 999);

  expect(result).toEqual({ outcome: "completed", vars: {} });
  expect(locator.click).toHaveBeenCalledTimes(1);
});

test("runToCheckpoint with a negative stepIndex throws a clear Error", async () => {
  const locator = fakeLocator();
  const actor = actorWithPage(fakePage(locator));
  const rec = recording([
    [{ step: { kind: "assert", check: { kind: "visible", target: { testId: "loaded" } } } }],
  ]);

  const interp = new RecordingInterpreter();
  await expect(interp.runToCheckpoint(actor as any, rec, -1)).rejects.toThrow(/stepIndex/i);
});
