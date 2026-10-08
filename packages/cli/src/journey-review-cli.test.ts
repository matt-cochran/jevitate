import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
            { step: { kind: "fill", target: { label: "Access token" }, value: { redacted: false, value: SECRET_LITERAL }, expect: { kind: "textIncludes", target: { role: "status" }, text: "ready" } } },
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
    for (const h of ["SUMMARY", "STEPS", "SIDE EFFECTS", "INPUTS", "PROOF", "CHANGE SINCE LAST APPROVAL", "CONTENT HASH"]) expect(out).toContain(h);
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
