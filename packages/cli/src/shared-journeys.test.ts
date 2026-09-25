import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildMcpTools } from "./mcp-api.js";
import { buildProgram } from "./program.js";

/** Shared Journeys (a submodule under `.jevitate/journeys/<shared>/`) reach every Journey surface. */
let journeys: string;
beforeEach(() => {
  journeys = mkdtempSync(join(tmpdir(), "jev-shared-cli-"));
  mkdirSync(join(journeys, "commerce"));
  writeFileSync(
    join(journeys, "commerce", "checkout.json"),
    JSON.stringify({
      metadata: { id: "checkout", name: "Checkout", description: "buy one item", promoted: true, params: [], createdAtIso: "2026-09-25T00:00:00Z" },
      recording: { version: "1", site: "https://shop.example.test", pages: [] },
    }),
  );
});
afterEach(() => {
  rmSync(journeys, { recursive: true, force: true });
});

describe("shared Journeys on the Journey surfaces", () => {
  it("MCP find_capabilities lists `commerce/checkout`", async () => {
    const tool = buildMcpTools({ journeysDir: journeys }).find((t) => t.name === "find_capabilities")!;
    const res = await tool.handler({ query: "checkout" });
    expect((res.content[0] as { text: string }).text).toContain('"commerce/checkout"');
  });

  it("`journey run commerce/checkout` runs it", async () => {
    const opens: OpenOptions[] = [];
    const port: BrowserPort = {
      async open(o) {
        opens.push(o);
        return { page: {} as never, startTracing: async () => {}, stopTracingToFile: async () => {}, saveStorageState: async () => {}, admission: undefined, close: async () => {} };
      },
    };
    const lines: string[] = [];
    const program = buildProgram({ profiles: new ProfileManager("/unused"), explore: { browserPortFactory: () => port } });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(["journey", "run", "commerce/checkout", "--dir", journeys, "--json"], { from: "user" });
    expect(JSON.parse(lines.join("")).ok).toBe(true);
    expect(opens).toHaveLength(1);
  });
});
