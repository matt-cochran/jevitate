import { describe, it, expect } from "vitest";
import { deriveParamSchema, journeyParamSchema, journeyRunParams, validateParams, ParamValidationError } from "./index.js";

const recWithVar = {
  version: "1", site: "example",
  pages: [{ url: "/login", steps: [
    { step: { kind: "fill", target: { css: "#u" }, value: { var: "username" }, expect: { kind: "urlIncludes", text: "/login" } }, variableName: "username" },
  ] }],
};

describe("param-schema", () => {
  it("derives required params from bound variables", () => {
    expect(deriveParamSchema(recWithVar as any)).toEqual({ required: ["username"] });
  });
  it("throws ParamValidationError on a missing param", () => {
    expect(() => validateParams({ required: ["username"] }, {})).toThrow(ParamValidationError);
  });
  it("throws ParamValidationError on an unknown param (no silent ignore)", () => {
    expect(() => validateParams({ required: ["username"] }, { username: "a", bogus: "b" })).toThrow(ParamValidationError);
  });
  it("accepts an exact param set", () => {
    expect(() => validateParams({ required: ["username"] }, { username: "a" })).not.toThrow();
  });
});

// #573: a declared parameter only an assertion names is expected context, not an action input.
const replyJourney = (params: string[], extra: Record<string, unknown> = {}) => ({
  metadata: { id: "reply", name: "reply", promoted: false, params, createdAtIso: "2026-01-01T00:00:00Z", ...extra },
  recording: {
    version: "1", site: "example",
    pages: [{ url: "/t", steps: [
      { step: { kind: "assert", check: { kind: "attr", target: { css: "#c" }, name: "data-id", value: { var: "expected_commentid" } } } },
      { step: { kind: "extract", target: { css: "#n" }, as: "seen", expect: { kind: "textIncludes", text: "${seen}" } } },
      { step: { kind: "fill", target: { css: "#r" }, value: { var: "replyIdentity" }, expect: { kind: "textIncludes", text: "${expected_sourcetext}" } }, variableName: "replyIdentity" },
    ] }],
  },
});

describe("journeyParamSchema (#573)", () => {
  it("adds declared params that only assertions name, after the Recording's own", () => {
    const j = replyJourney(["replyIdentity", "expected_commentid", "expected_sourcetext"]);
    expect(journeyParamSchema(j as any)).toEqual({ required: ["replyIdentity", "expected_commentid", "expected_sourcetext"] });
    expect(() => validateParams(journeyParamSchema(j as any), { replyIdentity: "a", expected_commentid: "c1", expected_sourcetext: "hi" })).not.toThrow();
  });
  it("requires a missing assertion-only param and still refuses a truly unknown one", () => {
    const schema = journeyParamSchema(replyJourney(["replyIdentity", "expected_commentid", "expected_sourcetext"]) as any);
    expect(() => validateParams(schema, { replyIdentity: "a", expected_sourcetext: "hi" })).toThrow(/missing: \[expected_commentid\]/);
    expect(() => validateParams(schema, { replyIdentity: "a", expected_commentid: "c", expected_sourcetext: "hi", bogus: "x" })).toThrow(/unknown: \[bogus\]/);
  });
  it("reads declarations from metadata.parameters and end-state checks; an extract output is no param", () => {
    const j = replyJourney(["replyIdentity"], {
      parameters: [{ name: "expected_commentid" }, { name: "expected_sourcetext" }, { name: "seen" }, { name: "unused" }],
      endState: [{ kind: "page", assertion: { kind: "urlIncludes", text: "${unused}" } }],
    });
    expect(journeyParamSchema(j as any).required).toEqual(["replyIdentity", "expected_commentid", "expected_sourcetext", "unused"]);
  });
  it("leaves an undeclared assertion name out (the schema refuses it at load)", () => {
    expect(journeyParamSchema(replyJourney(["replyIdentity"]) as any).required).toEqual(["replyIdentity"]);
  });
  it("journeyRunParams lists them", () => {
    expect(journeyRunParams(replyJourney(["replyIdentity", "expected_commentid", "expected_sourcetext"]) as any)).toEqual(["replyIdentity", "expected_commentid", "expected_sourcetext"]);
  });
});

// #580: a declared parameter an action reads through `{ var }` is required even without a variableName tag.
describe("journeyParamSchema action reads (#580)", () => {
  it("requires a declared param a select reads without a variableName", () => {
    const j = {
      metadata: { id: "s", name: "s", promoted: false, params: ["who"], createdAtIso: "2026-01-01T00:00:00Z" },
      recording: { version: "1", site: "example", pages: [{ url: "/", steps: [
        { step: { kind: "select", target: { css: "#w" }, value: { var: "who" }, expect: { kind: "visible", target: { css: "#w" } } } },
      ] }] },
    };
    expect(journeyParamSchema(j as any).required).toEqual(["who"]);
  });
});
