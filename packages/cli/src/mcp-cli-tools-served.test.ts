import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, flatJourneySteps, type Journey } from "@jevitate/journey";
import { FakeGenerationGateway, type Answer, type CredentialStore, type JudgmentPort } from "@jevitate/ai-core";
import { GOAL_ALREADY_MET_QUESTION, GOAL_MET_QUESTION } from "@jevitate/explore";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { CLI_TOOL_SPECS } from "./mcp-cli-tools.js";
import type { CliDeps } from "./cli-shared.js";

/**
 * #255 served e2e for the MCP tools that mirror a CLI command (mcp-cli-tools.ts): each runs the
 * real command in process against a served app and real Chromium, with deterministic fake gateways
 * (no real model). Covered: the Journey lifecycle (list → annotate draft → approve → promote →
 * demo), `demo "<aspect>"` → approve_demo, mission targets → queue_exploration →
 * run_queued_missions, read-only tools, and the MCP-side strictness: closed typed arguments,
 * confined paths, no argument value ever read as a flag, credentials redacted, stdout (the MCP
 * channel) never written, the process exit code untouched.
 */

const APP = `<!doctype html><html><head><title>Profile</title></head><body><main>
  <h1>Profile</h1>
  <button type="button" id="tips">Show tips</button>
  <div id="tipbox" hidden><p>Tip: a short name reads best.</p><button type="button" id="hide">Hide tips</button></div>
  <label>Display name <input id="name" aria-label="Display name"></label>
  <button type="button" id="save">Save</button>
  <p data-testid="status" role="status"></p>
  <script>
    const box = document.getElementById("tipbox");
    document.getElementById("tips").onclick = () => { box.hidden = false; };
    document.getElementById("hide").onclick = () => { box.hidden = true; };
    document.getElementById("save").onclick = () => {
      const v = document.getElementById("name").value.trim();
      document.querySelector("[data-testid=status]").textContent = v === "" ? "A display name is required" : "Saved " + v;
    };
  </script></main></body></html>`;

const SUCCESS = "textIncludes:testId=status|Saved";
const ASPECT = "Save your display name";
const SECRET_KEY = "sk-or-v1-served-secret-0123456789";

let server: Server;
let origin: string;
let root: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "jev-255-cli-tools-"));
  writeFileSync(join(root, "environments.json"), JSON.stringify({ staging: { baseUrl: origin }, prod: { baseUrl: origin, production: true } }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** Scripted judge: type the name, Save, done (and a detour through the tips panel first). */
function scriptedJudge(): JudgmentPort {
  const script = [/click .*Show tips/, /click .*Hide tips/, /type into .*Display name/, /click .*"Save"/];
  let at = 0;
  return {
    async systemOne({ questions }: { questions: Record<string, { kind: string; options?: string[]; descriptions?: Record<string, string> }> }) {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === "action" && q.kind === "choice") {
          const want = script[at];
          const pick = want === undefined ? "done" : (q.options ?? []).find((id) => want.test(q.descriptions?.[id] ?? ""));
          if (pick !== undefined && want !== undefined) at += 1;
          out[key] = { kind: "choice", value: pick ?? "wait", confidence: 0.9 };
        } else if (key === GOAL_MET_QUESTION) out[key] = { kind: "noul", value: true, probability: 0.95 };
        else if (key === GOAL_ALREADY_MET_QUESTION) out[key] = { kind: "noul", value: false, probability: 0.05 };
        else if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options?.[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  } as unknown as JudgmentPort;
}

function harness(name: string, over: Partial<CliDeps> = {}): { tool: (n: string) => McpTool; dirs: { journeys: string; targets: string; queue: string } } {
  const journeys = join(root, name, "journeys");
  const targets = join(root, name, "targets");
  const queue = join(root, name, "queue");
  const cliDeps: CliDeps = {
    profiles: new ProfileManager(join(root, name, "profiles")),
    journeysDir: journeys,
    missionTargetsDir: targets,
    dbPath: join(root, "no-site-policy.sqlite"),
    environmentsFile: join(root, "environments.json"),
    explore: { judge: scriptedJudge(), gen: new FakeGenerationGateway(), browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(root, "no-targets.json") },
    ...over,
  };
  const store: CredentialStore = { detect: () => true, read: () => SECRET_KEY };
  const deps: McpApiDeps = {
    journeysDir: journeys,
    missionTargetsDir: targets,
    missionQueueDir: queue,
    pathRoots: [root],
    credentialStore: store,
    runCli: makeInProcessCliRunner(() => buildProgram(cliDeps)),
  };
  const tools = new Map(buildMcpTools(deps).map((t) => [t.name, t]));
  return { tool: (n) => tools.get(n)!, dirs: { journeys, targets, queue } };
}

const body = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

async function seedJourney(dir: string, id: string, promoted = false): Promise<void> {
  const journey: Journey = {
    metadata: { id, name: "Save the display name", promoted, params: [], createdAtIso: "2026-09-29T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "Profile" } } } },
            { step: { kind: "fill", target: { label: "Display name" }, value: { redacted: false, value: "Ada" }, expect: { kind: "visible", target: { label: "Display name" } } } },
            { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { testId: "status" } } } },
          ],
        },
      ],
    },
  };
  await new FsJourneyStore(dir).put(journey);
}

describe("#255 CLI-mirroring MCP tools — the surface", () => {
  it("every spec is served, allowlisted, and closed (additionalProperties: false)", () => {
    const { tool } = harness("surface");
    for (const spec of CLI_TOOL_SPECS) {
      expect(ALLOWED_TOOLS as readonly string[]).toContain(spec.name);
      const t = tool(spec.name);
      expect(t, spec.name).toBeDefined();
      expect(t.inputSchema.additionalProperties, spec.name).toBe(false);
    }
  });

  it("without an in-process CLI the tools refuse with not_configured (never a fake success)", async () => {
    const t = buildMcpTools({ journeysDir: join(root, "none") }).find((x) => x.name === "list_journeys")!;
    const res = await t.handler({});
    expect(res.isError).toBe(true);
    expect(body(res)).toMatchObject({ error: "not_configured" });
  });
});

describe("#255 the Journey lifecycle over MCP", () => {
  it(
    "list → annotate (draft, then approve) → promote → demo (video + guide on disk)",
    async () => {
      const { tool, dirs } = harness("life");
      await seedJourney(dirs.journeys, "save-name");

      const list = await tool("list_journeys").handler({});
      expect(list.isError).toBeUndefined();
      expect(body(list)).toMatchObject({ exitCode: 0, data: [expect.objectContaining({ id: "save-name", promoted: false })] });

      // Draft: the Journey is untouched; approve applies it.
      const before = readFileSync(join(dirs.journeys, "save-name.json"), "utf8");
      const draft = await tool("annotate_journey").handler({ id: "save-name", fakeAi: true });
      expect(draft.isError, JSON.stringify(body(draft))).toBeUndefined();
      expect(readFileSync(join(dirs.journeys, "save-name.json"), "utf8")).toBe(before);
      const approved = await tool("annotate_journey").handler({ id: "save-name", approve: true });
      expect(approved.isError, JSON.stringify(body(approved))).toBeUndefined();
      const annotated = await new FsJourneyStore(dirs.journeys).get("save-name");
      expect(flatJourneySteps(annotated!).every((s) => (s.recorded.objective ?? "") !== "")).toBe(true);

      expect((await tool("promote_journey").handler({ id: "save-name" })).isError).toBeUndefined();
      expect((await new FsJourneyStore(dirs.journeys).get("save-name"))?.metadata.promoted).toBe(true);

      const video = join(root, "life", "out", "demo.webm");
      const guide = join(root, "life", "out", "guide.md");
      const demo = await tool("demo_journey").handler({ id: "save-name", video, guide, pace: 0 });
      expect(demo.isError, JSON.stringify(body(demo))).toBeUndefined();
      expect(body(demo).exitCode).toBe(0);
      expect(existsSync(video)).toBe(true);
      expect(existsSync(video.replace(/\.webm$/, ".vtt"))).toBe(true);
      expect(readFileSync(guide, "utf8")).toContain("Step 1 of");
    },
    300_000,
  );

  it(
    "create_demo drafts (nothing promoted); approve_demo promotes and renders the final demo; production is refused",
    async () => {
      const { tool, dirs } = harness("demo");
      const refused = await tool("create_demo").handler({ aspect: ASPECT, env: "prod", success: SUCCESS, fakeAi: true });
      expect(refused.isError).toBe(true);
      expect(body(refused)).toMatchObject({ error: "invalid_args", code: "E_DEMO_PRODUCTION_ENV", exitCode: 64 });

      const draftDir = join(root, "demo", "draft");
      const created = await tool("create_demo").handler({ aspect: ASPECT, env: "staging", success: SUCCESS, out: draftDir, pace: 0, fakeAi: true });
      const c = body(created);
      expect(created.isError, JSON.stringify(c)).toBeUndefined();
      const data = c.data as { id: string; outcome: string };
      expect(data.outcome).toBe("drafted");
      expect((await new FsJourneyStore(dirs.journeys).get(data.id))?.metadata.promoted).toBe(false);

      const finalDir = join(root, "demo", "final");
      const approved = await tool("approve_demo").handler({ id: data.id, out: finalDir, pace: 0 });
      expect(approved.isError, JSON.stringify(body(approved))).toBeUndefined();
      expect((await new FsJourneyStore(dirs.journeys).get(data.id))?.metadata.promoted).toBe(true);
      expect(readFileSync(join(finalDir, "guide.md"), "utf8")).not.toContain("DRAFT");
    },
    600_000,
  );
});

describe("#255 missions over MCP: targets → queue → drain", () => {
  it("mission_targets add + promote, queue_exploration, run_queued_missions drains it", async () => {
    const queueDir = join(root, "missions", "queue");
    {
      const executed: string[] = [];
      const { tool } = harness("missions", {
        missions: {
          queueDir,
          execute: async ({ mission }) => {
            executed.push(mission.id);
            return { resultPath: join(root, "missions", `coverage-2026-09-29T00-00-00-000Z.result.json`), missionOutcome: "clean", exitCode: 0 };
          },
        },
      });
      const add = await tool("mission_targets").handler({ action: "add", id: "profile", name: "Profile", authorizedOrigin: origin, baseUrl: `${origin}/` });
      expect(add.isError, JSON.stringify(body(add))).toBeUndefined();
      expect((await tool("mission_targets").handler({ action: "promote", id: "profile" })).isError).toBeUndefined();
      const listed = body(await tool("mission_targets").handler({ action: "list" }));
      expect(listed.data).toEqual([expect.objectContaining({ id: "profile", promoted: true })]);

      // queue_exploration (native) writes where `mission run` (CLI-backed) drains: the default queue.
      const queueTool = buildMcpTools({ journeysDir: join(root, "missions", "j"), missionTargetsDir: join(root, "missions", "targets"), missionQueueDir: queueDir }).find((t) => t.name === "queue_exploration")!;
      const queued = body(await queueTool.handler({ target: "profile", strategy: "coverage" }));
      expect(queued.missionId, JSON.stringify(queued)).toBeDefined();
      const drained = await tool("run_queued_missions").handler({ fakeAi: true });
      const d = body(drained);
      expect(drained.isError, JSON.stringify(d)).toBeUndefined();
      expect(executed, JSON.stringify(d)).toEqual([queued.missionId]);
      expect(executed).toEqual([queued.missionId]);
      expect((d.data as { ran: Array<{ status: string }> }).ran).toEqual([expect.objectContaining({ missionId: queued.missionId, status: "done" })]);
    }
  });
});

describe("#255 read-only and validation tools", () => {
  it("validate_invariants, get_ai_status (presence only), baselines list", async () => {
    const { tool } = harness("ro");
    const inv = join(root, "ro-inv.json");
    writeFileSync(inv, JSON.stringify({ observe: {}, invariants: {} }));
    const v = await tool("validate_invariants").handler({ files: [inv] });
    expect(body(v)).toHaveProperty("exitCode");
    // `verify: false` → `--no-verify` (#291): presence and source only, no live provider call in a test.
    const ai = await tool("get_ai_status").handler({ verify: false });
    expect(ai.isError, JSON.stringify(body(ai))).toBeUndefined();
    expect(JSON.stringify(body(ai))).not.toContain(SECRET_KEY);
    const bl = await tool("baselines").handler({ action: "list" });
    expect(bl.isError, JSON.stringify(body(bl))).toBeUndefined();
  });
});

describe("#255 MCP-side strictness on the CLI-mirroring tools", () => {
  it("closed typed arguments: unknown, wrongly typed, missing, bad action → invalid_args before anything runs", async () => {
    const { tool } = harness("strict");
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["list_journeys", { dir: "/tmp" }, /unknown argument.*dir/],
      ["promote_journey", {}, /'id' is required/],
      ["promote_journey", { id: 7 }, /non-empty string/],
      ["demo_journey", { id: "x", pace: -1 }, /non-negative integer/],
      ["demo_journey", { id: "x", headed: "true" }, /boolean/],
      ["annotate_journey", { id: "x", params: { a: 1 } }, /non-empty string/],
      ["run_exploration", { url: origin, strategy: "chaos" }, /one of goal/],
      ["baselines", { action: "delete" }, /'action' must be one of list \| show \| tag/],
      ["baselines", { action: "show" }, /'name' is required/],
      ["run_exploration", { url: origin, before: "rm -rf /" }, /unknown argument.*before/],
      ["run_exploration", { url: origin, secretField: ["label=x=env:HOME"] }, /unknown argument/],
      ["run_exploration", { url: origin, persona: ["admin"] }, /name=<storageState path>/],
    ];
    for (const [name, args, message] of cases) {
      const res = await tool(name).handler(args);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(body(res), `${name} ${JSON.stringify(args)}`).toMatchObject({ error: "invalid_args", message: expect.stringMatching(message) });
    }
  });

  it("paths are confined: outside the roots, `..` escapes and a storage state under a repo's .jevitate/ are refused", async () => {
    const { tool } = harness("paths");
    await mkdir(join(root, "app", ".jevitate"), { recursive: true });
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["demo_journey", { id: "x", video: "/tmp/../etc/demo.webm" }, /resolves outside/],
      ["demo_journey", { id: "x", guide: join(root, "..", "guide.md") }, /resolves outside/],
      ["run_check", { suite: "/etc/passwd" }, /resolves outside/],
      ["run_exploration", { url: origin, storageState: join(root, "app", ".jevitate", "s.json") }, /never holds storage states/],
      ["run_exploration", { url: origin, persona: [`admin=${join(root, "app", ".jevitate", "a.json")}`] }, /never holds storage states/],
      ["run_exploration", { url: origin, recordVideo: "/var/tmp/v" }, /resolves outside/],
      ["recordings", { action: "fit", file: "/etc/hosts" }, /resolves outside/],
    ];
    for (const [name, args, message] of cases) {
      const res = await tool(name).handler(args);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(body(res), `${name} ${JSON.stringify(args)}`).toMatchObject({ error: "invalid_args", message: expect.stringMatching(message) });
    }
  });

  it("no argument value is ever read as a flag: a flag-shaped id stays an id", async () => {
    const { tool } = harness("inject");
    const res = await tool("promote_journey").handler({ id: "--allow-shell-hooks" });
    expect(res.isError).toBe(true);
    // Refused by the CLI as an unsafe Journey ID — it never reached commander as an option.
    expect(body(res)).toMatchObject({ error: "refused", code: "E_JOURNEY_PROMOTE", message: expect.stringMatching(/Invalid journey id.*--allow-shell-hooks/) });
  });

  it("credential values are redacted from what a tool returns; stdout and the process exit code are untouched", async () => {
    const { tool } = harness("redact");
    const writes: unknown[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(chunk);
      return true;
    });
    process.exitCode = undefined;
    try {
      const [a, b2] = await Promise.all([tool("promote_journey").handler({ id: SECRET_KEY }), tool("list_journeys").handler({})]);
      expect(a.isError).toBe(true);
      expect(a.content[0]!.text).not.toContain(SECRET_KEY);
      expect(a.content[0]!.text).toContain("***REDACTED***");
      expect(b2.isError).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(writes).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("human-only approvals still refuse over MCP", async () => {
    const { tool } = harness("human");
    const res = await buildMcpTools({ journeysDir: join(root, "human") }).find((t) => t.name === "approve_action")!.handler({ id: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("human_approval_required");
    expect(tool("approve_action")).toBeDefined();
  });
});
