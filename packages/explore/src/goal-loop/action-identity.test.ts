import { describe, expect, it } from "vitest";
import type { Control } from "../snapshot.js";
import { actionIdentityOf } from "./helpers.js";

const control = (over: Partial<Control>): Control =>
  ({ index: 0, descriptor: { role: "button", name: "Continue" }, stability: "medium", role: "button", name: "Continue", tag: "button", inputType: null, enabled: true, summary: "button Continue", ...over }) as Control;

describe("actionIdentityOf (#356)", () => {
  it("the same element on the same screen has one identity", () => {
    expect(actionIdentityOf(control({ heading: "Step 1" }))).toEqual(actionIdentityOf(control({ heading: "Step 1" })));
  });

  it("a same-labelled control under another heading, form or dialog is another action", () => {
    const a = actionIdentityOf(control({ heading: "Check your nameservers" }));
    const b = actionIdentityOf(control({ heading: "Still waiting for nameservers" }));
    expect(a.element).toBe(b.element);
    expect(a.context).not.toBe(b.context);
    expect(actionIdentityOf(control({ form: "form#a" })).context).not.toBe(actionIdentityOf(control({ form: "form#b" })).context);
    expect(actionIdentityOf(control({ scope: 'dialog "Confirm"' })).context).not.toBe(actionIdentityOf(control({})).context);
  });

  it("a stable locator (a test id) tells same-labelled controls apart as elements", () => {
    const a = actionIdentityOf(control({ descriptor: { testId: "refresh-share" } }));
    const b = actionIdentityOf(control({ descriptor: { testId: "retry-share" } }));
    expect(a.element).not.toBe(b.element);
  });
});
