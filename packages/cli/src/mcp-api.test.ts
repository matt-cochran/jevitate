import { describe, it, expect } from "vitest";
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "@jevitate/mcp-facade";
import { buildMcpTools, createMcpServer, type McpApiDeps } from "./mcp-api.js";

const baseDeps: McpApiDeps = { journeysDir: "/nonexistent-journeys-dir" };

describe("mcp-api tool allowlist boundary", () => {
  it("serves EXACTLY the ALLOWED_TOOLS set (no more, no less)", () => {
    const names = buildMcpTools(baseDeps).map((t) => t.name);
    expect([...names].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });

  it("refuses to serve ANY forbidden browser primitive", () => {
    const names = new Set(buildMcpTools(baseDeps).map((t) => t.name));
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  it("every served tool has a callable handler and an object inputSchema", () => {
    for (const tool of buildMcpTools(baseDeps)) {
      expect(typeof tool.handler).toBe("function");
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("constructs a Server without opening a transport", () => {
    const server = createMcpServer(baseDeps);
    expect(server).toBeTruthy();
    expect(typeof server.connect).toBe("function");
  });
});

describe("mcp-api wired handlers", () => {
  it("find_capabilities delegates to the injected capability finder", async () => {
    const seen: string[] = [];
    const tools = buildMcpTools({
      ...baseDeps,
      findCapabilities: async (query) => {
        seen.push(query);
        return [{ id: "checkout", name: "checkout", params: ["qty"] }];
      },
    });
    const findCaps = tools.find((t) => t.name === "find_capabilities")!;
    const result = await findCaps.handler({ query: "checkout" });
    expect(seen).toEqual(["checkout"]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("checkout");
  });

  it("run_journey delegates to the injected runner and NEVER accepts inline steps", async () => {
    const calls: Array<{ id: string; params: Record<string, string> }> = [];
    const tools = buildMcpTools({
      ...baseDeps,
      runJourney: async (id, params) => {
        calls.push({ id, params });
        return { outcome: "ok", journeyId: id };
      },
    });
    const runTool = tools.find((t) => t.name === "run_journey")!;
    // Inline `steps` in the args must be ignored — only id + params are threaded.
    const result = await runTool.handler({ id: "checkout", params: { qty: "2" }, steps: [{ evil: true }] });
    expect(calls).toEqual([{ id: "checkout", params: { qty: "2" } }]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("checkout");
  });

  it("run_journey rejects a missing id with a structured error (never a fake success)", async () => {
    const tools = buildMcpTools({ ...baseDeps, runJourney: async () => ({ outcome: "ok" }) });
    const runTool = tools.find((t) => t.name === "run_journey")!;
    const result = await runTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_args");
  });

  it("an allowlisted-but-unwired tool returns a not_implemented error, not a fake success", async () => {
    const tools = buildMcpTools(baseDeps);
    const stub = tools.find((t) => t.name === "get_command")!;
    const result = await stub.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not_implemented");
  });
});
