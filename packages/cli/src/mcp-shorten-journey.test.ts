import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";

/**
 * 0.30.0 #801 (owner decision): MCP `shorten_journey` is `journey shorten` over MCP. Every refusal here
 * comes before any replay or browser: a secret param by name (E_SECRET_PARAM_OVER_MCP), a promoted
 * Journey (E_JOURNEY_SHORTEN_PROMOTED), and run_journey's run-mode gate (an unapproved draft on an
 * automation-mode target, E_APPROVAL_CHANNEL_FOR_MODE). The site is unreachable (port 9): a browser
 * that opened would fail differently.
 */
const ORIGIN = "http://127.0.0.1:9";

let root: string;
let journeysDir: string;
let projectDir: string;
let targetsFile: string;

const journey = (id: string, metadata: Partial<Journey["metadata"]> = {}): Journey =>
  ({
    metadata: { id, name: id, promoted: false, params: ["note"], createdAtIso: "2026-11-09T00:00:00.000Z", ...metadata },
    recording: {
      version: "1",
      site: ORIGIN,
      pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "note" } } } }, { step: { kind: "fill", target: { testId: "note" }, value: { var: "note" }, expect: { kind: "visible", target: { testId: "note" } } } }] }],
    },
  }) as unknown as Journey;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "jev-801-mcp-"));
  journeysDir = join(root, "journeys");
  projectDir = join(root, ".jevitate");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "jobs.json"), JSON.stringify({ jobs: [{ id: "save-note", trigger: "t", motivation: "m", outcome: "o", done: { version: 1, at: "/", check: "visible:testId=saved" } }] }));
  targetsFile = join(root, "targets.json");
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey("draft"));
  const saved = (await store.get("draft"))!;
  await store.put({ ...saved, metadata: { ...saved.metadata, id: "promoted", promoted: true, approval: { contentHash: journeyReviewHash(saved), at: "2026-11-09T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (): McpApiDeps => {
  const cli = () =>
    buildProgram({ profiles: new ProfileManager("/unused"), journeysDir, catalogDir: projectDir, logs: { autoPrune: false, logsRoot: join(root, "logs") }, explore: { targetsConfigPath: targetsFile } });
  return { journeysDir, pathRoots: [root], catalogDir: projectDir, targetsConfigPath: targetsFile, runCli: makeInProcessCliRunner(cli) };
};

async function call(args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const tool = buildMcpTools(deps()).find((t) => t.name === "shorten_journey")!;
  const r = await tool.handler(args);
  return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as Record<string, unknown> };
}

describe("0.30.0 #801 shorten_journey over MCP", () => {
  it("is served, mirroring journey shorten's arguments", () => {
    const tool = buildMcpTools({ journeysDir: "/unused" }).find((t) => t.name === "shorten_journey")!;
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["budget", "fixtureIdentity", "fixtures", "id", "job", "outId", "params", "storageState"]);
    expect(tool.description).toMatch(/shortest found within budget/);
  });

  it("refuses a secret param by name, never its value, before anything runs", async () => {
    const r = await call({ id: "draft", job: "save-note", params: { password: "hunter2-value" } });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: "invalid_args", code: "E_SECRET_PARAM_OVER_MCP" });
    expect(JSON.stringify(r.body)).not.toContain("hunter2-value");
  });

  it("refuses a promoted Journey", async () => {
    writeFileSync(targetsFile, JSON.stringify({ [ORIGIN]: { trust: "test" } }));
    const r = await call({ id: "promoted", job: "save-note", params: { note: "x" } });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ code: "E_JOURNEY_SHORTEN_PROMOTED" });
    expect(await new FsJourneyStore(journeysDir).get("promoted-shortest")).toBeNull();
  });

  it("runs under run_journey's run-mode gate: an unapproved draft on an automation-mode target is refused before any replay", async () => {
    writeFileSync(targetsFile, "{}");
    const r = await call({ id: "draft", job: "save-note", params: { note: "x" } });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ code: "E_APPROVAL_CHANNEL_FOR_MODE" });
    expect(await new FsJourneyStore(journeysDir).get("draft-shortest")).toBeNull();
  });
});
