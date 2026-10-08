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

test("#432: facade exposes the read-only review_journey tool", () => {
  expect(new Set(listToolNames()).has("review_journey")).toBe(true);
});

test("#433: facade exposes the read-only catalog tools and no catalog approve tool", () => {
  const names = new Set(listToolNames());
  for (const t of ["review_persona", "review_job", "catalog_status"]) expect(names.has(t)).toBe(true);
  for (const t of ["approve_persona", "approve_job"]) {
    expect(names.has(t)).toBe(false);
    expect((FORBIDDEN_TOOLS as readonly string[]).includes(t)).toBe(true);
  }
  expect([...names].filter((n) => /approve/.test(n)).sort()).toEqual(["approve_action", "approve_demo"]);
});
