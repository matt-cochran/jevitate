import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps, type McpJourneyRunOptions, type McpVerifyFixArgs } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { CLI_TOOL_SPECS, buildCliArgv } from "./mcp-cli-tools.js";

/**
 * 0.11.0 — the MCP side of the 0.11 CLI capabilities (MCP/CLI parity):
 * #487 journey_anchor_add / journey_anchor_remove, lint_journey fix, journey_anchors suggest;
 * #486 run_journey stepResponseTimeoutMs; #484 verify_fix env; #485 run_campaign skipPreflight.
 */

const CLICK: Step = { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };
const ASSERT: Step = { kind: "assert", check: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };

function journey(metadata: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: { id: "draft", name: "draft", promoted: false, params: [], createdAtIso: "2026-10-09T00:00:00Z", ...metadata },
    recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [{ step: CLICK, stepId: "s-click1" }, { step: ASSERT, stepId: "s-assrt1" }] }] },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-011-surface-"));
});
const seed = (j: Journey): Promise<void> => writeFile(join(dir, "draft.json"), JSON.stringify(j));
const stored = async (): Promise<Journey> => (await new FsJourneyStore(dir).get("draft"))!;

function cliTool(name: string): (args: Record<string, unknown>) => Promise<{ isError?: boolean; body: Record<string, unknown> }> {
  const deps: McpApiDeps = {
    journeysDir: dir,
    pathRoots: [dir],
    runCli: makeInProcessCliRunner(() => buildProgram({ profiles: new ProfileManager(join(dir, "profiles")), journeysDir: dir })),
  };
  const tool = buildMcpTools(deps).find((t) => t.name === name)!;
  return async (args) => {
    const r = await tool.handler(args);
    return { ...(r.isError === true ? { isError: true } : {}), body: JSON.parse(r.content[0]!.text) as Record<string, unknown> };
  };
}

describe("#487 journey_anchor_add", () => {
  it("writes the anchor with its step id into the draft Journey", async () => {
    await seed(journey());
    await cliTool("journey_anchor_add")({ journeyId: "draft", name: "review", step: "2" });
    expect((await stored()).metadata.anchors?.[0]).toEqual({ name: "review", step: 2, stepId: "s-assrt1" });
  });

  it("#507: on a promoted Journey, says its approval needs renewing", async () => {
    await seed(journey({ promoted: true }));
    expect(await cliTool("journey_anchor_add")({ journeyId: "draft", name: "review", step: "2" })).toMatchObject({ body: { data: { needsReapproval: true } } });
  });

  it("#507: writes the anchor into a promoted Journey", async () => {
    await seed(journey({ promoted: true }));
    await cliTool("journey_anchor_add")({ journeyId: "draft", name: "review", step: "2" });
    expect((await stored()).metadata.anchors?.[0]?.name).toBe("review");
  });
});

describe("#487 journey_anchor_remove", () => {
  it("removes the named anchor from the draft Journey", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 2, stepId: "s-assrt1" }] }));
    await cliTool("journey_anchor_remove")({ journeyId: "draft", name: "review" });
    expect((await stored()).metadata.anchors ?? []).toEqual([]);
  });

  it("#507: on a promoted Journey, says its approval needs renewing", async () => {
    await seed(journey({ promoted: true, anchors: [{ name: "review", step: 2, stepId: "s-assrt1" }] }));
    expect(await cliTool("journey_anchor_remove")({ journeyId: "draft", name: "review" })).toMatchObject({ body: { data: { needsReapproval: true } } });
  });
});

describe("#487 lint_journey fix / journey_anchors suggest", () => {
  it("lint_journey fix stamps a number-only anchor's step id", async () => {
    await seed(journey({ anchors: [{ name: "review", step: 2 }] }));
    await cliTool("lint_journey")({ id: "draft", fix: true });
    expect((await stored()).metadata.anchors?.[0]?.stepId).toBe("s-assrt1");
  });

  it("journey_anchors suggest returns the advisory suggestions", async () => {
    await seed(journey());
    expect((await cliTool("journey_anchors")({ id: "draft", suggest: true })).body.data).toHaveProperty("suggestions");
  });
});

describe("#485 run_campaign skipPreflight", () => {
  it("passes --skip-preflight to campaign run", () => {
    const spec = CLI_TOOL_SPECS.find((t) => t.name === "run_campaign")!;
    expect(buildCliArgv(spec, { spec: "campaign.json", skipPreflight: true }, [process.cwd()])).toContain("--skip-preflight");
  });
});

describe("#486 run_journey stepResponseTimeoutMs", () => {
  const runWith = async (args: Record<string, unknown>): Promise<{ seen: McpJourneyRunOptions | undefined; isError: boolean }> => {
    let seen: McpJourneyRunOptions | undefined;
    const tool = buildMcpTools({
      journeysDir: dir,
      runJourney: async (_id, _p, _s, o) => {
        seen = o;
        return { outcome: "ok" };
      },
    }).find((t) => t.name === "run_journey")!;
    const r = await tool.handler({ id: "checkout", ...args });
    return { seen, isError: r.isError === true };
  };

  it("threads the bound to the run", async () => {
    expect((await runWith({ stepResponseTimeoutMs: 45000 })).seen?.stepResponseTimeoutMs).toBe(45000);
  });

  it("refuses a bound below 1 ms", async () => {
    expect((await runWith({ stepResponseTimeoutMs: 0 })).isError).toBe(true);
  });

  it("refuses a bound above 300000 ms", async () => {
    expect((await runWith({ stepResponseTimeoutMs: 300_001 })).isError).toBe(true);
  });
});

describe("#484 verify_fix env (allow is CLI-only)", () => {
  const RESULT = "explore-2026-09-24T00-00-02-000Z";
  const FP = "1ad9521b771f3bd4";
  const verifyWith = async (args: Record<string, unknown>, report: Record<string, unknown> = {}): Promise<{ seen: McpVerifyFixArgs | undefined; isError: boolean; body: Record<string, unknown> }> => {
    let seen: McpVerifyFixArgs | undefined;
    const tool = buildMcpTools({
      journeysDir: dir,
      recordingsDir: dir,
      environmentsFile: join(dir, "environments.json"),
      verifyFix: async (a) => {
        seen = a;
        return { verdict: "fixed", exitCode: 0, ...report } as never;
      },
    }).find((t) => t.name === "verify_fix")!;
    const r = await tool.handler({ id: RESULT, fingerprint: FP, ...args });
    return { seen, isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as Record<string, unknown> };
  };

  it("refuses an allow list: an MCP caller never names origins", async () => {
    expect(await verifyWith({ allow: ["http://127.0.0.1:3000"] })).toMatchObject({ isError: true, body: { error: "invalid_args" } });
  });

  it("threads env with the server's environments file", async () => {
    expect((await verifyWith({ env: "staging" })).seen).toMatchObject({ env: "staging", environmentsFile: join(dir, "environments.json") });
  });

  it("never overrides the allow list when env is not given", async () => {
    expect((await verifyWith({})).seen).not.toHaveProperty("env");
  });

  it("returns the report's allowlistOverride", async () => {
    const override = { source: "--env staging", origins: ["http://127.0.0.1:3000"], recorded: ["http://localhost:3000"], added: ["http://127.0.0.1:3000"], removed: ["http://localhost:3000"] };
    expect((await verifyWith({ env: "staging" }, { allowlistOverride: override })).body.allowlistOverride).toEqual(override);
  });
});
