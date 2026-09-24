import { expect, test, vi } from "vitest";
import type { Assertion } from "@jevitate/recording";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { checkAssertion } from "./assertion.js";

function fakeLocator(overrides: Partial<Record<string, any>> = {}) {
  return {
    innerText: vi.fn(async () => ""),
    isVisible: vi.fn(async () => true),
    count: vi.fn(async () => 0),
    ...overrides,
  };
}

function fakePage(locator: ReturnType<typeof fakeLocator>, url = "https://example.test/inbox") {
  return {
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

// === backward-compatible defaults (no opts) ===

test("checkAssertion: called without opts still resolves true immediately when the assertion already holds", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => true) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "visible", target: { testId: "banner" } };

  const start = Date.now();
  const result = await checkAssertion(actor as any, a);
  const elapsed = Date.now() - start;

  expect(result).toBe(true);
  // proves it didn't fall through to polling/sleeping when the first sample
  // already holds, even though the default timeout is 5000ms.
  expect(elapsed).toBeLessThan(200);
});

// === RED/GREEN: bounded polling lets an eventually-true assertion pass ===

test("checkAssertion: a visible assertion that becomes true after ~80ms passes within a short timeout (polls, not one-shot)", async () => {
  const start = Date.now();
  const locator = fakeLocator({
    isVisible: vi.fn(async () => Date.now() - start >= 80),
  });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "visible", target: { testId: "banner" } };

  const result = await checkAssertion(actor as any, a, { timeoutMs: 800, pollMs: 20 });

  expect(result).toBe(true);
  // more than one sample was taken, proving it re-evaluated rather than
  // checking once and giving up.
  expect((locator.isVisible as any).mock.calls.length).toBeGreaterThan(1);
});

test("checkAssertion: a textIncludes assertion that becomes true after a delay passes within timeout (same polling wrapper, not visible-only)", async () => {
  const start = Date.now();
  const locator = fakeLocator({
    innerText: vi.fn(async () => (Date.now() - start >= 60 ? "Ready: done" : "Loading...")),
  });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "textIncludes", target: { testId: "status" }, text: "done" };

  const result = await checkAssertion(actor as any, a, { timeoutMs: 800, pollMs: 20 });

  expect(result).toBe(true);
  expect((locator.innerText as any).mock.calls.length).toBeGreaterThan(1);
});

// === RED/GREEN: fails closed once the timeout elapses ===

test("checkAssertion: an assertion that never becomes true fails closed (returns false, not throws) after ~timeoutMs", async () => {
  const locator = fakeLocator({ isVisible: vi.fn(async () => false) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "visible", target: { testId: "banner" } };

  const start = Date.now();
  const result = await checkAssertion(actor as any, a, { timeoutMs: 150, pollMs: 30 });
  const elapsed = Date.now() - start;

  expect(result).toBe(false);
  // must have actually waited out (approximately) the bound, not bailed early
  expect(elapsed).toBeGreaterThanOrEqual(140);
});

test("checkAssertion: a count assertion that never satisfies min fails closed after timeout", async () => {
  const locator = fakeLocator({ count: vi.fn(async () => 0) });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "count", target: { testId: "rows" }, min: 1 };

  const result = await checkAssertion(actor as any, a, { timeoutMs: 120, pollMs: 30 });

  expect(result).toBe(false);
  expect((locator.count as any).mock.calls.length).toBeGreaterThan(1);
});

// === urlIncludes also polls (page.url() is a live read, not cached) ===

test("checkAssertion: a urlIncludes assertion that becomes true after a delay passes within timeout", async () => {
  const start = Date.now();
  let url = "https://example.test/inbox";
  const page = {
    url: vi.fn(() => url),
    getByTestId: vi.fn(),
    getByRole: vi.fn(),
    getByLabel: vi.fn(),
    getByText: vi.fn(),
    locator: vi.fn(),
  };
  setTimeout(() => {
    url = "https://example.test/done";
  }, 60);
  const actor = actorWithPage(page);
  const a: Assertion = { kind: "urlIncludes", text: "/done" };

  const result = await checkAssertion(actor as any, a, { timeoutMs: 800, pollMs: 20 });

  expect(result).toBe(true);
});

// === valueEquals: a form control's VALUE, never its text (#65) ===

test("checkAssertion(valueEquals): holds when the control's value equals the text exactly", async () => {
  const locator = fakeLocator({ count: vi.fn(async () => 1), inputValue: vi.fn(async () => "Litmus") });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "valueEquals", target: { testId: "last" }, value: "Litmus" };
  await expect(checkAssertion(actor, a, { timeoutMs: 50, pollMs: 10 })).resolves.toBe(true);
  expect(locator.inputValue).toHaveBeenCalled();
  expect(locator.innerText).not.toHaveBeenCalled();
});

test("checkAssertion(valueEquals): a different value, or a partial match, does not hold", async () => {
  const locator = fakeLocator({ count: vi.fn(async () => 1), inputValue: vi.fn(async () => "Litmus Test") });
  const actor = actorWithPage(fakePage(locator));
  const a: Assertion = { kind: "valueEquals", target: { testId: "last" }, value: "Litmus" };
  await expect(checkAssertion(actor, a, { timeoutMs: 50, pollMs: 10 })).resolves.toBe(false);
});

test("checkAssertion(valueEquals): a missing, ambiguous or value-less target fails closed", async () => {
  const a: Assertion = { kind: "valueEquals", target: { testId: "last" }, value: "" };
  const missing = actorWithPage(fakePage(fakeLocator({ count: vi.fn(async () => 0), inputValue: vi.fn(async () => "") })));
  await expect(checkAssertion(missing, a, { timeoutMs: 30, pollMs: 10 })).resolves.toBe(false);
  const twice = actorWithPage(fakePage(fakeLocator({ count: vi.fn(async () => 2), inputValue: vi.fn(async () => "") })));
  await expect(checkAssertion(twice, a, { timeoutMs: 30, pollMs: 10 })).resolves.toBe(false);
  const notAControl = actorWithPage(
    fakePage(
      fakeLocator({
        count: vi.fn(async () => 1),
        inputValue: vi.fn(async () => {
          throw new Error("Not an <input>, <textarea> or <select> element");
        }),
      }),
    ),
  );
  await expect(checkAssertion(notAControl, a, { timeoutMs: 30, pollMs: 10 })).resolves.toBe(false);
});
