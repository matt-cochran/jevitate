import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "@jevitate/mcp-facade";
import {
  FsMissionTargetStore,
  MissionTargetRegistry,
  FsMissionQueueStore,
  type MissionTarget,
} from "@jevitate/missions";
import { FakeGenerationGateway, type CredentialStore, type GenerationPort } from "@jevitate/ai-core";
import { buildMcpTools, createMcpServer, type McpApiDeps } from "./mcp-api.js";

const baseDeps: McpApiDeps = { journeysDir: "/nonexistent-journeys-dir" };

/** The allowlisted tools that have NO backing service in this slice and must
 *  therefore stay a typed `not_implemented` (never a fabricated success). */
const STILL_NOT_IMPLEMENTED = [
  "queue_retrieval",
  "queue_action",
  "get_command",
  "list_incoming",
  "get_thread",
  "approve_action",
  "cancel_command",
  "get_site_health",
];

const storeWithKey: CredentialStore = { detect: () => true, read: () => "sk-secret-value-xyz" };
const storeNoKey: CredentialStore = { detect: () => false, read: () => undefined };

function mkTarget(id: string, promoted: boolean): MissionTarget {
  return {
    id,
    name: id,
    authorizedOrigin: "https://demo.example.com",
    baseUrl: "https://demo.example.com",
    promoted,
    createdAtIso: new Date().toISOString(),
  };
}

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
});

describe("mcp-api queue_exploration wiring", () => {
  it("delegates to the injected queueExploration seam and returns the queued envelope", async () => {
    const seen: unknown[] = [];
    const tools = buildMcpTools({
      ...baseDeps,
      queueExploration: async (args) => {
        seen.push(args);
        return { ok: true, missionId: "m1", status: "queued" };
      },
    });
    const tool = tools.find((t) => t.name === "queue_exploration")!;
    const request = { target: "demo-shop", goal: "g", successAssertion: { kind: "urlIncludes", text: "/x" }, strategy: "goal-based" };
    const result = await tool.handler(request);
    expect(seen).toEqual([request]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).status).toBe("queued");
  });

  it("enqueues a mission over the REAL fs missions store for a promoted target", async () => {
    const targetsDir = mkdtempSync(join(tmpdir(), "mcp-tgt-"));
    const queueDir = mkdtempSync(join(tmpdir(), "mcp-q-"));
    const targets = new MissionTargetRegistry(new FsMissionTargetStore(targetsDir));
    await targets.put(mkTarget("demo-shop", true));
    const tools = buildMcpTools({ ...baseDeps, missionTargetsDir: targetsDir, missionQueueDir: queueDir });
    const tool = tools.find((t) => t.name === "queue_exploration")!;
    const result = await tool.handler({
      target: "demo-shop",
      goal: "verify checkout",
      successAssertion: { kind: "urlIncludes", text: "/checkout" },
      strategy: "goal-based",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("queued");
    const queue = new FsMissionQueueStore(queueDir);
    expect(await queue.get(parsed.missionId)).not.toBeNull();
  });

  it("refuses an unknown/unpromoted target with a structured error (never a fake queued success)", async () => {
    const targetsDir = mkdtempSync(join(tmpdir(), "mcp-tgt-"));
    const queueDir = mkdtempSync(join(tmpdir(), "mcp-q-"));
    const targets = new MissionTargetRegistry(new FsMissionTargetStore(targetsDir));
    await targets.put(mkTarget("staging-shop", false)); // unpromoted
    const tools = buildMcpTools({ ...baseDeps, missionTargetsDir: targetsDir, missionQueueDir: queueDir });
    const tool = tools.find((t) => t.name === "queue_exploration")!;
    const result = await tool.handler({
      target: "staging-shop",
      goal: "g",
      successAssertion: { kind: "urlIncludes", text: "/x" },
      strategy: "goal-based",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("queued");
    // The queue must be empty — nothing was written on refusal.
    const queue = new FsMissionQueueStore(queueDir);
    expect(await queue.list()).toHaveLength(0);
  });
});

describe("mcp-api ai_generate_text wiring", () => {
  const args = { fieldLabel: "email", goal: "fill the field", visibleContext: "a login form" };

  it("delegates to the injected aiGenerateText seam", async () => {
    const seen: unknown[] = [];
    const tools = buildMcpTools({
      ...baseDeps,
      aiGenerateText: async (a) => {
        seen.push(a);
        return { ok: true, text: "hello" };
      },
    });
    const tool = tools.find((t) => t.name === "ai_generate_text")!;
    const result = await tool.handler(args);
    expect(seen).toEqual([args]);
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, text: "hello" });
  });

  it("generates via the real facade+gateway when the credential is present", async () => {
    const tools = buildMcpTools({ ...baseDeps, credentialStore: storeWithKey, generationGateway: new FakeGenerationGateway() });
    const tool = tools.find((t) => t.name === "ai_generate_text")!;
    const result = await tool.handler(args);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe("value:email");
  });

  it("returns a typed setup_required precondition (NOT a fake answer) when the key is missing", async () => {
    const tools = buildMcpTools({ ...baseDeps, credentialStore: storeNoKey, generationGateway: new FakeGenerationGateway() });
    const tool = tools.find((t) => t.name === "ai_generate_text")!;
    const result = await tool.handler(args);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.precondition).toBe("setup_required");
    expect(parsed.missing).toContain("OPENROUTER_API_KEY");
  });

  it("NEVER leaks a credential value in a provider error message", async () => {
    const throwing: GenerationPort = {
      async generate() {
        throw new Error("provider 500: request body contained sk-secret-value-xyz");
      },
    };
    const tools = buildMcpTools({ ...baseDeps, credentialStore: storeWithKey, generationGateway: throwing });
    const tool = tools.find((t) => t.name === "ai_generate_text")!;
    const result = await tool.handler(args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("sk-secret-value-xyz");
    expect(result.content[0].text).toContain("ai_generate_failed");
  });

  it("rejects malformed args with a structured error (never a fake success)", async () => {
    const tools = buildMcpTools({ ...baseDeps, credentialStore: storeWithKey, generationGateway: new FakeGenerationGateway() });
    const tool = tools.find((t) => t.name === "ai_generate_text")!;
    const result = await tool.handler({ goal: "only a goal" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_args");
  });
});

describe("mcp-api not-yet-wired tools", () => {
  it("leaves EXACTLY the un-backed inbox/command tools as a typed not_implemented", async () => {
    const wiredDeps: McpApiDeps = {
      ...baseDeps,
      missionTargetsDir: "/nonexistent-targets",
      missionQueueDir: "/nonexistent-queue",
      credentialStore: storeWithKey,
      generationGateway: new FakeGenerationGateway(),
    };
    const tools = buildMcpTools(wiredDeps);
    const notImplemented: string[] = [];
    for (const tool of tools) {
      const result = await tool.handler({});
      if (result.isError && result.content[0].text.includes("not_implemented")) {
        notImplemented.push(tool.name);
      }
    }
    expect(notImplemented.sort()).toEqual([...STILL_NOT_IMPLEMENTED].sort());
  });

  it("an unwired tool returns not_implemented, not a fake success", async () => {
    const tools = buildMcpTools(baseDeps);
    const stub = tools.find((t) => t.name === "get_command")!;
    const result = await stub.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not_implemented");
  });
});
