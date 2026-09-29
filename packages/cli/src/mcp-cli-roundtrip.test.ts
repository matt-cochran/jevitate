import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsInboxStore } from "@jevitate/inbox";
import { FsMissionQueueStore, FsMissionTargetStore, MissionTargetRegistry } from "@jevitate/missions";
import { buildProgram, type CliDeps } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";

/**
 * #254 — the CLI's `inbox …`, `mission queue` and `mission result` against the REAL stores and the
 * REAL MCP handlers (`buildMcpTools`), with round trips both ways: what the CLI queues is visible to
 * MCP, what MCP queues is visible to the CLI, and the CLI never prints more than MCP returns (nor a
 * secret value). No browser, no model, no network.
 */

interface Env {
  readonly root: string;
  readonly inboxDir: string;
  readonly targetsDir: string;
  readonly queueDir: string;
  readonly resultsDir: string;
}

function env(): Env {
  const root = mkdtempSync(join(tmpdir(), "jev-mcp-cli-"));
  return { root, inboxDir: join(root, "inbox"), targetsDir: join(root, "targets"), queueDir: join(root, "queue"), resultsDir: join(root, "results") };
}

function mcp(e: Env): Map<string, (args: Record<string, unknown>) => Promise<{ isError: boolean; body: any }>> {
  const deps: McpApiDeps = {
    journeysDir: join(e.root, "journeys"),
    inboxDir: e.inboxDir,
    missionTargetsDir: e.targetsDir,
    missionQueueDir: e.queueDir,
    recordingsDir: e.resultsDir,
    resultDirsFor: () => [e.resultsDir],
  };
  return new Map(
    buildMcpTools(deps).map((t) => [
      t.name,
      async (args: Record<string, unknown>) => {
        const r = await t.handler(args);
        return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
      },
    ]),
  );
}

async function cli(e: Env, argv: readonly string[]): Promise<{ code: number; out: string; err: string; json: any }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: CliDeps = { profiles: new ProfileManager(join(e.root, "profiles")), inboxDir: e.inboxDir, missionTargetsDir: e.targetsDir };
  const program = buildProgram(deps);
  program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  let code = 0;
  try {
    await program.parseAsync([...argv], { from: "user" });
    code = process.exitCode === undefined ? 0 : Number(process.exitCode);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    code = err.exitCode;
  }
  const out = stdout.join("");
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { code, out, err: stderr.join(""), json };
}

const QUEUE_ARGS = ["--run", "run-1", "--journey", "checkout", "--step", "pay", "--reason", "needs a card", "--agent", "bot"];

afterEach(() => {
  process.exitCode = undefined;
});

describe("#254 inbox: CLI ↔ MCP round trips", { timeout: 30_000 }, () => {
  it("queue-action via CLI → visible to MCP list_incoming / get_thread / get_site_health", async () => {
    const e = env();
    const q = await cli(e, ["inbox", "queue-action", ...QUEUE_ARGS, "--kind", "review", "--inbox-dir", e.inboxDir, "--json"]);
    expect(q.code).toBe(0);
    expect(q.json).toMatchObject({ v: 1, ok: true, data: { status: "pending" } });
    const id = q.json.data.id as string;
    expect(id).toMatch(/^review-run-1-/);

    const tools = mcp(e);
    const listed = await tools.get("list_incoming")!({});
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect((await tools.get("get_thread")!({ id })).body).toEqual({ thread: [] });
    expect((await tools.get("get_site_health")!({})).body).toMatchObject({ ok: true, pending: 1 });
  });

  it("queue_retrieval via MCP → visible to the CLI's list / show / health, which print exactly MCP's body", async () => {
    const e = env();
    const tools = mcp(e);
    const queued = await tools.get("queue_retrieval")!({ run: "r", journey: "j", step: "s", reason: "why", agent: "a" });
    const id = queued.body.id as string;

    const list = await cli(e, ["inbox", "list", "--json"]);
    expect(list.code).toBe(0);
    const mcpList = (await tools.get("list_incoming")!({})).body;
    // ageSec is computed at call time — compare everything else verbatim.
    const strip = (items: Array<Record<string, unknown>>) => items.map(({ ageSec: _a, ...rest }) => rest);
    expect(strip(list.json.data.items)).toEqual(strip(mcpList.items));
    expect(list.json.data.items[0]).toMatchObject({ id, kind: "handback", status: "pending" });

    const human = await cli(e, ["inbox", "list"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain(id);
    expect(human.out).not.toMatch(/^\{/m);

    const show = await cli(e, ["inbox", "show", id, "--json"]);
    expect(show.json).toEqual({ v: 1, ok: true, data: (await tools.get("get_thread")!({ id })).body });

    const health = await cli(e, ["inbox", "health", "--json"]);
    expect(health.json.data).toMatchObject({ ok: true, pending: 1, version: expect.any(String) });
    expect((await cli(e, ["inbox", "health"])).out).toMatch(/^inbox ok: 1 pending/);
  });

  it("get_command via CLI keeps burn-after-read, and never prints the secret value", async () => {
    const e = env();
    const tools = mcp(e);
    const id = (await tools.get("queue_retrieval")!({ run: "r", journey: "j", step: "s", reason: "otp", agent: "a" })).body.id as string;
    // A human answers in the dashboard (the only channel that may resolve).
    await new FsInboxStore(e.inboxDir).resolve(id, { channel: "human", action: "resume", input: "the-secret-otp" });

    const first = await cli(e, ["inbox", "command", id, "--json"]);
    expect(first.code).toBe(0);
    expect(first.out).not.toContain("the-secret-otp");
    expect(first.json.data).toMatchObject({ id, status: "resolved", humanInput: "***REDACTED***" });

    // Burned: MCP's own poll no longer gets it — the CLI consumed it exactly like get_command does.
    const after = (await tools.get("get_command")!({ id })).body;
    expect(after.humanInput).toBeUndefined();
    expect(after.secretConsumedAt).toEqual(expect.any(String));
    const again = await cli(e, ["inbox", "command", id]);
    expect(again.out).toContain("already consumed");
    expect(again.out).not.toContain("the-secret-otp");
    // Never more than MCP returns: the same keys (the value withheld).
    expect(Object.keys((await cli(e, ["inbox", "command", id, "--json"])).json.data).sort()).toEqual(Object.keys(after).sort());
  });

  it("refusals mirror MCP: unknown id 64 (E_INBOX_NOT_FOUND), bad args 64, approve/cancel human-only 64", async () => {
    const e = env();
    const nf = await cli(e, ["inbox", "command", "nope", "--json"]);
    expect(nf.code).toBe(64);
    expect(nf.json).toMatchObject({ ok: false, error: { code: "E_INBOX_NOT_FOUND" } });
    const showNf = await cli(e, ["inbox", "show", "nope"]);
    expect(showNf.code).toBe(64);
    expect(showNf.err).toMatch(/^error E_INBOX_NOT_FOUND/);

    const bad = await cli(e, ["inbox", "queue-retrieval", "--run", "r", "--json"]);
    expect(bad.code).toBe(64);
    expect(bad.json.error.code).toBe("E_INBOX_QUEUE_RETRIEVAL_ARGS");
    expect(bad.json.error.message).toMatch(/'journey' must be a non-empty string/);

    const badFindings = join(e.root, "findings.json");
    writeFileSync(badFindings, JSON.stringify([{ id: "f", title: "t", severity: "critical" }]));
    const bf = await cli(e, ["inbox", "queue-action", ...QUEUE_ARGS, "--findings", badFindings, "--json"]);
    expect(bf.code).toBe(64);
    expect(bf.json.error.code).toBe("E_INBOX_QUEUE_ACTION_ARGS");

    const tools = mcp(e);
    const id = (await tools.get("queue_action")!({ run: "r", journey: "j", step: "s", reason: "why", agent: "a" })).body.id as string;
    for (const [sub, tool] of [["approve", "approve_action"], ["cancel", "cancel_command"]] as const) {
      const r = await cli(e, ["inbox", sub, id, "--json"]);
      expect(r.code).toBe(64);
      expect(r.json).toMatchObject({ ok: false, error: { code: "E_HUMAN_APPROVAL_REQUIRED" } });
      expect(r.json.error.message).toContain("jevitate ui");
      const viaMcp = await tools.get(tool)!({ id });
      expect(viaMcp).toMatchObject({ isError: true, body: { error: "human_approval_required" } });
    }
    // Nothing was resolved.
    expect((await tools.get("list_incoming")!({})).body.items).toHaveLength(1);
  });
});

async function promotedTarget(e: Env, id = "acme"): Promise<void> {
  const reg = new MissionTargetRegistry(new FsMissionTargetStore(e.targetsDir));
  await reg.put({ id, name: "Acme", authorizedOrigin: "http://127.0.0.1:3999", baseUrl: "http://127.0.0.1:3999/app", promoted: true, createdAtIso: "2026-09-29T00:00:00Z" });
}

describe("#254 mission queue / result: CLI ↔ MCP round trips", { timeout: 30_000 }, () => {
  it("mission queue via CLI → MCP get_mission_result reports it queued; the queued request is what MCP would have sent", async () => {
    const e = env();
    await promotedTarget(e);
    const inv = join(e.root, "inv.json");
    writeFileSync(inv, JSON.stringify({ observe: { balance: { dom: { selector: "[data-testid=balance]", number: true } } }, invariants: [{ id: "no-negative", require: "balance >= 0" }] }));
    const q = await cli(e, [
      "mission", "queue", "acme", "--strategy", "goal-based", "--goal", "sign up", "--success", "urlIncludes:/welcome",
      "--max-actions", "7", "--invariants", inv, "--viewport", "375x812", "--dir", e.queueDir, "--json",
    ]);
    expect(q.code, q.out + q.err).toBe(0);
    expect(q.json).toMatchObject({ ok: true, data: { ok: true, status: "queued", missionId: expect.any(String) } });
    const missionId = q.json.data.missionId as string;

    const stored = await new FsMissionQueueStore(e.queueDir).get(missionId);
    expect(stored).toMatchObject({
      target: "acme",
      strategy: "goal-based",
      goal: "sign up",
      successAssertion: { kind: "urlIncludes", text: "/welcome" },
      budget: { maxActions: 7 },
      viewport: { width: 375, height: 812 },
      invariants: { invariants: [{ id: "no-negative", require: "balance >= 0" }] },
    });

    const viaMcp = await mcp(e).get("get_mission_result")!({ id: missionId });
    expect(viaMcp).toMatchObject({ isError: false, body: { status: "queued", pending: true } });
  });

  it("queue_exploration via MCP → CLI mission result: pending is exit 2 (proves nothing yet), the body is MCP's", async () => {
    const e = env();
    await promotedTarget(e);
    const tools = mcp(e);
    const missionId = (await tools.get("queue_exploration")!({ target: "acme", strategy: "coverage" })).body.missionId as string;

    const r = await cli(e, ["mission", "result", missionId, "--dir", e.queueDir, "--json"]);
    expect(r.code).toBe(2);
    expect(r.json).toEqual({ v: 1, ok: true, data: (await tools.get("get_mission_result")!({ id: missionId })).body });
    const human = await cli(e, ["mission", "result", missionId, "--dir", e.queueDir]);
    expect(human.out).toMatch(/^QUEUED {2}/);
    expect(human.out).toContain("jevitate mission run");
  });

  it("a finished mission: same status / exitCode / coverage fields as MCP, and the contract exit code", async () => {
    const e = env();
    await promotedTarget(e);
    const tools = mcp(e);
    const missionId = (await tools.get("queue_exploration")!({ target: "acme", strategy: "adversarial" })).body.missionId as string;
    const resultId = "adversarial-2026-09-23T00-00-00-000Z";
    const coverage = { controls: { exercised: 3, total: 4 }, formsSubmitted: 1 };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(e.resultsDir, { recursive: true });
    writeFileSync(
      join(e.resultsDir, `${resultId}.result.json`),
      JSON.stringify({ missionOutcome: "defects-found", exitCode: 1, result: { strategy: "adversarial", defects: [{ fingerprint: "0123456789abcdef" }], coverage } }),
    );
    const queue = new FsMissionQueueStore(e.queueDir);
    const m = (await queue.get(missionId))!;
    await queue.update({ ...m, status: "done", resultId });

    for (const id of [missionId, resultId]) {
      const r = await cli(e, ["mission", "result", id, "--dir", e.queueDir, "--results-dir", e.resultsDir, "--json"]);
      const viaMcp = await tools.get("get_mission_result")!({ id });
      expect(r.code).toBe(1);
      expect(r.json.data).toEqual(viaMcp.body);
      expect(r.json.data).toMatchObject({ status: "defects-found", exitCode: 1, isError: false, coverage });
    }
    const human = await cli(e, ["mission", "result", resultId, "--results-dir", e.resultsDir]);
    expect(human.code).toBe(1);
    expect(human.out).toMatch(/^DEFECTS-FOUND {2}adversarial-/);
    expect(human.out).toContain("defects: 1");
  });

  it("refusals: unpromoted target / missing strategy / bad invariants 64; unknown result 64; broken run exits 2", async () => {
    const e = env();
    const unpromoted = await cli(e, ["mission", "queue", "ghost", "--strategy", "coverage", "--dir", e.queueDir, "--json"]);
    expect(unpromoted.code).toBe(64);
    expect(unpromoted.json.error.code).toBe("E_MISSION_QUEUE_REFUSED");
    expect((await cli(e, ["mission", "queue", "acme", "--dir", e.queueDir])).code).toBe(64);
    await promotedTarget(e);
    const inv = join(e.root, "bad-inv.json");
    writeFileSync(inv, JSON.stringify({ invariants: [{ never: "nope ==" }], extra: true }));
    const badInv = await cli(e, ["mission", "queue", "acme", "--strategy", "coverage", "--invariants", inv, "--dir", e.queueDir, "--json"]);
    expect(badInv.code).toBe(64);
    expect(badInv.json.error.code).toBe("E_MISSION_QUEUE_REFUSED");
    expect((await cli(e, ["mission", "queue", "acme", "--strategy", "coverage", "--invariants", join(e.root, "missing.json"), "--dir", e.queueDir])).code).toBe(64);

    const nf = await cli(e, ["mission", "result", "explore-2026-01-01T00-00-00-000Z", "--results-dir", e.resultsDir, "--json"]);
    expect(nf.code).toBe(64);
    expect(nf.json.error.code).toBe("E_MISSION_RESULT_NOT_FOUND");
    expect((await cli(e, ["mission", "result", "../etc/passwd"])).code).toBe(64);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(e.resultsDir, { recursive: true });
    writeFileSync(join(e.resultsDir, "coverage-2026-01-01T00-00-00-000Z.result.json"), JSON.stringify({ missionOutcome: "inconclusive", result: {} }));
    const broken = await cli(e, ["mission", "result", "coverage-2026-01-01T00-00-00-000Z", "--results-dir", e.resultsDir, "--json"]);
    expect(broken.code).toBe(2);
    expect(broken.json.data).toMatchObject({ status: "inconclusive", exitCode: 2, isError: true });
  });
});
