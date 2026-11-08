import { describe, expect, it } from "vitest";
import { JourneySchema, type Journey, type JourneyParameter } from "./journey.js";
import { PARAMETER_TYPES, matchesParameterType, validateParamTypes } from "./parameters.js";

function journey(parameters: JourneyParameter[]): Journey {
  return {
    metadata: { id: "j1", name: "J", promoted: false, params: [], parameters, createdAtIso: "2026-09-19T00:00:00Z" },
    recording: { version: "1", site: "example", pages: [] },
  } as unknown as Journey;
}

function parse(parameters: unknown[]): ReturnType<typeof JourneySchema.safeParse> {
  const j = journey([]) as unknown as { metadata: Record<string, unknown> };
  return JourneySchema.safeParse({ ...j, metadata: { ...j.metadata, parameters } });
}

describe("#796 typed parameters", () => {
  it("an untyped parameter stays untyped: any value, no issue", () => {
    expect(validateParamTypes(journey([{ name: "qty" }]), { qty: "abc" })).toEqual([]);
  });

  it("a number parameter given 'abc' yields one value-free issue", () => {
    const issues = validateParamTypes(journey([{ name: "qty", type: "number" }]), { qty: "abc" });
    expect(issues).toEqual([{ name: "qty", expected: "number" }]);
    expect(issues[0]).not.toHaveProperty("value");
    expect(JSON.stringify(issues)).not.toContain("abc");
  });

  it("a secret typed parameter's value never appears in the issue", () => {
    const issues = validateParamTypes(journey([{ name: "pin", type: "number", secret: true }]), { pin: "hunter2" });
    expect(issues).toEqual([{ name: "pin", expected: "number" }]);
    expect(JSON.stringify(issues)).not.toContain("hunter2");
  });

  it("a missing or undeclared param is not a type issue", () => {
    expect(validateParamTypes(journey([{ name: "qty", type: "number" }]), { other: "x" })).toEqual([]);
    expect(validateParamTypes(journey([]), { qty: "abc" })).toEqual([]);
  });

  it("checks each type", () => {
    const ok: Array<[(typeof PARAMETER_TYPES)[number], string, string]> = [
      ["string", "anything at all", ""],
      ["number", "-12.5e3", "12a"],
      ["boolean", "true", "yes"],
      ["email", "a.b@example.co", "a@b"],
      ["url", "https://example.com/x?y=1", "ftp://example.com"],
      ["date", "2024-02-29", "2023-02-29"],
    ];
    for (const [type, good, bad] of ok) {
      expect(matchesParameterType(type, good), `${type} ${good}`).toBe(true);
      if (type !== "string") expect(matchesParameterType(type, bad), `${type} ${bad}`).toBe(false);
    }
    expect(matchesParameterType("enum", "red", ["red", "blue"])).toBe(true);
    expect(matchesParameterType("enum", "green", ["red", "blue"])).toBe(false);
    expect(validateParamTypes(journey([{ name: "c", type: "enum", enum: ["red"] }]), { c: "green" })).toEqual([{ name: "c", expected: "enum" }]);
  });

  it("the schema accepts type and enum, and a Journey without them parses as before", () => {
    expect(parse([{ name: "qty" }]).success).toBe(true);
    expect(parse([{ name: "qty", type: "number" }]).success).toBe(true);
    expect(parse([{ name: "c", type: "enum", enum: ["red", "blue"] }]).success).toBe(true);
    expect(parse([{ name: "qty", type: "integer" }]).success).toBe(false);
  });

  it("refuses type enum without a values list, and a values list on another type, at parse", () => {
    const noValues = parse([{ name: "c", type: "enum" }]);
    expect(noValues.success).toBe(false);
    expect(JSON.stringify(noValues.error?.issues)).toContain("E_PARAM_ENUM_VALUES");
    expect(parse([{ name: "c", type: "enum", enum: [] }]).success).toBe(false);
    expect(parse([{ name: "c", type: "string", enum: ["a"] }]).success).toBe(false);
    expect(parse([{ name: "c", enum: ["a"] }]).success).toBe(false);
  });

  it("the handoff contract lists exactly the ParameterType values", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../../../docs/contracts/journey-handoff.md", import.meta.url), "utf8");
    const section = doc.split("## 8. Parameter types")[1]?.split(/\n## /)[0] ?? "";
    const listed = [...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
    expect(listed).toEqual([...PARAMETER_TYPES]);
  });
});
