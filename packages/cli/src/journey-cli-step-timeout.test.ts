import { describe, expect, it } from "vitest";
import type { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";

/** #486 (review L2): `journey run --step-response-timeout` is bounded like MCP's stepResponseTimeoutMs (at most 300000 ms). */
describe("journey run --step-response-timeout bound", () => {
  it("refuses a bound above 300000 ms before anything runs", async () => {
    const program = buildProgram({ profiles: {} as unknown as ProfileManager });
    program.exitOverride();
    for (const c of program.commands) c.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    for (const c of program.commands) for (const sub of c.commands) sub.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    await expect(program.parseAsync(["node", "jevitate", "journey", "run", "some-journey", "--step-response-timeout", "300001"])).rejects.toMatchObject({
      code: "commander.invalidArgument",
    });
  });
});
