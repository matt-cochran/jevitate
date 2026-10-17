import { describe, expect, it, vi } from "vitest";
import { AssertionRefError, E_ASSERTION_REF_SECRET, type RecordedStep } from "@jevitate/recording";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runStep } from "./run-step.js";

/**
 * #565 — a step expectation's references resolve from the run's vars (params, earlier `extract`
 * outputs) and the run's `refLookup`; an unresolvable one fails the step BEFORE its action runs.
 */

function fakeLocator() {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    inputValue: vi.fn(async () => "a@example.test"),
    isVisible: vi.fn(async () => true),
    count: vi.fn(async () => 1),
    waitFor: vi.fn(async () => {}),
  };
}

function actorOn(locator: ReturnType<typeof fakeLocator>) {
  const page = {
    url: vi.fn(() => "https://example.test/"),
    getByTestId: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
  };
  return CastActor.named("test").whoCan(new BrowseTheWeb({ page, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as never, []));
}

const clickExpectingInvitee: RecordedStep = {
  step: { kind: "click", target: { testId: "invite" }, expect: { kind: "valueEquals", target: { testId: "email" }, value: { var: "invitee" } } },
};

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof AssertionRefError ? e.code : `other: ${String(e)}`;
  }
}

describe("runStep assertion references", () => {
  it("never acts when the expectation names an unbound reference", async () => {
    const locator = fakeLocator();
    await runStep(actorOn(locator) as never, clickExpectingInvitee, new Map()).catch(() => undefined);
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("refuses a reference the run marks secret", async () => {
    const locator = fakeLocator();
    const refLookup = (name: string) => (name === "invitee" ? { value: "s3cret", secret: true } : undefined);
    expect(await codeOf(runStep(actorOn(locator) as never, clickExpectingInvitee, new Map([["invitee", "s3cret"]]), 0, { refLookup }))).toBe(E_ASSERTION_REF_SECRET);
  });
});
