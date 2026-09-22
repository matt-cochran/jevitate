import { expect, test } from "vitest";
import { listToolNames, ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "./tools.js";

test("facade exposes exactly the allowed domain tools", () => {
  expect([...listToolNames()].sort()).toEqual([...ALLOWED_TOOLS].sort());
});

test("facade exposes none of the forbidden browser surfaces", () => {
  const names = new Set(listToolNames());
  for (const forbidden of FORBIDDEN_TOOLS) {
    expect(names.has(forbidden)).toBe(false);
  }
});

test("facade exposes the two-level journey tools alongside the existing allowlist", () => {
  const names = new Set(listToolNames());
  expect(names.has("find_capabilities")).toBe(true);
  expect(names.has("run_journey")).toBe(true);
  for (const forbidden of FORBIDDEN_TOOLS) {
    expect(names.has(forbidden)).toBe(false);
  }
});

test("facade exposes queue_exploration alongside the existing allowlist", () => {
  const names = new Set(listToolNames());
  expect(names.has("queue_exploration")).toBe(true);
  for (const forbidden of FORBIDDEN_TOOLS) {
    expect(names.has(forbidden)).toBe(false);
  }
});
