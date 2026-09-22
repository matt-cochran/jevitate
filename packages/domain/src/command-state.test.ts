import { expect, test } from "vitest";
import { transition, canTransition, IllegalTransitionError } from "./command-state.js";

test("legal transition returns the target state", () => {
  expect(transition("ready", "leased")).toBe("leased");
});

test("illegal transition throws", () => {
  expect(canTransition("succeeded", "running")).toBe(false);
  expect(() => transition("succeeded", "running")).toThrow(IllegalTransitionError);
});

test("lease expiry can return a command to ready or retry", () => {
  expect(canTransition("leased", "ready")).toBe(true);
  expect(canTransition("leased", "retry")).toBe(true);
});

test("unknown external outcome routes to reconciling not retry", () => {
  expect(canTransition("running", "reconciling")).toBe(true);
});
