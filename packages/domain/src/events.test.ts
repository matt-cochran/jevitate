import { expect, test } from "vitest";
import { DomainEventInputSchema } from "./events.js";

test("valid event input parses", () => {
  const e = { aggregate: "cmd_1", type: "state.changed", payload: { to: "ready" }, occurredAt: "2026-09-16T12:00:00Z", correlationId: "corr_1" };
  expect(DomainEventInputSchema.parse(e).type).toBe("state.changed");
});

test("missing type is rejected", () => {
  expect(() => DomainEventInputSchema.parse({ aggregate: "x", occurredAt: "t", correlationId: "c" })).toThrow();
});
