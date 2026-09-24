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

/** The 8 inbox tools this slice wires: ALL must be real, never a fabricated
 *  `not_implemented` stub — that was the whole point of this task. */
const INBOX_TOOLS = [
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

  it("#118: run_journey passes an optional storageState PATH through to the runner seam", async () => {
    const calls: Array<{ id: string; params: Record<string, string>; storageState?: string }> = [];
    const tools = buildMcpTools({
      ...baseDeps,
      runJourney: async (id, params, storageState) => {
        calls.push({ id, params, storageState });
        return { outcome: "ok", journeyId: id };
      },
    });
    const runTool = tools.find((t) => t.name === "run_journey")!;
    const result = await runTool.handler({ id: "checkout", params: {}, storageState: "/tmp/state.json" });
    expect(calls).toEqual([{ id: "checkout", params: {}, storageState: "/tmp/state.json" }]);
    expect(result.isError).toBeUndefined();

    // Omitted entirely when not given — never fabricated.
    const result2 = await runTool.handler({ id: "checkout", params: {} });
    expect(calls[1]).toEqual({ id: "checkout", params: {}, storageState: undefined });
    expect(result2.isError).toBeUndefined();
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

describe("mcp-api inbox tool wiring", () => {
  it("NO served tool returns a fabricated not_implemented — all 8 formerly-stubbed inbox tools are real", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "mcp-inbox-"));
    const tools = buildMcpTools({ ...baseDeps, inboxDir });

    const args: Record<string, Record<string, unknown>> = {
      list_incoming: {},
      get_command: { id: "no-such-item" },
      get_thread: { id: "no-such-item" },
      queue_action: { run: "r1", journey: "j1", step: "s1", reason: "needs a human", agent: "agent-1" },
      queue_retrieval: { run: "r2", journey: "j1", step: "s2", reason: "needs a human", agent: "agent-1" },
      approve_action: { id: "no-such-item" },
      cancel_command: { id: "no-such-item" },
      get_site_health: {},
    };

    for (const name of INBOX_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      const result = await tool.handler(args[name]);
      expect(result.content[0].text).not.toContain("not_implemented");
    }
  });

  it("list_incoming projects InboxSummary items (empty on a fresh dir)", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "mcp-inbox-"));
    const tools = buildMcpTools({ ...baseDeps, inboxDir });
    const tool = tools.find((t) => t.name === "list_incoming")!;
    const result = await tool.handler({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ items: [] });
  });

  it("queue_action enqueues over the REAL fs inbox store, and get_command retrieves it (burn-after-read)", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "mcp-inbox-"));
    const tools = buildMcpTools({ ...baseDeps, inboxDir });
    const queueAction = tools.find((t) => t.name === "queue_action")!;
    const queued = await queueAction.handler({
      run: "run-1",
      journey: "checkout",
      step: "confirm",
      reason: "please confirm this purchase",
      agent: "explorer-agent",
    });
    expect(queued.isError).toBeUndefined();
    const parsedQueued = JSON.parse(queued.content[0].text);
    expect(parsedQueued.status).toBe("pending");
    expect(typeof parsedQueued.id).toBe("string");

    const getCommand = tools.find((t) => t.name === "get_command")!;
    const got = await getCommand.handler({ id: parsedQueued.id });
    expect(got.isError).toBeUndefined();
    const parsedGot = JSON.parse(got.content[0].text);
    expect(parsedGot.id).toBe(parsedQueued.id);
    expect(parsedGot.status).toBe("pending");
  });

  it("get_command on an unknown id returns a typed not_found, never not_implemented", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "mcp-inbox-"));
    const tools = buildMcpTools({ ...baseDeps, inboxDir });
    const tool = tools.find((t) => t.name === "get_command")!;
    const result = await tool.handler({ id: "no-such-item" });
    expect(result.content[0].text).toContain("not_found");
    expect(result.content[0].text).not.toContain("not_implemented");
  });

  it("approve_action and cancel_command ALWAYS refuse (SM1: human-only) — never touch the store", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "mcp-inbox-"));
    const tools = buildMcpTools({ ...baseDeps, inboxDir });
    for (const name of ["approve_action", "cancel_command"]) {
      const tool = tools.find((t) => t.name === name)!;
      const result = await tool.handler({ id: "whatever" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("human_approval_required");
    }
  });

  it("get_site_health reports a real health snapshot over the fs store", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "mcp-inbox-"));
    const tools = buildMcpTools({ ...baseDeps, inboxDir });
    const tool = tools.find((t) => t.name === "get_site_health")!;
    const result = await tool.handler({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.pending).toBe(0);
  });

  it("refuses inbox tools with a structured error (never a fake success) when inboxDir is not configured", async () => {
    const tools = buildMcpTools(baseDeps); // no inboxDir
    const tool = tools.find((t) => t.name === "list_incoming")!;
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("not_implemented");
  });
});

describe("mcp-api get_mission_result — the typed mission verdict over MCP (owner ruling 1)", () => {
  const call = async (deps: McpApiDeps, args: Record<string, unknown>) => {
    const tool = buildMcpTools(deps).find((t) => t.name === "get_mission_result");
    if (tool === undefined) throw new Error("get_mission_result not served");
    const r = await tool.handler(args);
    return { isError: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") as Record<string, unknown> };
  };

  it("returns the persisted status with the CLI exit code; a broken run is an MCP error, never a pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-mcp-results-"));
    const { writeMissionResult } = await import("./mission-journal.js");
    writeMissionResult(join(dir, "adversarial-2026-09-23T00-00-00-000Z.json"), "defects-found", 1, { defects: [1] });
    writeMissionResult(join(dir, "adversarial-2026-09-23T00-00-00-001Z.json"), "crashed", 2, { failure: "x" });

    const found = await call({ ...baseDeps, recordingsDir: dir }, { id: "adversarial-2026-09-23T00-00-00-000Z" });
    expect(found.isError).toBe(false);
    expect(found.body).toMatchObject({ status: "defects-found", exitCode: 1, isError: false, result: { defects: [1] } });

    const crashed = await call({ ...baseDeps, recordingsDir: dir }, { id: "adversarial-2026-09-23T00-00-00-001Z" });
    expect(crashed.isError).toBe(true);
    expect(crashed.body).toMatchObject({ status: "crashed", exitCode: 2, isError: true });
  });

  it("surfaces an adversarial run's coverage next to its status (an inconclusive low-coverage run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-mcp-results-"));
    const { writeMissionResult } = await import("./mission-journal.js");
    const coverage = { sufficient: false, shortfalls: ["no form was submitted (1 found)"], controls: { total: 8, exercised: 1, ratio: 0.125 } };
    writeMissionResult(join(dir, "adversarial-2026-09-24T00-00-00-000Z.json"), "inconclusive", 2, { coverage });
    const thin = await call({ ...baseDeps, recordingsDir: dir }, { id: "adversarial-2026-09-24T00-00-00-000Z" });
    expect(thin.isError).toBe(true);
    expect(thin.body).toMatchObject({ status: "inconclusive", exitCode: 2, coverage });
  });

  it("accepts an id only — never a path — and reports unknown ids as not_found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-mcp-results-"));
    const traversal = await call({ ...baseDeps, recordingsDir: dir }, { id: "../../etc/passwd" });
    expect(traversal).toMatchObject({ isError: true, body: { error: "invalid_args" } });
    const missing = await call({ ...baseDeps, recordingsDir: dir }, { id: "coverage-2026-09-23T00-00-00-000Z" });
    expect(missing).toMatchObject({ isError: true, body: { error: "not_found" } });
    const unconfigured = await call(baseDeps, { id: "coverage-2026-09-23T00-00-00-000Z" });
    expect(unconfigured).toMatchObject({ isError: true, body: { error: "not_configured" } });
  });
});

describe("mcp-api build identity (#112)", () => {
  const engine = { version: "9.8.7", commit: "abc1234", builtAt: "2026-09-24T00:00:00Z" };

  async function initialize(deps: McpApiDeps) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createMcpServer(deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    const info = client.getServerVersion();
    await client.close();
    return info;
  }

  it("initialize reports the real engine version (never 0.0.0) and names the commit/build", async () => {
    const info = await initialize({ ...baseDeps, engine });
    expect(info).toMatchObject({ name: "jevitate", version: "9.8.7" });
    expect(info?.description).toContain("abc1234");
  });

  it("defaults to this build's currentEngineInfo()", async () => {
    const { currentEngineInfo } = await import("./engine.js");
    expect((await initialize(baseDeps))?.version).toBe(currentEngineInfo().version);
  });

  it("get_site_health reports {version, commit, builtAt} of the serving build", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "mcp-inbox-"));
    const tool = buildMcpTools({ ...baseDeps, inboxDir, engine }).find((t) => t.name === "get_site_health")!;
    const parsed = JSON.parse((await tool.handler({})).content[0].text);
    expect(parsed).toMatchObject(engine);
  });
});

describe("mcp-api get_mission_result / verify_fix — every strategy's stem and queued missionIds (#117)", () => {
  const call = async (deps: McpApiDeps, name: string, args: Record<string, unknown>) => {
    const tool = buildMcpTools(deps).find((t) => t.name === name)!;
    const r = await tool.handler(args);
    return { isError: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") as Record<string, unknown> };
  };
  const MISSION_ID = "549db40a-cd30-4706-b7f5-01ddea8f6d1f";

  it("reads explore (goal, own outcome folded onto the canonical one), feature and usability stems", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-mcp-results-"));
    const ux = mkdtempSync(join(tmpdir(), "jev-mcp-ux-"));
    const { writeMissionResult } = await import("./mission-journal.js");
    writeMissionResult(join(dir, "explore-2026-09-24T15-24-50-561Z.json"), "succeeded", 0, { outcome: "succeeded" });
    writeMissionResult(join(dir, "explore-2026-09-24T15-24-50-562Z.json"), "exhausted", 1, { outcome: "exhausted" });
    writeMissionResult(join(dir, "feature-2026-09-24T15-24-50-561Z.json"), "clean", 0, {});
    writeMissionResult(join(ux, "usability-2026-09-24T15-24-50-561Z.recording.json"), "inconclusive", 143, { stop: "terminated" });
    const deps = { ...baseDeps, recordingsDir: dir, uxReportsDir: ux };

    expect(await call(deps, "get_mission_result", { id: "explore-2026-09-24T15-24-50-561Z" })).toMatchObject({
      isError: false,
      body: { status: "clean", goalOutcome: "succeeded", exitCode: 0 },
    });
    expect(await call(deps, "get_mission_result", { id: "explore-2026-09-24T15-24-50-562Z" })).toMatchObject({
      isError: false,
      body: { status: "defects-found", goalOutcome: "exhausted", exitCode: 1 },
    });
    expect(await call(deps, "get_mission_result", { id: "feature-2026-09-24T15-24-50-561Z" })).toMatchObject({
      isError: false,
      body: { status: "clean" },
    });
    // The usability report stem and its Recording stem both resolve (a killed review: an error, never a pass).
    for (const id of ["usability-2026-09-24T15-24-50-561Z", "usability-2026-09-24T15-24-50-561Z.recording"]) {
      expect(await call(deps, "get_mission_result", { id })).toMatchObject({ isError: true, body: { status: "inconclusive" } });
    }
  });

  it("still refuses anything path-shaped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-mcp-results-"));
    const deps = { ...baseDeps, recordingsDir: dir, missionQueueDir: dir };
    for (const id of [
      "explore-2026-09-24T15-24-50-561Z/../../x",
      "../explore-2026-09-24T15-24-50-561Z",
      "usability-2026-09-24T15-24-50-561Z.recording.result",
      "549db40a-cd30-4706-b7f5-01ddea8f6d1f/..",
      "exploratory-2026-09-24T15-24-50-561Z",
    ]) {
      expect(await call(deps, "get_mission_result", { id })).toMatchObject({ isError: true, body: { error: "invalid_args" } });
      expect(await call(deps, "verify_fix", { id, fingerprint: "1ad9521b771f3bd4" })).toMatchObject({
        isError: true,
        body: { error: "invalid_args" },
      });
    }
  });

  it("resolves a queue_exploration missionId: queued/running is pending, done reads its result, failed is an error", async () => {
    const recordingsDir = mkdtempSync(join(tmpdir(), "jev-mcp-results-"));
    const missionQueueDir = mkdtempSync(join(tmpdir(), "jev-mcp-queue-"));
    const queue = new FsMissionQueueStore(missionQueueDir);
    const queued = {
      id: MISSION_ID,
      target: "demo-shop",
      goal: "g",
      successAssertion: { kind: "urlIncludes" as const, text: "/x" },
      strategy: "goal-based" as const,
      budget: { maxActions: 5, maxDecisions: 10, maxCandidates: 50 },
      status: "queued" as const,
      enqueuedAtIso: "2026-09-24T00:00:00.000Z",
    };
    await queue.enqueue(queued);
    const deps = { ...baseDeps, recordingsDir, missionQueueDir };

    expect(await call(deps, "get_mission_result", { id: MISSION_ID })).toMatchObject({
      isError: false,
      body: { missionId: MISSION_ID, status: "queued", pending: true },
    });
    // Nothing to verify yet — never a pass.
    expect(await call(deps, "verify_fix", { id: MISSION_ID, fingerprint: "1ad9521b771f3bd4" })).toMatchObject({
      isError: true,
      body: { error: "not_ready", status: "queued" },
    });

    await queue.update({ ...queued, status: "running", startedAtIso: "2026-09-24T00:00:01.000Z" });
    expect(await call(deps, "get_mission_result", { id: MISSION_ID })).toMatchObject({ body: { status: "running", pending: true } });

    const { writeMissionResult } = await import("./mission-journal.js");
    writeMissionResult(join(recordingsDir, "explore-2026-09-24T00-00-02-000Z.json"), "succeeded", 0, { outcome: "succeeded" });
    await queue.update({ ...queued, status: "done", resultId: "explore-2026-09-24T00-00-02-000Z", missionOutcome: "succeeded", exitCode: 0 });
    expect(await call(deps, "get_mission_result", { id: MISSION_ID })).toMatchObject({
      isError: false,
      body: { id: MISSION_ID, missionId: MISSION_ID, resultId: "explore-2026-09-24T00-00-02-000Z", status: "clean" },
    });

    let verifiedPath = "";
    const verifyDeps = {
      ...deps,
      verifyFix: async (a: { resultPath: string; fingerprint: string }) => {
        verifiedPath = a.resultPath;
        return { verdict: "fixed", exitCode: 0 } as never;
      },
    };
    expect(await call(verifyDeps, "verify_fix", { id: MISSION_ID, fingerprint: "1ad9521b771f3bd4" })).toMatchObject({
      isError: false,
      body: { missionId: MISSION_ID, resultId: "explore-2026-09-24T00-00-02-000Z", status: "fixed" },
    });
    expect(verifiedPath).toBe(join(recordingsDir, "explore-2026-09-24T00-00-02-000Z.result.json"));

    await queue.update({ ...queued, status: "failed", error: "unknown or unpromoted mission target" });
    expect(await call(deps, "get_mission_result", { id: MISSION_ID })).toMatchObject({
      isError: true,
      body: { status: "failed", error: "unknown or unpromoted mission target" },
    });
  });

  it("an unknown missionId is not_found; no queue dir configured is a config refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-mcp-results-"));
    expect(await call({ ...baseDeps, recordingsDir: dir, missionQueueDir: dir }, "get_mission_result", { id: MISSION_ID })).toMatchObject({
      isError: true,
      body: { error: "not_found" },
    });
    expect(await call({ ...baseDeps, recordingsDir: dir }, "get_mission_result", { id: MISSION_ID })).toMatchObject({
      isError: true,
      body: { error: "not_configured" },
    });
  });
});
