import { describe, expect, it } from "vitest";
import { describeCheck } from "@jevitate/explore";
import { parseSuccessSpec } from "./explore-specs.js";
import { selectJsonPath } from "./mission-fixtures.js";

const URL = "http://localhost:8025/api/v1/search?query=to:${email}";

describe("--success http: grammar (#543)", () => {
  it("parses a status assertion", () => {
    expect(parseSuccessSpec(`http:GET ${URL}|status=200`)).toMatchObject({ kind: "http", status: { code: 200 } });
  });

  it("parses jsonPath with equals", () => {
    expect(parseSuccessSpec(`http:GET ${URL}|jsonPath=$.total|equals=1`)).toMatchObject({ json: [{ path: "$.total", op: "equals", value: "1" }] });
  });

  it("parses jsonPath with includes", () => {
    expect(parseSuccessSpec(`http:GET ${URL}|jsonPath=$.messages[*].Subject|includes=Reset your password`)).toMatchObject({
      json: [{ path: "$.messages[*].Subject", op: "includes", value: "Reset your password" }],
    });
  });

  it("parses jsonPath with exists", () => {
    expect(parseSuccessSpec(`http:GET ${URL}|jsonPath=$.messages[0]|exists`)).toMatchObject({ json: [{ path: "$.messages[0]", op: "exists" }] });
  });

  it("parses textIncludes", () => {
    expect(parseSuccessSpec(`http:GET ${URL}|textIncludes=Reset`)).toMatchObject({ textIncludes: ["Reset"] });
  });

  it("parses within as the poll window", () => {
    expect(parseSuccessSpec(`http:GET ${URL}|textIncludes=Reset|within=2500`)).toMatchObject({ withinMs: 2500 });
  });

  it("reads \\| in a value as a literal pipe", () => {
    expect(parseSuccessSpec(`http:GET ${URL}|textIncludes=a\\|b`)).toMatchObject({ textIncludes: ["a|b"] });
  });

  it("rejects a jsonPath without an operator", () => {
    expect(() => parseSuccessSpec(`http:GET ${URL}|jsonPath=$.total|textIncludes=x`)).toThrow(/exactly one operator/);
  });

  it("rejects a method other than GET", () => {
    expect(() => parseSuccessSpec(`http:POST ${URL}|status=200`)).toThrow(/only GET/);
  });

  it("rejects a spec with no assertion", () => {
    expect(() => parseSuccessSpec(`http:GET ${URL}`)).toThrow(/at least one assertion/);
  });

  it("rejects a placeholder in the origin", () => {
    expect(() => parseSuccessSpec("http:GET http://${host}/api|status=200")).toThrow(/after the origin/);
  });

  it("round-trips through describeCheck, escapes included", () => {
    const spec = `http:GET ${URL}|status=2xx|jsonPath=$.messages[*].Subject|includes=a\\|b\\\\c|jsonPath=$.total|exists|textIncludes=Reset|within=3000`;
    expect(describeCheck(parseSuccessSpec(spec))).toBe(spec);
  });
});

describe("fixture outputs stay scalar-only (#543)", () => {
  it("selectJsonPath refuses a [*] fan-out", () => {
    expect(() => selectJsonPath({ a: [1] }, "$.a[*]")).toThrow();
  });
});
