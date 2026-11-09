import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "@jevitate/mcp-facade";
import type { Journey } from "@jevitate/journey";
import { FsJourneyCallQueueStore } from "@jevitate/missions";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { journeyReviewHash } from "./journey-review.js";

/**
 * 0.30.0 MCP surface (d-queue-journeys-mcp): the served tools are exactly `ALLOWED_TOOLS`, and the only
 * addition since 0.29.0 is `queue_journey` (#797, owner decision 8). `queue_journey` refuses a secret
 * param by name before anything is written, and queues a promoted Journey only, bound to its hash.
 */

/** `ALLOWED_TOOLS` as released in 0.29.0 (git show v0.29.0:packages/mcp-facade/src/tools.ts), in order. */
const ALLOWED_TOOLS_0_29_0 = [
  "queue_retrieval", "queue_action", "get_command", "list_incoming", "get_thread", "approve_action", "cancel_command", "get_site_health",
  "find_capabilities", "run_journey", "ai_generate_text", "queue_exploration", "get_mission_result", "verify_fix",
  "list_journeys", "promote_journey", "annotate_journey", "demo_journey", "publish_journey", "create_demo", "approve_demo", "run_exploration",
  "author_journey", "run_check", "get_report", "diff_runs", "baselines", "ledger", "run_load_test", "prune_logs", "run_queued_missions",
  "mission_targets", "profiles", "recordings", "regressions", "site_policy", "sources", "ux_review", "validate_invariants", "get_ai_status",
  "journey_anchors", "run_campaign", "lint_journey", "verify_journey", "chain_journeys", "journey_readiness", "journey_bundle", "run_sweep",
  "review_journey", "review_persona", "review_job", "catalog_status", "analyze_catalog", "draft_job_outcomes", "locator_health",
  "export_catalog_bundle", "publish_to_journeeze", "journey_anchor_add", "journey_anchor_remove", "catalog_draft", "journey_link",
] as const;

const ORIGIN = "http://127.0.0.1:9";

let root: string;
let journeysDir: string;
let queueDir: string;
let targetsFile: string;

const journey = (id: string, metadata: Partial<Journey["metadata"]> = {}): Journey =>
  ({
    metadata: { id, name: id, promoted: false, params: [], parameters: [{ name: "note", description: "a note" }], createdAtIso: "2026-11-09T00:00:00.000Z", ...metadata },
    recording: { version: "1", site: ORIGIN, pages: [{ url: "/", steps: [{ step: { kind: "fill", target: { testId: "note" }, value: { var: "note" }, expect: { kind: "visible", target: { testId: "note" } } } }] }] },
  }) as unknown as Journey;

const approved = (j: Journey, channel: "tty" | "mcp" = "tty"): Journey =>
  ({ ...j, metadata: { ...j.metadata, promoted: true, approval: { contentHash: journeyReviewHash(j), at: "2026-11-09T00:00:00.000Z", provenance: { channel, agentSignals: [] } } } }) as Journey;

const seed = (j: Journey): void => writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));

const deps = (): McpApiDeps => ({ journeysDir, pathRoots: [root], missionQueueDir: queueDir, missionTargetsDir: join(root, "mission-targets"), recordingsDir: join(root, "logs"), targetsConfigPath: targetsFile, environmentsFile: join(root, "environments.json") });

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const tool = buildMcpTools(deps()).find((t) => t.name === name)!;
  const r = await tool.handler(args);
  return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as Record<string, unknown> };
}

const queued = (): string[] => (existsSync(queueDir) ? readdirSync(queueDir, { recursive: true }).map(String) : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-030-surface-"));
  journeysDir = join(root, "journeys");
  queueDir = join(root, "queue");
  mkdirSync(journeysDir, { recursive: true });
  targetsFile = join(root, "targets.json");
  writeFileSync(targetsFile, "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("0.30.0: the served MCP tools", () => {
  it("buildMcpTools(deps).map(t => t.name) deep-equals ALLOWED_TOOLS", () => {
    expect(buildMcpTools({ journeysDir: "/unused" }).map((t) => t.name)).toEqual([...ALLOWED_TOOLS]);
  });

  it("the only difference from the 0.29.0 list is ['queue_journey']: nothing added besides it, nothing removed", () => {
    const now = new Set<string>(ALLOWED_TOOLS);
    const then = new Set<string>(ALLOWED_TOOLS_0_29_0);
    expect([...now].filter((t) => !then.has(t))).toEqual(["queue_journey"]);
    expect([...then].filter((t) => !now.has(t))).toEqual([]);
    expect((FORBIDDEN_TOOLS as readonly string[]).includes("queue_journey")).toBe(false);
  });

  it("queue_journey is wired (not the not_implemented placeholder) and takes only id, params, env, baseUrl", () => {
    const tool = buildMcpTools({ journeysDir: "/unused" }).find((t) => t.name === "queue_journey")!;
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["baseUrl", "env", "id", "params"]);
    expect(tool.description).not.toMatch(/not yet wired/);
  });
});

describe("0.30.0 #797 queue_journey", () => {
  it("{password: 'x'} returns E_SECRET_PARAM_OVER_MCP by name, and no file is written under the queue directory", async () => {
    seed(approved(journey("login")));
    const r = await call("queue_journey", { id: "login", params: { password: "x" } });
    expect(r).toMatchObject({ isError: true, body: { error: "invalid_args", code: "E_SECRET_PARAM_OVER_MCP", params: ["password"] } });
    expect(existsSync(queueDir)).toBe(false);
  });

  it("a param the Journey declares secret is refused by name, nothing written", async () => {
    seed(approved(journey("notes", { parameters: [{ name: "note", description: "a note", secret: true }] } as Partial<Journey["metadata"]>)));
    const r = await call("queue_journey", { id: "notes", params: { note: "hello" } });
    expect(r).toMatchObject({ isError: true, body: { code: "E_SECRET_PARAM_OVER_MCP", params: ["note"] } });
    expect(queued()).toEqual([]);
  });

  it("queues a promoted Journey bound to its content hash, with only id, hash, non-secret params and env", async () => {
    const j = approved(journey("notes"));
    seed(j);
    const r = await call("queue_journey", { id: "notes", params: { note: "hello" }, steps: [{ kind: "click" }] });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ ok: true, status: "queued", journey: { id: "notes", hash: journeyReviewHash(journey("notes")) } });
    const record = await new FsJourneyCallQueueStore(queueDir).get(String(r.body.callId));
    expect(record).toMatchObject({ status: "queued", call: { kind: "journey", journey: { id: "notes" }, params: { note: "hello" } } });
    expect(Object.keys(record!.call).sort()).toEqual(["journey", "kind", "params", "requestedAt"]);
  });

  it("refuses an unpromoted Journey as run_journey does (E_JOURNEY_NOT_PROMOTED), nothing written", async () => {
    seed(journey("draft"));
    const r = await call("queue_journey", { id: "draft" });
    expect(r).toMatchObject({ isError: true, body: { error: "refused", code: "E_JOURNEY_NOT_PROMOTED" } });
    expect(queued()).toEqual([]);
  });

  it("on an automation-mode target, refuses a Journey only an agent approved (E_APPROVAL_CHANNEL_FOR_MODE), nothing written", async () => {
    seed(approved(journey("agent"), "mcp"));
    const r = await call("queue_journey", { id: "agent" });
    expect(r).toMatchObject({ isError: true, body: { error: "refused", code: "E_APPROVAL_CHANNEL_FOR_MODE" } });
    expect(queued()).toEqual([]);
  });

  it("an unknown Journey is refused, nothing written", async () => {
    const r = await call("queue_journey", { id: "nope" });
    expect(r).toMatchObject({ isError: true, body: { code: "E_JOURNEY_APPROVAL_UNKNOWN" } });
    expect(queued()).toEqual([]);
  });
});

describe("0.30.0 #800 (GAPS 12) queue_exploration carries a job", () => {
  it("refuses a job on a strategy that is not goal-based with a goal, nothing queued", async () => {
    const r = await call("queue_exploration", { target: "t", strategy: "coverage", job: "checkout" });
    expect(r).toMatchObject({ isError: true, body: { error: "queue_exploration_refused" } });
    expect(String(r.body.message)).toMatch(/job is accepted only for strategy goal-based/);
  });
});

describe("0.30.0 #800 (GAPS 12) a queued goal mission's job is resolved when it runs", () => {
  it("an unknown job fails the mission (E_EXPLORE_JOB) before any browser opens", async () => {
    const { realQueuedMissionExecutor } = await import("./mission-queue-runner.js");
    const { UsageTracker } = await import("@jevitate/ai-core");
    const catalogDir = join(root, ".jevitate");
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(join(catalogDir, "jobs.json"), JSON.stringify({ jobs: [] }));
    let opened = 0;
    const execute = realQueuedMissionExecutor({
      outDir: join(root, "out"),
      authCheck: { mode: "off" },
      gateways: async () => ({ judge: {}, gen: {}, usage: new UsageTracker() }) as never,
      browserPortFactory: () => {
        opened += 1;
        throw new Error("a browser must not open");
      },
      catalogDir,
      journeysDir,
      targetsFile,
    });
    const mission = {
      id: "m1",
      status: "running",
      enqueuedAtIso: "2026-11-09T00:00:00.000Z",
      target: "t",
      strategy: "goal-based",
      goal: "save a note",
      successAssertion: { kind: "urlIncludes", text: "/done" },
      job: "no-such-job",
      budget: { maxActions: 5, maxDecisions: 5, maxCandidates: 5 },
    } as never;
    const target = { id: "t", name: "t", authorizedOrigin: ORIGIN, baseUrl: `${ORIGIN}/`, promoted: true, createdAtIso: "2026-11-09T00:00:00.000Z" };
    await expect(execute({ mission, target, allowlist: [ORIGIN] })).rejects.toThrow(/E_EXPLORE_JOB/);
    expect(opened).toBe(0);
  });
});

describe("0.30.0 #797 (GAPS 19) get_mission_result reads a queued Journey call by its callId", () => {
  const CALL = "journey-549db40a-cd30-4706-b7f5-01ddea8f6d1f";
  const record = (over: Record<string, unknown> = {}) => ({
    id: CALL,
    status: "queued",
    enqueuedAtIso: "2026-11-09T00:00:00.000Z",
    call: { kind: "journey", journey: { id: "notes", hash: "h1" }, params: { note: "hello" }, requestedAt: "2026-11-09T00:00:00.000Z" },
    ...over,
  });
  const put = async (r: Record<string, unknown>) => {
    mkdirSync(join(queueDir, "journeys"), { recursive: true });
    writeFileSync(join(queueDir, "journeys", `${CALL}.json`), JSON.stringify(r));
  };

  it("a queued call is pending (poll again), never a result", async () => {
    await put(record());
    expect(await call("get_mission_result", { id: CALL })).toEqual({
      isError: false,
      body: { id: CALL, callId: CALL, kind: "journey", journey: { id: "notes", hash: "h1" }, enqueuedAtIso: "2026-11-09T00:00:00.000Z", status: "queued", pending: true },
    });
  });

  it("a finished call reports its outcome, exit code and run id; a held one (exit 2) is an error result", async () => {
    await put(record({ status: "done", startedAtIso: "2026-11-09T00:00:01.000Z", finishedAtIso: "2026-11-09T00:00:02.000Z", outcome: "ok", exitCode: 0, runId: "2026-11-09T00-00-01-000Z-ab12cd34" }));
    expect(await call("get_mission_result", { id: CALL })).toMatchObject({ isError: false, body: { status: "ok", outcome: "ok", exitCode: 0, runId: "2026-11-09T00-00-01-000Z-ab12cd34", isError: false } });
    await put(record({ status: "done", outcome: "held", exitCode: 2, code: "E_RUN_HELD" }));
    expect(await call("get_mission_result", { id: CALL })).toMatchObject({ isError: true, body: { status: "held", exitCode: 2, code: "E_RUN_HELD", isError: true } });
  });

  it("a failed call is an error with its refusal code", async () => {
    await put(record({ status: "failed", code: "E_JOURNEY_APPROVAL_STALE", error: "journey 'notes' changed since this call was queued" }));
    expect(await call("get_mission_result", { id: CALL })).toMatchObject({ isError: true, body: { status: "failed", code: "E_JOURNEY_APPROVAL_STALE", isError: true } });
  });

  it("an unknown callId is not_found; a malformed one never reaches a path", async () => {
    expect(await call("get_mission_result", { id: CALL })).toMatchObject({ isError: true, body: { error: "not_found", id: CALL } });
    expect(await call("get_mission_result", { id: "journey-../../etc" })).toMatchObject({ isError: true, body: { error: "invalid_args" } });
  });

  it("MCP/CLI parity: `mission result <callId> --json` prints exactly get_mission_result's body and exits with its code", async () => {
    await put(record({ status: "failed", code: "E_JOURNEY_NOT_PROMOTED", error: "not promoted" }));
    const { buildProgram } = await import("./program.js");
    const { ProfileManager } = await import("@jevitate/daemon");
    const lines: string[] = [];
    const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), journeysDir });
    program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
    program.exitOverride();
    process.exitCode = 0;
    await program.parseAsync(["mission", "result", CALL, "--dir", queueDir, "--json"], { from: "user" });
    const exit = process.exitCode;
    process.exitCode = 0;
    expect(exit).toBe(2);
    expect(JSON.parse(lines.join("")).data).toEqual((await call("get_mission_result", { id: CALL })).body);
  });
});

describe("0.30.0 #797 (GAPS 20) a queued Journey call left `running` by a dead drain is recovered, never re-run", () => {
  it("records failed the calls whose drain died (same host, process gone; or unverifiable and past the orphan bound), keeps the rest", async () => {
    const { drainMissionQueue } = await import("./mission-queue-runner.js");
    const { FsMissionQueueStore } = await import("@jevitate/missions");
    const store = new FsJourneyCallQueueStore(queueDir);
    const self = { pid: 4001, host: "this-host" };
    const ids = { dead: "journey-00000000-0000-4000-8000-000000000001", alive: "journey-00000000-0000-4000-8000-000000000002", otherHostOld: "journey-00000000-0000-4000-8000-000000000003", otherHostNew: "journey-00000000-0000-4000-8000-000000000004" };
    const running = (id: string, startedAtIso: string) => ({
      id,
      status: "running" as const,
      enqueuedAtIso: "2026-11-09T00:00:00.000Z",
      startedAtIso,
      call: { kind: "journey" as const, journey: { id: "notes", hash: "h1" }, requestedAt: "2026-11-09T00:00:00.000Z" },
    });
    await store.enqueue(running(ids.dead, "2026-11-09T11:00:00.000Z"));
    await store.claim(ids.dead, { pid: 4002, host: "this-host", claimedAtIso: "2026-11-09T11:00:00.000Z" });
    await store.enqueue(running(ids.alive, "2026-11-09T11:00:00.000Z"));
    await store.claim(ids.alive, { pid: 4003, host: "this-host", claimedAtIso: "2026-11-09T11:00:00.000Z" });
    await store.enqueue(running(ids.otherHostOld, "2026-11-08T00:00:00.000Z"));
    await store.claim(ids.otherHostOld, { pid: 9, host: "other-host", claimedAtIso: "2026-11-08T00:00:00.000Z" });
    await store.enqueue(running(ids.otherHostNew, "2026-11-09T11:30:00.000Z"));
    await store.claim(ids.otherHostNew, { pid: 9, host: "other-host", claimedAtIso: "2026-11-09T11:30:00.000Z" });
    let executed = 0;
    const report = await drainMissionQueue({
      queue: new FsMissionQueueStore(join(root, "missions")),
      targets: { resolve: async () => { throw new Error("no missions here"); } } as never,
      execute: async () => { throw new Error("no missions here"); },
      journeyCalls: { store, execute: async () => { executed += 1; return { outcome: "ok", exitCode: 0 }; } },
      nowIso: () => "2026-11-09T12:00:00.000Z",
      owner: self,
      isAlive: (pid) => pid === 4003,
    });
    expect(report.journeysRecovered?.map((r) => r.callId).sort()).toEqual([ids.dead, ids.otherHostOld].sort());
    expect(report.journeys).toBeUndefined();
    expect(executed).toBe(0);
    expect(await store.get(ids.dead)).toMatchObject({ status: "failed", finishedAtIso: "2026-11-09T12:00:00.000Z", error: expect.stringMatching(/pid 4002 on this-host.*not re-run/) });
    expect(await store.get(ids.otherHostOld)).toMatchObject({ status: "failed", error: expect.stringMatching(/12h/) });
    expect((await store.get(ids.alive))?.status).toBe("running");
    expect((await store.get(ids.otherHostNew))?.status).toBe("running");
  });
});
