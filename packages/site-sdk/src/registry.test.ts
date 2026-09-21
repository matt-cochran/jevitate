import { expect, test } from "vitest";
import { z } from "zod";
import { defineAction, ActionRegistry, UnknownActionError } from "./index.js";

const Ping = defineAction({
  id: "diag.ping", version: "1.0.0",
  input: z.object({}), output: z.object({ ok: z.boolean() }),
  risk: "read", throttleClass: "read",
  async execute() { return { ok: true }; },
});

test("registry resolves a registered action and rejects unknown", () => {
  const reg = new ActionRegistry();
  reg.register("example-network", Ping);
  expect(reg.resolve("example-network", "diag.ping", "1.0.0").id).toBe("diag.ping");
  expect(() => reg.resolve("example-network", "diag.ping", "9.9.9")).toThrow(UnknownActionError);
});
