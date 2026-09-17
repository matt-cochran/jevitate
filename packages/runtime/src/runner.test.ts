import { expect, test } from "vitest";
import { z } from "zod";
import { defineAction, ActionRegistry } from "@doit/site-sdk";
import { BrowseTheWebToken } from "@doit/screenplay";
import { ActionRunner } from "./runner.js";

const fakeBrowser = {
  open: async () => ({
    page: { url: () => "about:blank" } as any,
    startTracing: async () => {},
    stopTracingToFile: async () => {},
    close: async () => {},
  }),
};

const Echo = defineAction({
  id: "diag.echo", version: "1.0.0",
  input: z.object({ msg: z.string() }), output: z.object({ echoed: z.string(), hasBrowser: z.boolean() }),
  risk: "read", throttleClass: "read",
  async execute(actor, input) {
    return { echoed: input.msg, hasBrowser: !!actor.ability(BrowseTheWebToken) };
  },
});

test("runner resolves, validates, executes, and returns typed output", async () => {
  const reg = new ActionRegistry();
  reg.register("example-network", Echo);
  const runner = new ActionRunner(fakeBrowser as any, reg);
  const res = await runner.run({
    site: "example-network", account: "primary", actionId: "diag.echo", version: "1.0.0",
    input: { msg: "hi" }, profileDir: "/tmp/x", baseUrl: "about:blank", headless: true, allowedOrigins: [],
  });
  expect(res.output).toEqual({ echoed: "hi", hasBrowser: true });
});

test("runner rejects invalid input", async () => {
  const reg = new ActionRegistry();
  reg.register("example-network", Echo);
  const runner = new ActionRunner(fakeBrowser as any, reg);
  await expect(runner.run({
    site: "example-network", account: "primary", actionId: "diag.echo", version: "1.0.0",
    input: { msg: 123 }, profileDir: "/tmp/x", baseUrl: "about:blank", headless: true, allowedOrigins: [],
  })).rejects.toThrow();
});
