import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, JourneyReviewSchema, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { approvedSnapshotPath } from "./journey-review-store.js";
import type { CliDeps } from "./cli-shared.js";

/** #432 — `journey review`, the promote sign-off binding, and MCP `review_journey`. No browser. */

const SECRET_LITERAL = "s3cret-literal-value";

function strongJourney(id = "strong", overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id,
      name: "Publish",
      promoted: false,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
      secretRefs: [{ manager: "env", key: "PUBLISH_TOKEN_ENV", origin: "https://example.test", field: "token" }],
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/editor",
          steps: [
            { step: { kind: "fill", target: { label: "Access token" }, value: { redacted: false, value: SECRET_LITERAL }, expect: { kind: "textIncludes", target: { role: "status", name: "Publication status" }, text: "ready" } } },
            {
              stepId: "s-haxfhr",
              step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status", name: "Publication status" }, text: "Published" } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/publish", status: { class: 2 } }],
            },
          ],
        },
      ],
    },
  };
}

let root: string;
let journeysDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-432-"));
  journeysDir = join(root, "journeys");
  await new FsJourneyStore(journeysDir).put(strongJourney());
  installClock(new FakeClock({ startMs: Date.parse("2026-10-08T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
});

function deps(): CliDeps {
  // #437: approvals here run without a terminal (`--non-interactive-approval "test"`), in a fixed environment.
  return {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    explore: { targetsConfigPath: join(root, "no-targets.json") },
    approval: { env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false, user: () => "tester" },
  };
}

async function cli(argv: readonly string[]): Promise<{ out: string; json: any }> {
  const lines: string[] = [];
  const program = buildProgram(deps());
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  await program.parseAsync([...argv], { from: "user" });
  const out = lines.join("");
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { out, json };
}

async function reviewedHash(): Promise<string> {
  return (await cli(["journey", "review", "strong", "--json"])).json.data.contentHash as string;
}

describe("#432 journey review", () => {
  it("--json emits the schema-checked sheet", async () => {
    const { json } = await cli(["journey", "review", "strong", "--json"]);
    expect(JourneyReviewSchema.safeParse(json.data).success).toBe(true);
  });

  it("the human sheet covers every section", async () => {
    const { out } = await cli(["journey", "review", "strong"]);
    for (const h of ["NEEDS YOUR ATTENTION", "WHAT IT DOES", "STEPS", "WRITES", "INPUTS", "PROVES AT THE END", "APPROVE", "Content hash:"]) expect(out).toContain(h);
  });

  it("--markdown --out writes a Markdown sheet that names its hash", async () => {
    const file = join(root, "sheet.md");
    await cli(["journey", "review", "strong", "--markdown", "--out", file]);
    expect(await readFile(file, "utf8")).toContain(`Content hash: \`${await reviewedHash()}\``);
  });

  it("never shows a secret value or a secret-manager key", async () => {
    const { out } = await cli(["journey", "review", "strong", "--json"]);
    expect(out.includes(SECRET_LITERAL) || out.includes("PUBLISH_TOKEN_ENV")).toBe(false);
  });

  it("an unknown id is E_UNKNOWN_JOURNEY", async () => {
    expect((await cli(["journey", "review", "nope", "--json"])).json.error.code).toBe("E_UNKNOWN_JOURNEY");
  });

  it("--json with --markdown is refused", async () => {
    expect((await cli(["journey", "review", "strong", "--json", "--markdown"])).json.error.code).toBe("E_JOURNEY_REVIEW_ARGS");
  });
});

describe("#432 journey promote sign-off", () => {
  it("records the approval (content hash and time)", async () => {
    const hash = await reviewedHash();
    await cli(["journey", "promote", "strong", "--json", "--non-interactive-approval", "test"]);
    expect((await new FsJourneyStore(journeysDir).get("strong"))?.metadata.approval).toEqual({
      contentHash: hash,
      at: "2026-10-08T12:00:00.000Z",
      provenance: { channel: "non-interactive", agentSignals: ["stdin-not-tty", "stdout-not-tty"], user: "tester", reason: "test" },
    });
  });

  it("keeps a snapshot of the approved Journey", async () => {
    await cli(["journey", "promote", "strong", "--json", "--non-interactive-approval", "test"]);
    expect(existsSync(approvedSnapshotPath(journeysDir, "strong"))).toBe(true);
  });

  it("a later review is unchanged since that approval", async () => {
    await cli(["journey", "promote", "strong", "--json", "--non-interactive-approval", "test"]);
    expect((await cli(["journey", "review", "strong", "--json"])).json.data.changeSinceApproval).toMatchObject({ kind: "diff", changed: false });
  });

  it("refuses a reviewed hash the Journey no longer has (E_JOURNEY_REVIEW_STALE)", async () => {
    const hash = await reviewedHash();
    await new FsJourneyStore(journeysDir).put(strongJourney("strong", { description: "edited after review" }));
    expect((await cli(["journey", "promote", "strong", "--reviewed-hash", hash, "--json", "--non-interactive-approval", "test"])).json.error.code).toBe("E_JOURNEY_REVIEW_STALE");
  });

  it("a stale review promotes nothing", async () => {
    const hash = await reviewedHash();
    await new FsJourneyStore(journeysDir).put(strongJourney("strong", { description: "edited after review" }));
    await cli(["journey", "promote", "strong", "--reviewed-hash", hash, "--json", "--non-interactive-approval", "test"]);
    expect((await new FsJourneyStore(journeysDir).get("strong"))?.metadata.promoted).toBe(false);
  });

  it("accepts the current reviewed hash", async () => {
    const hash = await reviewedHash();
    expect((await cli(["journey", "promote", "strong", "--reviewed-hash", hash, "--json", "--non-interactive-approval", "test"])).json.data.approval.contentHash).toBe(hash);
  });

  it("--review-sheet binds to the sheet file's hash", async () => {
    const file = join(root, "sheet.json");
    await cli(["journey", "review", "strong", "--json", "--out", file]);
    await new FsJourneyStore(journeysDir).put(strongJourney("strong", { description: "edited after review" }));
    expect((await cli(["journey", "promote", "strong", "--review-sheet", file, "--json", "--non-interactive-approval", "test"])).json.error.code).toBe("E_JOURNEY_REVIEW_STALE");
  });

  it("a review sheet naming no hash is refused", async () => {
    const file = join(root, "empty.md");
    await writeFile(file, "# not a sheet\n");
    expect((await cli(["journey", "promote", "strong", "--review-sheet", file, "--json", "--non-interactive-approval", "test"])).json.error.code).toBe("E_JOURNEY_REVIEW_ARGS");
  });

  it("human mode shows the sheet before promoting", async () => {
    const { out } = await cli(["journey", "promote", "strong", "--non-interactive-approval", "test"]);
    expect(out.indexOf("CONTENT HASH")).toBeLessThan(out.indexOf("promoted journey 'strong'"));
  });

  it("records the --accept-weak waiver in the approval", async () => {
    await new FsJourneyStore(journeysDir).put({
      ...strongJourney("weak", { endState: undefined }),
      recording: {
        version: "1.0.0",
        site: "https://example.test",
        pages: [{ url: "/editor", steps: [{ step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } } }] }],
      },
    });
    await cli(["journey", "promote", "weak", "--accept-weak", "demo only", "--json", "--non-interactive-approval", "test"]);
    expect((await new FsJourneyStore(journeysDir).get("weak"))?.metadata.approval?.acceptedWeak?.reason).toBe("demo only");
  });
});

describe("#432 MCP review_journey", () => {
  function tools(): Map<string, (args: Record<string, unknown>) => Promise<{ isError: boolean; body: any }>> {
    const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps())) };
    return new Map(
      buildMcpTools(mcpDeps).map((t) => [
        t.name,
        async (args: Record<string, unknown>) => {
          const r = await t.handler(args);
          return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
        },
      ]),
    );
  }

  it("returns the same sheet as the CLI", async () => {
    const cliSheet = (await cli(["journey", "review", "strong", "--json"])).json.data;
    expect((await tools().get("review_journey")!({ id: "strong" })).body.data).toEqual(cliSheet);
  });

  it("is read-only: the Journey is not promoted", async () => {
    await tools().get("review_journey")!({ id: "strong" });
    expect((await new FsJourneyStore(journeysDir).get("strong"))?.metadata.promoted).toBe(false);
  });

  it("promote_journey reviewedHash refuses a stale review", async () => {
    const t = tools();
    const hash = (await t.get("review_journey")!({ id: "strong" })).body.data.contentHash as string;
    await new FsJourneyStore(journeysDir).put(strongJourney("strong", { description: "edited after review" }));
    expect((await t.get("promote_journey")!({ id: "strong", reviewedHash: hash })).body.code).toBe("E_JOURNEY_REVIEW_STALE");
  });
});

describe("#523 journey review --strict", () => {
  let catalogDir: string;

  async function strictCli(argv: readonly string[]): Promise<{ json: any; exitCode: number | string | undefined }> {
    process.exitCode = undefined;
    const lines: string[] = [];
    const program = buildProgram({ ...deps(), catalogDir });
    program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
    program.exitOverride();
    await program.parseAsync([...argv], { from: "user" });
    let json: any;
    try {
      json = JSON.parse(lines.join(""));
    } catch {
      json = undefined;
    }
    return { json, exitCode: process.exitCode };
  }

  async function putJourney(id: string, overrides: Partial<Journey["metadata"]>): Promise<void> {
    await new FsJourneyStore(journeysDir).put(strongJourney(id, overrides));
  }

  beforeEach(async () => {
    catalogDir = join(root, ".jevitate");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ name: "editor", description: "writes and publishes posts", role: "editor" }]));
    await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([{ id: "publish-post", trigger: "a draft is ready", motivation: "publish it", outcome: "readers see it", personas: ["editor"] }]));
    await putJourney("clean", { goal: "Publish a post", successCriteria: [{ description: "The post is live" }], job: "publish-post", persona: "editor", anchors: [{ name: "published", step: 2, stepId: "s-haxfhr" }] });
    await strictCli(["persona", "approve", "editor", "--json", "--non-interactive-approval", "test"]);
    await strictCli(["job", "approve", "publish-post", "--json", "--non-interactive-approval", "test"]);
    await putJourney("unlinked", { goal: "Publish a post", successCriteria: [{ description: "The post is live" }] });
  });

  it("fails on a warning (no goal or success criteria)", async () => {
    expect((await strictCli(["journey", "review", "strong", "--json", "--strict"])).exitCode).toBe(1);
  });

  it("fails on a missing job and persona without --readiness", async () => {
    expect((await strictCli(["journey", "review", "unlinked", "--json", "--strict"])).json.data.attention.map((a: any) => a.text)).toContainEqual(expect.stringContaining("it links no job and no persona"));
  });

  it("exits 1 on a missing job and persona without --readiness", async () => {
    expect((await strictCli(["journey", "review", "unlinked", "--json", "--strict"])).exitCode).toBe(1);
  });

  it("passes a clean Journey", async () => {
    expect((await strictCli(["journey", "review", "clean", "--json", "--strict"])).exitCode).toBe(0);
  });

  it("fails a role-only assertion target before replay", async () => {
    const roleOnly = strongJourney("role-only", { goal: "Publish a post", successCriteria: [{ description: "The post is live" }], job: "publish-post", persona: "editor", anchors: [{ name: "published", step: 2, stepId: "s-haxfhr" }] });
    const first = roleOnly.recording.pages[0]!.steps[0]!.step;
    if ("expect" in first && first.expect.kind === "textIncludes") first.expect.target = { role: "status" };
    await new FsJourneyStore(journeysDir).put(roleOnly);
    const result = await strictCli(["journey", "review", "role-only", "--json", "--strict"]);
    expect(result.exitCode).toBe(1);
    expect(result.json.data.proof.lint.findings).toContainEqual(expect.objectContaining({ rule: "unusable-target", level: "error" }));
  });

  it("ignores ○ items (not mutation-tested stays info)", async () => {
    const { json } = await strictCli(["journey", "review", "clean", "--json", "--strict"]);
    expect(json.data.attention).toContainEqual({ severity: "info", text: "Not mutation-tested", hint: "jevitate journey verify clean --mutate" });
  });

  it("reports the verdict in the --json envelope", async () => {
    expect((await strictCli(["journey", "review", "clean", "--json", "--strict"])).json.strict).toEqual({ passed: true, warnings: 0 });
  });

  it("a plain review still exits 0 with a warning", async () => {
    expect((await strictCli(["journey", "review", "strong", "--json"])).exitCode).toBe(0);
  });

  it("MCP review_journey strict surfaces the failure as exitCode 1", async () => {
    const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram({ ...deps(), catalogDir })) };
    const tool = buildMcpTools(mcpDeps).find((t) => t.name === "review_journey")!;
    expect(JSON.parse((await tool.handler({ id: "strong", strict: true })).content[0]!.text).exitCode).toBe(1);
  });
});
