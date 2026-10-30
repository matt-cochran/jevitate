import { describe, expect, it } from "vitest";
import { describeCheck } from "@jevitate/explore";
import { parseSuccessSpec } from "./explore-specs.js";

/**
 * #743 REPAIR 1: the `--success` parser accepts the counted and body-aware network-check suffixes
 * `describeCheck` prints (`|count=exact:N|min:N|max:N`, `|body=name:predicate,…`), round-trips them
 * exactly, and refuses a credential-named body field.
 */
describe("counted network-check specs (#743)", () => {
  it("parses an exact count suffix", () => {
    expect(parseSuccessSpec("requestMade:POST /api/preview|count=exact:1")).toEqual({
      kind: "requestMade",
      method: "POST",
      pathGlob: "/api/preview",
      count: { exact: 1 },
    });
  });

  it("parses a minimum count suffix", () => {
    expect(parseSuccessSpec("requestMade:POST /api/preview|count=min:5")).toMatchObject({ count: { min: 5 } });
  });

  it("parses a maximum count suffix", () => {
    expect(parseSuccessSpec("requestMade:POST /api/preview|count=max:0")).toMatchObject({ count: { max: 0 } });
  });

  it("refuses a negative count", () => {
    expect(() => parseSuccessSpec("requestMade:POST /api/preview|count=exact:-1")).toThrow(/count expects/);
  });
});

describe("body-aware network-check specs (#743)", () => {
  it("parses a declared body shape", () => {
    expect(parseSuccessSpec("requestMade:POST /api/preview|body=voiceId:string,items:array")).toEqual({
      kind: "requestMade",
      method: "POST",
      pathGlob: "/api/preview",
      bodyShape: { fields: [{ name: "voiceId", predicate: "string" }, { name: "items", predicate: "array" }] },
    });
  });

  it("parses an unknown body predicate as an error", () => {
    expect(() => parseSuccessSpec("requestMade:POST /api/preview|body=voiceId:shout")).toThrow(/predicate/);
  });

  it("refuses a body field that names a credential", () => {
    expect(() => parseSuccessSpec("requestMade:POST /api/login|body=password:exists")).toThrow(/credential/);
  });
});

describe("round-tripping counted and body-aware network-check specs (#743)", () => {
  it("a counted requestMade round-trips through parse and describe", () => {
    const spec = "requestMade:POST /api/preview|count=exact:1";
    expect(describeCheck(parseSuccessSpec(spec))).toBe(spec);
  });

  it("a body-aware requestMade round-trips through parse and describe", () => {
    const spec = "requestMade:POST /api/preview|body=voiceId:string,items:array";
    expect(describeCheck(parseSuccessSpec(spec))).toBe(spec);
  });

  it("a counted and body-aware responseStatus round-trips through parse and describe", () => {
    const spec = "responseStatus:POST /api/preview=2xx|count=min:5|body=voiceId:string";
    expect(describeCheck(parseSuccessSpec(spec))).toBe(spec);
  });
});
