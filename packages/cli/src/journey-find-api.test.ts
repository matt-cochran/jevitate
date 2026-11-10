import { describe, expect, it } from "vitest";
import type { Journey } from "@jevitate/journey";
import { capabilityParameters } from "./journey-find-api.js";

const j = (parameters?: Journey["metadata"]["parameters"]): Journey =>
  ({ metadata: { id: "a", name: "a", params: [], parameters }, recording: {} }) as unknown as Journey;

describe("capabilityParameters (#796)", () => {
  it("lists type and enum values of a typed parameter", () => {
    const out = capabilityParameters(j([{ name: "plan", type: "enum", enum: ["free", "pro"] }]));
    expect(out?.[0]).toEqual({ name: "plan", type: "enum", enum: ["free", "pro"] });
  });
  it("adds nothing when no parameter is typed, or there is no Journey", () => {
    expect(capabilityParameters(j([{ name: "plan" }]))).toBeUndefined();
    expect(capabilityParameters(j())).toBeUndefined();
    expect(capabilityParameters(null)).toBeUndefined();
  });
  it("keeps an untyped sibling as a bare name", () => {
    expect(capabilityParameters(j([{ name: "x" }, { name: "n", type: "number" }]))).toEqual([{ name: "x" }, { name: "n", type: "number" }]);
  });
});
