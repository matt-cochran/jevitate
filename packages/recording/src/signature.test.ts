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
});
