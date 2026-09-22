import { describe, it, expect } from "vitest";
import { deriveParamSchema, validateParams, ParamValidationError } from "./index.js";

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
