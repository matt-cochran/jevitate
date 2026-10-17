import { describe, expect, it } from "vitest";
import {
  AssertionRefError,
  E_ASSERTION_REF_SECRET,
  E_ASSERTION_REF_TYPE,
  E_ASSERTION_REF_UNBOUND,
  assertionRefs,
  resolveAssertionRefs,
  type AssertionRefLookup,
} from "./assertion-refs.js";
import { AssertionSchema, type Assertion } from "./schema.js";

/**
 * #562/#565 — an assertion's expected text/value may refer to a run binding (`${name}` in a literal,
 * or `{ var: name }`), resolved before the check; an unbound, secret or non-string one fails closed.
 */

const target = { testId: "email" };
const SECRET_VALUE = "hunter2-very-secret";

const lookup: AssertionRefLookup = (name) => {
  if (name === "email") return { value: "a@example.test", secret: false };
  if (name === "password") return { value: SECRET_VALUE, secret: true };
  if (name === "count") return { value: 3, secret: false };
  return undefined;
};

function errorOf(fn: () => unknown): AssertionRefError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AssertionRefError) return e;
    throw e;
  }
  throw new Error("expected an AssertionRefError");
}

describe("resolveAssertionRefs", () => {
  it("resolves a { var } operand to the bound value", () => {
    const a: Assertion = { kind: "valueEquals", target, value: { var: "email" } };
    expect(resolveAssertionRefs(a, lookup)).toEqual({ kind: "valueEquals", target, value: "a@example.test" });
  });

  it("expands a ${name} placeholder inside literal text", () => {
    const a: Assertion = { kind: "textIncludes", target, text: "Invited ${email}!" };
    expect(resolveAssertionRefs(a, lookup)).toEqual({ kind: "textIncludes", target, text: "Invited a@example.test!" });
  });

  it("resolves an attr value reference", () => {
    const a: Assertion = { kind: "attr", target, name: "data-owner", value: { var: "email" } };
    expect(resolveAssertionRefs(a, lookup)).toEqual({ kind: "attr", target, name: "data-owner", value: "a@example.test" });
  });

  it("expands a ${name} placeholder in a urlIncludes text percent-encoded like a navigate URL", () => {
    const a: Assertion = { kind: "urlIncludes", text: "/people/${email}" };
    expect(resolveAssertionRefs(a, lookup)).toEqual({ kind: "urlIncludes", text: "/people/a%40example.test" });
  });

  it("refuses a secret reference in a urlIncludes text with E_ASSERTION_REF_SECRET", () => {
    const a: Assertion = { kind: "urlIncludes", text: "/reset/${password}" };
    expect(errorOf(() => resolveAssertionRefs(a, lookup)).code).toBe(E_ASSERTION_REF_SECRET);
  });

  it("leaves an assertion without references untouched", () => {
    const a: Assertion = { kind: "textIncludes", target, text: "Saved" };
    expect(resolveAssertionRefs(a, lookup)).toBe(a);
  });

  it("refuses an unbound reference with E_ASSERTION_REF_UNBOUND", () => {
    const a: Assertion = { kind: "valueEquals", target, value: { var: "invitee" } };
    expect(errorOf(() => resolveAssertionRefs(a, lookup)).code).toBe(E_ASSERTION_REF_UNBOUND);
  });

  it("refuses a secret reference with E_ASSERTION_REF_SECRET", () => {
    const a: Assertion = { kind: "textIncludes", target, text: "${password}" };
    expect(errorOf(() => resolveAssertionRefs(a, lookup)).code).toBe(E_ASSERTION_REF_SECRET);
  });

  it("refuses a non-string binding with E_ASSERTION_REF_TYPE", () => {
    const a: Assertion = { kind: "valueEquals", target, value: { var: "count" } };
    expect(errorOf(() => resolveAssertionRefs(a, lookup)).code).toBe(E_ASSERTION_REF_TYPE);
  });

  it("never puts a secret value in the refusal message", () => {
    const a: Assertion = { kind: "valueEquals", target, value: { var: "password" } };
    expect(errorOf(() => resolveAssertionRefs(a, lookup)).message).not.toContain(SECRET_VALUE);
  });
});

describe("assertionRefs", () => {
  it("lists each referenced name once, in order", () => {
    const a: Assertion = { kind: "textIncludes", target, text: "${first} and ${second} and ${first}" };
    expect(assertionRefs(a)).toEqual(["first", "second"]);
  });
});

describe("AssertionSchema operands", () => {
  it("accepts a { var } operand on valueEquals", () => {
    expect(AssertionSchema.safeParse({ kind: "valueEquals", target, value: { var: "email" } }).success).toBe(true);
  });

  it("rejects an operand object that is not { var }", () => {
    expect(AssertionSchema.safeParse({ kind: "textIncludes", target, text: { redacted: false, value: "x" } }).success).toBe(false);
  });
});
