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
  await expect(runStep(actor as any, rec, new Map())).resolves.toEqual({ kind: "done" });
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
  await expect(runStep(actor as any, rec, vars)).resolves.toEqual({ kind: "done" });
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
  await expect(runStep(actor as any, rec, new Map())).resolves.toEqual({ kind: "done" });
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

// === runStep: handback (awaiting_human) ===

test("runStep: handback returns awaiting_human with its prompt/resume and attempts no action", async () => {
  const locator = fakeLocator();
  const page = fakePage(locator);
  const actor = actorWithPage(page);
  const resume: Assertion = { kind: "visible", target: { testId: "done-banner" } };
  const rec: RecordedStep = {
    step: { kind: "handback", prompt: "some prompt", resume },
  };
  await expect(runStep(actor as any, rec, new Map())).resolves.toEqual({
    kind: "awaiting_human",
    prompt: "some prompt",
    resume,
    index: 0,
  });

  // No action whatsoever is attempted past a handback: neither the page nor
  // the locator it would resolve to is touched.
  expect(page.goto).not.toHaveBeenCalled();
  expect(page.getByTestId).not.toHaveBeenCalled();
  expect(page.getByRole).not.toHaveBeenCalled();
  expect(page.getByLabel).not.toHaveBeenCalled();
  expect(page.getByText).not.toHaveBeenCalled();
  expect(page.locator).not.toHaveBeenCalled();
  expect(locator.click).not.toHaveBeenCalled();
  expect(locator.fill).not.toHaveBeenCalled();
  expect(locator.innerText).not.toHaveBeenCalled();
  expect(locator.isVisible).not.toHaveBeenCalled();
  expect(locator.waitFor).not.toHaveBeenCalled();
});

test("runStep: handback echoes the explicit 4th index argument into the outcome", async () => {
  const locator = fakeLocator();
  const actor = actorWithPage(fakePage(locator));
  const resume: Assertion = { kind: "urlIncludes", text: "/done" };
  const rec: RecordedStep = {
    step: { kind: "handback", prompt: "help", resume },
  };
  const outcome = await runStep(actor as any, rec, new Map(), 5);
  expect(outcome).toEqual({ kind: "awaiting_human", prompt: "help", resume, index: 5 });
});

// === runStep: extract (top-level) ===

test("runStep: extract stores innerText into vars and checks expect", async () => {
  const locator = fakeLocator({
    innerText: vi.fn(async () => "hello"),
    isVisible: vi.fn(async () => true),
  });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "extract",
      target: { testId: "greeting-el" },
      as: "greeting",
      expect: { kind: "visible", target: { testId: "greeting-el" } },
    },
  };
  const vars = new Map<string, string>();
  await expect(runStep(actor as any, rec, vars)).resolves.toEqual({ kind: "done" });
  expect(vars.get("greeting")).toBe("hello");
});

test("runStep: extract with attr uses getAttribute instead of innerText", async () => {
  const locator = fakeLocator({
    getAttribute: vi.fn(async () => "https://example.test/target"),
    innerText: vi.fn(async () => "should not be used"),
    isVisible: vi.fn(async () => true),
  });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "extract",
      target: { testId: "link" },
      as: "href",
      attr: "href",
      expect: { kind: "visible", target: { testId: "link" } },
    },
  };
  const vars = new Map<string, string>();
  await runStep(actor as any, rec, vars);
  expect(vars.get("href")).toBe("https://example.test/target");
  expect(locator.getAttribute).toHaveBeenCalledWith("href");
  expect(locator.innerText).not.toHaveBeenCalled();
});

test("runStep: extract rejects with a clear error when getAttribute resolves null", async () => {
  const locator = fakeLocator({
    getAttribute: vi.fn(async () => null),
  });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "extract",
      target: { testId: "link" },
      as: "href",
      attr: "href",
      expect: { kind: "visible", target: { testId: "link" } },
    },
  };
  const vars = new Map<string, string>();
  const err = await runStep(actor as any, rec, vars).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(PostconditionFailed);
  expect(err.message).toMatch(/href/);
  expect(vars.has("href")).toBe(false);
});

test("runStep: extract whose expect is false rejects with PostconditionFailed", async () => {
  const locator = fakeLocator({
    innerText: vi.fn(async () => "hello"),
    isVisible: vi.fn(async () => false),
  });
  const actor = actorWithPage(fakePage(locator));
  const rec: RecordedStep = {
    step: {
      kind: "extract",
      target: { testId: "greeting-el" },
      as: "greeting",
      expect: { kind: "visible", target: { testId: "greeting-el" } },
    },
  };
  const vars = new Map<string, string>();
  await expect(runStep(actor as any, rec, vars)).rejects.toBeInstanceOf(PostconditionFailed);
  // The value is still stored before the postcondition check runs.
  expect(vars.get("greeting")).toBe("hello");
});

// === runStep: forEach (row-scoped) ===

function fakeRowRoot(leaf: ReturnType<typeof fakeLocator>) {
  return {
    getByTestId: vi.fn(() => leaf),
    getByRole: vi.fn(() => leaf),
    getByLabel: vi.fn(() => leaf),
    getByText: vi.fn(() => leaf),
    locator: vi.fn(() => leaf),
  };
}

function fakeItemsLocator(rows: any[]) {
  return {
    count: vi.fn(async () => rows.length),
    nth: vi.fn((i: number) => rows[i]),
  };
}

function fakePageReturning(itemsLocator: any, url = "https://example.test/list") {
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => url),
    getByTestId: vi.fn(() => itemsLocator),
    getByRole: vi.fn(() => itemsLocator),
    getByLabel: vi.fn(() => itemsLocator),
    getByText: vi.fn(() => itemsLocator),
    locator: vi.fn(() => itemsLocator),
  };
}

test("runStep: forEach runs a child extract per row, scoped to each row's own locator (last-row-wins)", async () => {
  const order: string[] = [];
  const leaf0 = fakeLocator({
    innerText: vi.fn(async () => {
      order.push("Alice");
      return "Alice";
    }),
    isVisible: vi.fn(async () => true),
  });
  const leaf1 = fakeLocator({
    innerText: vi.fn(async () => {
      order.push("Bob");
      return "Bob";
    }),
    isVisible: vi.fn(async () => true),
  });
  const row0 = fakeRowRoot(leaf0);
  const row1 = fakeRowRoot(leaf1);
  const itemsLocator = fakeItemsLocator([row0, row1]);
  const page = fakePageReturning(itemsLocator);
  const actor = actorWithPage(page);

  const rec: RecordedStep = {
    step: {
      kind: "forEach",
      items: { testId: "rows" },
      as: "row",
      steps: [
        {
          kind: "extract",
          target: { role: "cell", name: "name" },
          as: "name",
          expect: { kind: "visible", target: { role: "cell", name: "name" } },
        },
      ],
    },
  };
  const vars = new Map<string, string>();
  await expect(runStep(actor as any, rec, vars)).resolves.toEqual({ kind: "done" });

  expect(itemsLocator.count).toHaveBeenCalledTimes(1);
  expect(itemsLocator.nth).toHaveBeenNthCalledWith(1, 0);
  expect(itemsLocator.nth).toHaveBeenNthCalledWith(2, 1);

  // Proves row-scoped resolution: each row's OWN getByRole was used, not the page's.
  expect(row0.getByRole).toHaveBeenCalledWith("cell", { name: "name" });
  expect(row1.getByRole).toHaveBeenCalledWith("cell", { name: "name" });
  expect(page.getByRole).not.toHaveBeenCalled();

  // Proves per-row distinctness in order, not just "ran twice and kept the last by luck".
  expect(order).toEqual(["Alice", "Bob"]);

  // Last-row-wins, per the design ruling.
  expect(vars.get("name")).toBe("Bob");
});

test("runStep: forEach runs a child click per row, scoped to each row's own locator", async () => {
  const leaf0 = fakeLocator({ isVisible: vi.fn(async () => true) });
  const leaf1 = fakeLocator({ isVisible: vi.fn(async () => true) });
  const row0 = fakeRowRoot(leaf0);
  const row1 = fakeRowRoot(leaf1);
  const itemsLocator = fakeItemsLocator([row0, row1]);
  const page = fakePageReturning(itemsLocator);
  const actor = actorWithPage(page);

  const rec: RecordedStep = {
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
  };
  await expect(runStep(actor as any, rec, new Map())).resolves.toEqual({ kind: "done" });

  expect(leaf0.click).toHaveBeenCalledTimes(1);
  expect(leaf1.click).toHaveBeenCalledTimes(1);
});

test("runStep: forEach rejects with PostconditionFailed when a child click's row-scoped expect is false", async () => {
  const leaf0 = fakeLocator({ isVisible: vi.fn(async () => false) });
  const row0 = fakeRowRoot(leaf0);
  const itemsLocator = fakeItemsLocator([row0]);
  const page = fakePageReturning(itemsLocator);
  const actor = actorWithPage(page);

  const rec: RecordedStep = {
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
  };
  await expect(runStep(actor as any, rec, new Map())).rejects.toBeInstanceOf(PostconditionFailed);
  expect(leaf0.click).toHaveBeenCalledTimes(1);
});

test("runStep: forEach throws for an unsupported child step kind", async () => {
  const leaf0 = fakeLocator();
  const row0 = fakeRowRoot(leaf0);
  const itemsLocator = fakeItemsLocator([row0]);
  const page = fakePageReturning(itemsLocator);
  const actor = actorWithPage(page);

  const rec: RecordedStep = {
    step: {
      kind: "forEach",
      items: { testId: "rows" },
      as: "row",
      steps: [{ kind: "navigate", url: "/x", expect: { kind: "urlIncludes", text: "/x" } }],
    },
  };
  await expect(runStep(actor as any, rec, new Map())).rejects.toThrow(/not supported in A\.1/);
});

test("runStep: forEach over 0 matched rows rejects with PostconditionFailed (fails closed instead of no-op completed)", async () => {
  const itemsLocator = fakeItemsLocator([]);
  const page = fakePageReturning(itemsLocator);
  const actor = actorWithPage(page);

  const rec: RecordedStep = {
    step: {
      kind: "forEach",
      items: { testId: "rows" },
      as: "row",
      steps: [
        {
          kind: "extract",
          target: { testId: "cell" },
          as: "cell",
          expect: { kind: "visible", target: { testId: "cell" } },
        },
      ],
    },
  };
  await expect(runStep(actor as any, rec, new Map())).rejects.toBeInstanceOf(PostconditionFailed);
  expect(itemsLocator.count).toHaveBeenCalledTimes(1);
  expect(itemsLocator.nth).not.toHaveBeenCalled();
});

// === resolveInRoot (via forEach child steps): frameUrl guard ===

test("runStep: forEach child target with frameUrl set throws even when testId is also set (unconditional, not a fallback)", async () => {
  const leaf0 = fakeLocator();
  const row0 = fakeRowRoot(leaf0);
  const itemsLocator = fakeItemsLocator([row0]);
  const page = fakePageReturning(itemsLocator);
  const actor = actorWithPage(page);

  const rec: RecordedStep = {
    step: {
      kind: "forEach",
      items: { testId: "rows" },
      as: "row",
      steps: [
        {
          kind: "click",
          target: { testId: "delete-btn", frameUrl: "https://example.test/iframe" },
          expect: { kind: "visible", target: { testId: "delete-btn" } },
        },
      ],
    },
  };
  await expect(runStep(actor as any, rec, new Map())).rejects.toThrow(/frameUrl is not supported in A\.1/);
  expect(row0.getByTestId).not.toHaveBeenCalled();
});

test("runStep: forEach sets ${as}.__index for each row, ending at the last index", async () => {
  const leaf0 = fakeLocator();
  const leaf1 = fakeLocator();
  const row0 = fakeRowRoot(leaf0);
  const row1 = fakeRowRoot(leaf1);
  const itemsLocator = fakeItemsLocator([row0, row1]);
  const page = fakePageReturning(itemsLocator);
  const actor = actorWithPage(page);

  const rec: RecordedStep = {
    step: {
      kind: "forEach",
      items: { testId: "rows" },
      as: "row",
      steps: [
        {
          kind: "extract",
          target: { testId: "cell" },
          as: "cell",
          expect: { kind: "visible", target: { testId: "cell" } },
        },
      ],
    },
  };
  const vars = new Map<string, string>();
  const seenIndexes: string[] = [];
  const originalSet = vars.set.bind(vars);
  vi.spyOn(vars, "set").mockImplementation((key: string, value: string) => {
    if (key === "row.__index") seenIndexes.push(value);
    return originalSet(key, value);
  });

  await runStep(actor as any, rec, vars);

  expect(seenIndexes).toEqual(["0", "1"]);
  expect(vars.get("row.__index")).toBe("1");
});
