import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerBrowserCommands } from "./browser-cli.js";

describe("install-browser", () => {
  it("spawns the install with PLAYWRIGHT_SKIP_BROWSER_GC=1", async () => {
    let env: NodeJS.ProcessEnv = {};
    const p = new Command().exitOverride();
    registerBrowserCommands(p, { spawn: (_c, _a, o) => ((env = o.env ?? {}), { on: (e, cb) => void (e === "exit" && (cb as (c: number) => void)(0)) }) });
    await p.parseAsync(["node", "x", "install-browser"]);
    expect(env.PLAYWRIGHT_SKIP_BROWSER_GC).toBe("1");
  });
});
