import { expect, test, vi } from "vitest";
import type { Assertion, RecordedStep } from "@doit/recording";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { checkAssertion, PostconditionFailed } from "./assertion.js";
import { runStep } from "./run-step.js";

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

// === checkAssertion ===

test("checkAssertion: visible → true when locator reports visible", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "visible", target: { testId: "banner" } };
  expect(await checkAssertion(actor as any, a)).toBe(true);
});

test("checkAssertion: visible → false when locator reports not visible", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => false) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "visible", target: { testId: "banner" } };
  expect(await checkAssertion(actor as any, a)).toBe(false);
});

test("checkAssertion: urlIncludes → true when page.url() contains the text", async () => {
  const locator = fakeLocator();
  const actor = actorWithPage(fakePage(locator, "https://example.test/inbox/42"));
  const a: Assertion = { kind: "urlIncludes", text: "/inbox" };
  expect(await checkAssertion(actor as any, a)).toBe(true);
});

test("checkAssertion: urlIncludes → false when page.url() does not contain the text", async () => {
  const locator = fakeLocator();
  const actor = actorWithPage(fakePage(locator, "https://example.test/settings"));
  const a: Assertion = { kind: "urlIncludes", text: "/inbox" };
  expect(await checkAssertion(actor as any, a)).toBe(false);
});

test("checkAssertion: textIncludes → true when innerText contains the text", async () => {
  const locator = fakeLocator({ innerText: vi.fn(async () => "Welcome back, Ada") });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "textIncludes", target: { css: ".greeting" }, text: "Ada" };
  expect(await checkAssertion(actor as any, a)).toBe(true);
});

test("checkAssertion: textIncludes → false when innerText does not contain the text", async () => {
  const locator = fakeLocator({ innerText: vi.fn(async () => "Welcome back, Bob") });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "textIncludes", target: { css: ".greeting" }, text: "Ada" };
  expect(await checkAssertion(actor as any, a)).toBe(false);
});

test("checkAssertion: count → true when within [min,max]", async () => {
  const locator = fakeLocator({ count: vi.fn(async () => 3) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "count", target: { css: "li" }, min: 1, max: 5 };
  expect(await checkAssertion(actor as any, a)).toBe(true);
});

test("checkAssertion: count → false when below min", async () => {
  const locator = fakeLocator({ count: vi.fn(async () => 0) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "count", target: { css: "li" }, min: 1 };
  expect(await checkAssertion(actor as any, a)).toBe(false);
});

test("checkAssertion: count → false when above max", async () => {
  const locator = fakeLocator({ count: vi.fn(async () => 6) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "count", target: { css: "li" }, max: 5 };
  expect(await checkAssertion(actor as any, a)).toBe(false);
});

test("checkAssertion: count → true (vacuous) with no bounds given", async () => {
  const locator = fakeLocator({ count: vi.fn(async () => 42) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "count", target: { css: "li" } };
  expect(await checkAssertion(actor as any, a)).toBe(true);
});

// === runStep ===

test("runStep: click whose expect:visible holds resolves and clicks the target", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "click",
      target: { testId: "submit" },
      expect: { kind: "visible", target: { testId: "confirmation" } },
    },
  };
  await expect(runStep(actor as any, rec, new Map())).resolves.toBeUndefined();
  expect(locator.click).toHaveBeenCalledTimes(1);
});

test("runStep: click whose expect is false rejects with PostconditionFailed", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => false) });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "click",
      target: { testId: "submit" },
      expect: { kind: "visible", target: { testId: "confirmation" } },
    },
  };
  await expect(runStep(actor as any, rec, new Map())).rejects.toBeInstanceOf(PostconditionFailed);
  expect(locator.click).toHaveBeenCalledTimes(1);
});

test("runStep: fill with {var:'body'} types the resolved var value", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "fill",
      target: { label: "Body" },
      value: { var: "body" },
      expect: { kind: "visible", target: { label: "Body" } },
    },
  };
  const vars = new Map([["body", "hello"]]);
  await runStep(actor as any, rec, vars);
  expect(locator.fill).toHaveBeenCalledWith("hello");
});

test("runStep: fill with a redacted constant value rejects with a clear, non-PostconditionFailed error", async () => {
  const locator = fakeLocator();
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "fill",
      target: { label: "Password" },
      value: { redacted: true, length: 5 },
      expect: { kind: "visible", target: { label: "Password" } },
    },
  };
  const err = await runStep(actor as any, rec, new Map()).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(PostconditionFailed);
  expect(err.message).toMatch(/redacted/i);
  expect(locator.fill).not.toHaveBeenCalled();
});

test("runStep: fill with {var:'missing'} rejects with a clear 'unknown variable' error", async () => {
  const locator = fakeLocator();
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "fill",
      target: { label: "Body" },
      value: { var: "missing" },
      expect: { kind: "visible", target: { label: "Body" } },
    },
  };
  const err = await runStep(actor as any, rec, new Map()).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(PostconditionFailed);
  expect(err.message).toMatch(/unknown variable/i);
  expect(err.message).toMatch(/missing/);
  expect(locator.fill).not.toHaveBeenCalled();
});

test("runStep: navigate performs the navigation and checks its expect", async () => {
  const locator = fakeLocator();
  const page = fakePage(locator, "https://example.test/inbox");
  const actor = actorWithPage(page);
  const rec: RecordedStep = {
    step: {
      kind: "navigate",
      url: "/inbox",
      expect: { kind: "urlIncludes", text: "/inbox" },
    },
  };
  await runStep(actor as any, rec, new Map());
  expect(page.goto).toHaveBeenCalledWith("/inbox");
});

test("runStep: navigate whose expect fails rejects with PostconditionFailed", async () => {
  const locator = fakeLocator();
  const page = fakePage(locator, "https://example.test/settings");
  const actor = actorWithPage(page);
  const rec: RecordedStep = {
    step: {
      kind: "navigate",
      url: "/inbox",
      expect: { kind: "urlIncludes", text: "/inbox" },
    },
  };
  await expect(runStep(actor as any, rec, new Map())).rejects.toBeInstanceOf(PostconditionFailed);
});

test("runStep: waitFor calls the resolved locator's waitFor with the given state", async () => {
  const locator = fakeLocator();
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "waitFor",
      target: { testId: "spinner" },
      state: "hidden",
    },
  };
  await runStep(actor as any, rec, new Map());
  expect(locator.waitFor).toHaveBeenCalledWith({ state: "hidden" });
});

test("runStep: waitFor propagates the locator's own waitFor rejection (fail-closed via Playwright)", async () => {
  const locator = fakeLocator({ waitFor: vi.fn(async () => { throw new Error("timeout"); }) });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "waitFor",
      target: { testId: "spinner" },
      state: "visible",
    },
  };
  await expect(runStep(actor as any, rec, new Map())).rejects.toThrow(/timeout/);
});

test("runStep: assert checks step.check and resolves when true", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "assert",
      check: { kind: "visible", target: { testId: "banner" } },
    },
  };
  await expect(runStep(actor as any, rec, new Map())).resolves.toBeUndefined();
});

test("runStep: assert rejects with PostconditionFailed when check is false", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => false) });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "assert",
      check: { kind: "visible", target: { testId: "banner" } },
    },
  };
  await expect(runStep(actor as any, rec, new Map())).rejects.toBeInstanceOf(PostconditionFailed);
});

test("runStep: out-of-scope kinds (extract/forEach/handback) throw a not-yet-supported error", async () => {
  const locator = fakeLocator();
  const actor = actorWithPage(fakePage(locator));
  const recExtract: RecordedStep = {
    step: { kind: "extract", target: { testId: "x" }, as: "y", expect: { kind: "visible", target: { testId: "x" } } },
  };
  const recForEach: RecordedStep = {
    step: { kind: "forEach", items: { testId: "x" }, as: "y", steps: [] },
  };
  const recHandback: RecordedStep = {
    step: { kind: "handback", prompt: "help", resume: { kind: "urlIncludes", text: "/done" } },
  };
  await expect(runStep(actor as any, recExtract, new Map())).rejects.toThrow(/not yet supported/i);
  await expect(runStep(actor as any, recForEach, new Map())).rejects.toThrow(/not yet supported/i);
  await expect(runStep(actor as any, recHandback, new Map())).rejects.toThrow(/not yet supported/i);
});
