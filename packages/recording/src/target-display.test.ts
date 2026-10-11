import { describe, expect, it } from "vitest";
import { TargetDescriptorSchema } from "./schema.js";

/** #497: a step target's recorded visible label is display metadata, never a selector. */
describe("TargetDescriptor.display (#497)", () => {
  it("a descriptor with a display beside its testId round-trips the display", () => {
    const parsed = TargetDescriptorSchema.parse({ testId: "action-import", display: { role: "button", name: "Import" } });
    expect(parsed.display).toEqual({ role: "button", name: "Import" });
  });

  it("a display alone does not satisfy the locator requirement", () => {
    expect(TargetDescriptorSchema.safeParse({ display: { role: "button", name: "Import" } }).success).toBe(false);
  });

  it("a display with an empty name is refused", () => {
    expect(TargetDescriptorSchema.safeParse({ testId: "x", display: { name: "" } }).success).toBe(false);
  });

  it("a display with an unknown key is refused", () => {
    expect(TargetDescriptorSchema.safeParse({ testId: "x", display: { name: "Import", text: "Import" } }).success).toBe(false);
  });
});
