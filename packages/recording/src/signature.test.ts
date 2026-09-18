import { describe, it, expect } from "vitest";
import type { Step } from "./schema.js";
import { urlTemplate, stepSignature } from "./signature.js";

describe("urlTemplate", () => {
  it("normalizes all-digit path segments to :id", () => {
    expect(urlTemplate("/thread/1")).toBe("/thread/:id");
    expect(urlTemplate("/thread/2")).toBe("/thread/:id");
    expect(urlTemplate("/thread/1")).toBe(urlTemplate("/thread/2"));
  });

  it("normalizes UUID path segments to :id", () => {
    expect(urlTemplate("/users/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "/users/:id",
    );
  });

  it("leaves fixed route words alone", () => {
    expect(urlTemplate("/inbox")).toBe("/inbox");
    expect(urlTemplate("/login")).toBe("/login");
  });
});

describe("stepSignature", () => {
  it("gives two fill steps on the same field the same signature regardless of value", () => {
    const stepA: Step = {
      kind: "fill",
      target: { role: "textbox", label: "Name" },
      value: { redacted: false, value: "jane" },
      expect: { kind: "visible", target: { role: "textbox", label: "Name" } },
    };
    const stepB: Step = {
      kind: "fill",
      target: { role: "textbox", label: "Name" },
      value: { redacted: false, value: "bob" },
      expect: { kind: "visible", target: { role: "textbox", label: "Name" } },
    };

    expect(stepSignature(stepA, "/signup")).toBe(stepSignature(stepB, "/signup"));
  });

  it("gives two fill steps the same signature when one is redacted and the other is not", () => {
    const stepA: Step = {
      kind: "fill",
      target: { testId: "password-input" },
      value: { redacted: true, length: 8 },
      expect: { kind: "visible", target: { testId: "submit-btn" } },
    };
    const stepB: Step = {
      kind: "fill",
      target: { testId: "password-input" },
      value: { redacted: false, value: "hunter2" },
      expect: { kind: "visible", target: { testId: "submit-btn" } },
    };

    expect(stepSignature(stepA, "/login")).toBe(stepSignature(stepB, "/login"));
  });

  it("gives a click on /thread/1 and /thread/2 the same signature via urlTemplate", () => {
    const step: Step = {
      kind: "click",
      target: { testId: "reply-button" },
      expect: { kind: "visible", target: { testId: "reply-form" } },
    };

    expect(stepSignature(step, "/thread/1")).toBe(stepSignature(step, "/thread/2"));
  });

  it("gives a click on a button a different signature than a click on a link with the same name", () => {
    const buttonClick: Step = {
      kind: "click",
      target: { role: "button", name: "Sign in" },
      expect: { kind: "visible", target: { role: "button", name: "Sign in" } },
    };
    const linkClick: Step = {
      kind: "click",
      target: { role: "link", name: "Sign in" },
      expect: { kind: "visible", target: { role: "link", name: "Sign in" } },
    };

    expect(stepSignature(buttonClick, "/home")).not.toBe(
      stepSignature(linkClick, "/home"),
    );
  });

  it("gives two clicks with the same role but different name the same signature (name never leaks)", () => {
    const clickA: Step = {
      kind: "click",
      target: { role: "button", name: "Sign in" },
      expect: { kind: "visible", target: { role: "button" } },
    };
    const clickB: Step = {
      kind: "click",
      target: { role: "button", name: "Cancel" },
      expect: { kind: "visible", target: { role: "button" } },
    };

    expect(stepSignature(clickA, "/home")).toBe(stepSignature(clickB, "/home"));
  });

  it("gives two clicks with the same role but different text the same signature (text never leaks)", () => {
    const clickA: Step = {
      kind: "click",
      target: { role: "button", text: "Submit now" },
      expect: { kind: "visible", target: { role: "button" } },
    };
    const clickB: Step = {
      kind: "click",
      target: { role: "button", text: "Go" },
      expect: { kind: "visible", target: { role: "button" } },
    };

    expect(stepSignature(clickA, "/home")).toBe(stepSignature(clickB, "/home"));
  });

  it("distinguishes navigate steps by url template, not the literal value", () => {
    const navA: Step = {
      kind: "navigate",
      url: "/thread/1",
      expect: { kind: "urlIncludes", text: "/thread/1" },
    };
    const navB: Step = {
      kind: "navigate",
      url: "/thread/2",
      expect: { kind: "urlIncludes", text: "/thread/2" },
    };
    const navC: Step = {
      kind: "navigate",
      url: "/inbox",
      expect: { kind: "urlIncludes", text: "/inbox" },
    };

    expect(stepSignature(navA, "/start")).toBe(stepSignature(navB, "/start"));
    expect(stepSignature(navA, "/start")).not.toBe(stepSignature(navC, "/start"));
  });

  it("uses press.key as structural identity (different keys differ, same key matches)", () => {
    const enterA: Step = {
      kind: "press",
      key: "Enter",
      expect: { kind: "visible", target: { testId: "result" } },
    };
    const enterB: Step = {
      kind: "press",
      key: "Enter",
      expect: { kind: "visible", target: { testId: "other-result" } },
    };
    const escape: Step = {
      kind: "press",
      key: "Escape",
      expect: { kind: "visible", target: { testId: "result" } },
    };

    expect(stepSignature(enterA, "/page")).toBe(stepSignature(enterB, "/page"));
    expect(stepSignature(enterA, "/page")).not.toBe(stepSignature(escape, "/page"));
  });

  it("distinguishes different kinds on the same descriptor and page", () => {
    const click: Step = {
      kind: "click",
      target: { testId: "thing" },
      expect: { kind: "visible", target: { testId: "thing" } },
    };
    const waitFor: Step = {
      kind: "waitFor",
      target: { testId: "thing" },
      state: "visible",
    };

    expect(stepSignature(click, "/page")).not.toBe(stepSignature(waitFor, "/page"));
  });

  it("gives two select steps on the same target the same signature regardless of value", () => {
    const selectA: Step = {
      kind: "select",
      target: { testId: "country-select" },
      value: { redacted: false, value: "US" },
      expect: { kind: "visible", target: { testId: "country-select" } },
    };
    const selectB: Step = {
      kind: "select",
      target: { testId: "country-select" },
      value: { redacted: false, value: "CA" },
      expect: { kind: "visible", target: { testId: "country-select" } },
    };

    expect(stepSignature(selectA, "/settings")).toBe(stepSignature(selectB, "/settings"));
  });

  it("gives two extract steps on the same target the same signature regardless of `as`", () => {
    const extractA: Step = {
      kind: "extract",
      target: { testId: "thread-title" },
      as: "titleA",
      expect: { kind: "visible", target: { testId: "thread-title" } },
    };
    const extractB: Step = {
      kind: "extract",
      target: { testId: "thread-title" },
      as: "titleB",
      expect: { kind: "visible", target: { testId: "thread-title" } },
    };

    expect(stepSignature(extractA, "/thread/1")).toBe(stepSignature(extractB, "/thread/1"));
  });

  it("distinguishes extract steps by attr (structural), unlike `as` (captured)", () => {
    const extractHref: Step = {
      kind: "extract",
      target: { testId: "thread-link" },
      as: "link",
      attr: "href",
      expect: { kind: "visible", target: { testId: "thread-link" } },
    };
    const extractText: Step = {
      kind: "extract",
      target: { testId: "thread-link" },
      as: "link",
      attr: "textContent",
      expect: { kind: "visible", target: { testId: "thread-link" } },
    };

    expect(stepSignature(extractHref, "/thread/1")).not.toBe(
      stepSignature(extractText, "/thread/1"),
    );
  });

  it("distinguishes waitFor steps by state (structural)", () => {
    const waitVisible: Step = {
      kind: "waitFor",
      target: { testId: "spinner" },
      state: "visible",
    };
    const waitHidden: Step = {
      kind: "waitFor",
      target: { testId: "spinner" },
      state: "hidden",
    };

    expect(stepSignature(waitVisible, "/page")).not.toBe(stepSignature(waitHidden, "/page"));
  });

  it("gives two forEach steps with the same items descriptor the same signature regardless of `as`", () => {
    const forEachA: Step = {
      kind: "forEach",
      items: { testId: "thread-row" },
      as: "rowA",
      steps: [],
    };
    const forEachB: Step = {
      kind: "forEach",
      items: { testId: "thread-row" },
      as: "rowB",
      steps: [],
    };

    expect(stepSignature(forEachA, "/inbox")).toBe(stepSignature(forEachB, "/inbox"));
  });

  it("gives two assert steps with the same target the same signature regardless of textIncludes.text", () => {
    const assertA: Step = {
      kind: "assert",
      check: {
        kind: "textIncludes",
        target: { testId: "status-banner" },
        text: "Saved",
      },
    };
    const assertB: Step = {
      kind: "assert",
      check: {
        kind: "textIncludes",
        target: { testId: "status-banner" },
        text: "Published",
      },
    };

    expect(stepSignature(assertA, "/editor")).toBe(stepSignature(assertB, "/editor"));
  });

  it("gives two handback steps with the same resume assertion the same signature regardless of prompt", () => {
    const handbackA: Step = {
      kind: "handback",
      prompt: "Please solve the captcha",
      resume: { kind: "visible", target: { testId: "continue-button" } },
    };
    const handbackB: Step = {
      kind: "handback",
      prompt: "Please verify your identity",
      resume: { kind: "visible", target: { testId: "continue-button" } },
    };

    expect(stepSignature(handbackA, "/checkout")).toBe(stepSignature(handbackB, "/checkout"));
  });
});
