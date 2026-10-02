import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { ProfileManager } from "@jevitate/daemon";
import { campaignMissionArgv, registerCampaignCommands } from "./campaign-cli.js";
import { validateCampaignSpec } from "./campaign-api.js";
import { FixtureSetupError } from "./mission-fixtures.js";
import { CLI_TOOL_SPECS } from "./mcp-cli-tools.js";

/** Parses `campaign run …` with its action stubbed and returns the run command (#311). */
function parsedRun(args: string[]): Command {
  const program = new Command();
  registerCampaignCommands(program, { profiles: new ProfileManager("/unused") }, () => new Command());
  const run = program.commands.find((c) => c.name() === "campaign")!.commands.find((c) => c.name() === "run")!;
  run.action(() => undefined);
  program.parse(["campaign", "run", "spec.json", ...args], { from: "user" });
  return run;
}

describe("campaign run forwards explore's safety, evidence and log options to every mission (#311)", () => {
  it("forwards each given flag as given, and keeps its own options out", () => {
    const run = parsedRun([
      "--allow-destructive", "--allow-writes", "--deny", "Archive", "--paid", "/^Launch/", "--paid", "Send",
      "--invariants", "inv.json", "--log-source", "docker:api-1", "--log-defect", "error", "--log-scope", "acme",
      "--log-correlation-header", "x-trace", "--server-log-drain-ms", "5000", "--evidence-video", "--record-video", "--screenshots", "steps",
      "--hook-timeout-ms", "120000", "--allow-shell-hooks", "--real", "--journeys-dir", "j", "--out", "o", "--json",
    ]);
    const argv = campaignMissionArgv(run);
    expect(argv).toEqual(expect.arrayContaining(["--allow-destructive", "--allow-writes", "--evidence-video", "--record-video"]));
    const pairs = (flag: string): string[] => argv.flatMap((a, i) => (a === flag ? [argv[i + 1] ?? ""] : []));
    expect(pairs("--deny")).toEqual(["Archive"]);
    expect(pairs("--paid")).toEqual(["/^Launch/", "Send"]);
    expect(pairs("--invariants")).toEqual(["inv.json"]);
    expect(pairs("--log-source")).toEqual(["docker:api-1"]);
    expect(pairs("--log-defect")).toEqual(["error"]);
    expect(pairs("--log-scope")).toEqual(["acme"]);
    expect(pairs("--log-correlation-header")).toEqual(["x-trace"]);
    expect(pairs("--server-log-drain-ms")).toEqual(["5000"]);
    expect(pairs("--screenshots")).toEqual(["steps"]);
    for (const own of ["--hook-timeout-ms", "--allow-shell-hooks", "--real", "--journeys-dir", "--out", "--json"]) expect(argv).not.toContain(own);
  });

  it("forwards nothing the operator did not give (destructive controls stay refused by default)", () => {
    expect(campaignMissionArgv(parsedRun(["--fake-ai"]))).toEqual([]);
  });

  it("MCP run_campaign takes the same safety and media flags, never log sources or hooks", () => {
    const cmd = CLI_TOOL_SPECS.find((t) => t.name === "run_campaign")!.command as { params: Record<string, unknown>; omitted: Record<string, string> };
    expect(Object.keys(cmd.params)).toEqual(expect.arrayContaining(["allowDestructive", "allowWrites", "deny", "paid", "invariants", "evidenceVideo", "recordVideo", "screenshots"]));
    for (const flag of ["--log-source", "--allow-log-cmd", "--allow-shell-hooks", "--hook-timeout-ms"]) expect(Object.keys(cmd.omitted)).toContain(flag);
  });
});

describe("[realtime] a campaign's hook timeout reaches its hooks (#311: it was dropped)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-campaign-hooks-"));
    const journey: Journey = {
      metadata: { id: "panel", name: "Open the panel", promoted: true, params: [], createdAtIso: "2026-10-01T00:00:00.000Z", anchors: [{ name: "open", step: 1 }] },
      recording: { version: "1", site: "http://127.0.0.1:9", pages: [{ url: "/panel", steps: [{ step: { kind: "navigate", url: "/panel", expect: { kind: "visible", target: { role: "heading", name: "Panel" } } } }] }] },
    };
    await new FsJourneyStore(join(dir, "journeys")).put(journey);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a before hook slower than --hook-timeout-ms fails setup instead of waiting for the 60 s default", async () => {
    const spec = { version: 1, before: "sleep 30", jobs: [{ id: "p", journey: "panel", anchors: ["open"], strategies: ["adversarial"] }] };
    const plan = await validateCampaignSpec(spec, join(dir, "campaign.json"), { journeysDir: join(dir, "journeys"), allowShellHooks: true, hookTimeoutMs: 300 });
    const fixtures = plan.jobs[0]!.fixtures!;
    await expect(fixtures.setup()).rejects.toBeInstanceOf(FixtureSetupError);
    await fixtures.restore();
  }, 20_000);
});
