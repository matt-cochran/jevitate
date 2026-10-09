import { describe, expect, it } from "vitest";
import { buildCandidates, type ElementFacts } from "./descriptor.js";

const facts = (over: Partial<ElementFacts>): ElementFacts => ({
  tag: "div",
  roleAttr: null,
  hasHref: false,
  inputType: null,
  selectIsMulti: false,
  ariaLabel: null,
  text: "",
  alt: null,
  title: null,
  value: null,
  labelText: null,
  testId: null,
  css: null,
  ...over,
});

describe("data-tflow-id is metadata, never a locator (#468)", () => {
  it("an element with only a tflowId yields no locator candidate", () => {
    expect(buildCandidates(facts({ tflowId: "invite.send" }))).toEqual([]);
  });

  it("no candidate is ever built on the tflowId rung", () => {
    const rungs = buildCandidates(facts({ tflowId: "invite.send", testId: "send", text: "Send", css: "button" })).map((c) => c.rung);
    expect(rungs).toEqual(["testId", "text", "css"]);
  });

  it("every candidate for an element that has a tflowId carries it as metadata", () => {
    const all = buildCandidates(facts({ tflowId: "invite.send", testId: "send", css: "button" }));
    expect(all.map((c) => c.descriptor.tflowId)).toEqual(["invite.send", "invite.send"]);
  });

  it("an element without a tflowId produces descriptors without the field", () => {
    expect(buildCandidates(facts({ testId: "send" }))[0]?.descriptor).not.toHaveProperty("tflowId");
  });

  it("an empty tflowId is not recorded", () => {
    expect(buildCandidates(facts({ tflowId: "", testId: "send" }))[0]?.descriptor).not.toHaveProperty("tflowId");
  });

  it("a testId read from data-testid records that attribute", () => {
    expect(buildCandidates(facts({ testId: "send", testIdAttr: "data-testid" }))[0]?.descriptor.testIdAttr).toBe("data-testid");
  });

  it("a testId read from data-test records that attribute", () => {
    expect(buildCandidates(facts({ testId: "send", testIdAttr: "data-test" }))[0]?.descriptor.testIdAttr).toBe("data-test");
  });
});
