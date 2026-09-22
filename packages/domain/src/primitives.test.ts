import { expect, test } from "vitest";
import { RiskClassSchema, IdempotencyKeySchema, newCommandId } from "./primitives.js";

test("risk class accepts known values and rejects others", () => {
  expect(RiskClassSchema.parse("read")).toBe("read");
  expect(() => RiskClassSchema.parse("delete")).toThrow();
});

test("idempotency key rejects empty", () => {
  expect(() => IdempotencyKeySchema.parse("")).toThrow();
  expect(IdempotencyKeySchema.parse("k1")).toBe("k1");
});

test("command ids are unique and prefixed", () => {
  const a = newCommandId();
  const b = newCommandId();
  expect(a.startsWith("cmd_")).toBe(true);
  expect(a).not.toBe(b);
});
