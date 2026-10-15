import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, journeyProofHash, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { journeyReviewHash } from "./journey-review.js";
import { writeVerifyRecord } from "./journey-review-store.js";
import type { CliDeps } from "./cli-shared.js";

/** #523 — `jevitate journey link` / MCP `journey_link`: set or clear a Journey's catalog job / persona link. No browser. */

function journey(id: string, overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id,
      name: `Journey ${id}`,
      promoted: false,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/editor",
          steps: [
            {
              step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/publish", status: { class: 2 } }],
            },
          ],
        },
      ],
    },
  };
}

let root: string;
let catalogDir: string;
let journeysDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-523-link-"));
  catalogDir = join(root, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(catalogDir, { recursive: true });
  await writeFile(join(catalogDir, "editor.json"), "{}");
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ name: "editor", description: "writes and publishes posts", role: "editor", storageState: "editor.json" }]));
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([{ id: "publish-post", trigger: "a draft is ready", motivation: "publish it", outcome: "readers see it", personas: ["editor"] }]));
  await new FsJourneyStore(journeysDir).put(journey("loose", { persona: "someone browsing", anchors: [{ name: "published", step: 1 }] }));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-15T12:00:00.000Z") }));
});

afterEach(async () => {
  resetClock();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

const NOT_A_TTY = { env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false, user: () => "tester" };

function deps(): CliDeps {
  return { profiles: new ProfileManager(join(root, "profiles")), journeysDir, catalogDir, explore: { targetsConfigPath: join(root, "no-targets.json") }, approval: NOT_A_TTY };
}

async function cli(argv: readonly string[]): Promise<{ out: string; json: any; code: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram(deps());
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync([...argv], { from: "user" });
  const out = lines.join("");
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { out, json, code: process.exitCode === undefined ? undefined : Number(process.exitCode) };
}

const stored = async (id: string): Promise<Journey> => (await new FsJourneyStore(journeysDir).get(id))!;

/** Approves the persona and job, then promotes `loose` linked to them. */
async function promoteLinked(): Promise<void> {
  await cli(["persona", "approve", "editor", "--json", "--non-interactive-approval", "test"]);
  await cli(["job", "approve", "publish-post", "--json", "--non-interactive-approval", "test"]);
  await cli(["journey", "link", "loose", "--job", "publish-post", "--persona", "editor", "--json"]);
  await cli(["journey", "promote", "loose", "--json", "--non-interactive-approval", "test"]);
}

describe("#523 journey link", () => {
  it("sets metadata.job", async () => {
    await cli(["journey", "link", "loose", "--job", "publish-post", "--json"]);
    expect((await stored("loose")).metadata.job).toBe("publish-post");
  });

  it("sets metadata.persona", async () => {
    await cli(["journey", "link", "loose", "--persona", "editor", "--json"]);
    expect((await stored("loose")).metadata.persona).toBe("editor");
  });

  it("refuses an unknown job with exit 64, listing the catalog's job ids", async () => {
    const r = await cli(["journey", "link", "loose", "--job", "nope", "--json"]);
    expect([r.code, r.json.error.code, r.json.error.message.includes("the catalog's jobs: publish-post")]).toEqual([64, "E_JOURNEY_LINK_ARGS", true]);
  });

  it("links a draft entry and says it still needs a person's approval", async () => {
    await cli(["catalog", "draft", "job", "archive-post", "--name", "archive an old post", "--json"]);
    expect((await cli(["journey", "link", "loose", "--job", "archive-post"])).out).toContain("needs approval: job 'archive-post' is a draft (never approved)");
  });

  it("--unlink-job / --unlink-persona clear the links", async () => {
    await cli(["journey", "link", "loose", "--job", "publish-post", "--persona", "editor", "--json"]);
    await cli(["journey", "link", "loose", "--unlink-job", "--unlink-persona", "--json"]);
    const m = (await stored("loose")).metadata;
    expect([m.job, m.persona]).toEqual([undefined, undefined]);
  });

  it("on a promoted Journey the approval goes stale and the re-approve hint is printed", async () => {
    await promoteLinked();
    const out = (await cli(["journey", "link", "loose", "--unlink-persona"])).out;
    expect(out).toContain(`re-approve after review: jevitate journey promote loose --reviewed-hash ${journeyReviewHash(await stored("loose"))}`);
  });

  it("a link change does not stale the mutation proof", async () => {
    const before = await stored("loose");
    await writeVerifyRecord(journeysDir, { journeyId: "loose", contentHash: journeyReviewHash(before), proofHash: journeyProofHash(before), verdict: "proven", summary: {}, at: "2026-10-15T12:00:00.000Z" });
    await cli(["journey", "link", "loose", "--job", "publish-post", "--persona", "editor", "--json"]);
    expect((await cli(["journey", "review", "loose", "--json"])).json.data.proof.verify).toMatchObject({ status: "recorded", stale: false });
  });

  it("MCP journey_link sets the same link the CLI does", async () => {
    const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps())) };
    await buildMcpTools(mcpDeps).find((t) => t.name === "journey_link")!.handler({ id: "loose", job: "publish-post", persona: "editor" });
    const m = (await stored("loose")).metadata;
    expect([m.job, m.persona]).toEqual(["publish-post", "editor"]);
  });

  it("journey lint's missing-job fix now prints journey link first", async () => {
    const findings = (await cli(["journey", "lint", "loose", "--json"])).json.data.findings as { rule: string; fix: string }[];
    expect(findings.find((f) => f.rule === "missing-job")!.fix).toMatch(/^jevitate journey link loose --job <job-id> — an existing job \(publish-post\)/);
  });
});
