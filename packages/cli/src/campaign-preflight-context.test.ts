import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Command } from "commander";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { runCampaign, type CampaignJobPlan, type CampaignPlan, type CampaignResult } from "./campaign-api.js";
import { CampaignHostStarvedError, CampaignPreflightError, type CampaignPreflightDeps } from "./campaign-preflight.js";

/**
 * #746: the campaign preflight's declared-context (persona) check and campaign-start host/target
 * readiness. Seams only: the persona-context lookup, the host-readiness probe and the child CLI.
 */

let dir: string;
beforeEach(async () => {
  installClock(new FakeClock({ startMs: Date.parse("2026-10-11T09:00:00.000Z") }));
  dir = await mkdtemp(join(tmpdir(), "jev-campaign-context-"));
});
afterEach(async () => {
  resetClock();
  await rm(dir, { recursive: true, force: true });
});

const APP = "http://localhost:3000";

function job(id: string, over: Partial<CampaignJobPlan> = {}): CampaignJobPlan {
  return {
    id,
    journey: `${id}-journey`,
    params: {},
    startUrl: `${APP}/app`,
    allowlist: [APP],
    anchors: [{ atStep: "review", branch: { journeyId: `${id}-journey`, step: 2, anchor: "review" } }],
    strategies: ["adversarial"],
    success: [],
    maxActions: 3,
    ...over,
  };
}

function plan(jobs: CampaignJobPlan[]): CampaignPlan {
  return { specPath: join(dir, "campaign.json"), discovery: true, totalRuns: jobs.length, jobs };
}

function fakeCli(): { newProgram: () => Command; explored: string[][] } {
  const explored: string[][] = [];
  const newProgram = (): Command => {
    const p = new Command();
    const say = (data: unknown): void => void p.configureOutput().writeOut?.(`${JSON.stringify({ v: 1, ok: true, data })}\n`);
    p.command("journey").command("run").argument("[args...]").allowUnknownOption().action(() => say({ outcome: "ok" }));
    p.command("explore").argument("[args...]").allowUnknownOption().action((args: string[]) => {
      explored.push(args);
      say({ missionOutcome: "pass", exitCode: 0 });
    });
    return p;
  };
  return { newProgram, explored };
}

const healthy: CampaignPreflightDeps = { probe: async () => null, checkSession: async () => ({ ok: true }) };

async function run(p: CampaignPlan, cli: ReturnType<typeof fakeCli>, preflight: CampaignPreflightDeps | "skip"): Promise<CampaignResult | CampaignPreflightError | CampaignHostStarvedError> {
  try {
    return await runCampaign(p, { newProgram: cli.newProgram, journeysDir: dir, missionTargetsDir: dir, outDir: join(dir, "out"), fakeAi: true, preflight });
  } catch (err) {
    if (err instanceof CampaignPreflightError || err instanceof CampaignHostStarvedError) return err;
    throw err;
  }
}

describe("campaign preflight declared-context check (#746)", () => {
  it("a session whose persona context does not match the Journey's is refused with E_CAMPAIGN_PREFLIGHT", async () => {
    const admin = join(dir, "admin.json");
    const r = await run(plan([job("checkout", { storageState: admin, declaredContext: { role: "admin" } })]), fakeCli(), {
      ...healthy,
      personaContext: () => ({ role: "buyer" }),
    });
    expect((r as CampaignPreflightError).code).toBe("E_CAMPAIGN_PREFLIGHT");
  });

  it("a persona-context refusal reports only the session file's basename", async () => {
    const admin = join(dir, "admin.json");
    const r = (await run(plan([job("checkout", { storageState: admin, declaredContext: { role: "admin" } })]), fakeCli(), {
      ...healthy,
      personaContext: () => ({ role: "buyer" }),
    })) as CampaignPreflightError;
    expect(r.message).not.toContain(admin);
  });

  it("a matching persona context passes the preflight", async () => {
    const admin = join(dir, "admin.json");
    const r = (await run(plan([job("checkout", { storageState: admin, declaredContext: { organization: "Acme", role: "admin" } })]), fakeCli(), {
      ...healthy,
      personaContext: () => ({ organization: "Acme", role: "admin" }),
    })) as CampaignResult;
    expect(r.preflight).toEqual({ ok: true, problems: [] });
  });

  it("a persona-context refusal runs no mission", async () => {
    const admin = join(dir, "admin.json");
    const cli = fakeCli();
    await run(plan([job("checkout", { storageState: admin, declaredContext: { role: "admin" } })]), cli, { ...healthy, personaContext: () => ({ role: "buyer" }) });
    expect(cli.explored).toEqual([]);
  });
});

describe("campaign-start host readiness (#746)", () => {
  it("a starved host is refused with E_HOST_STARVED, not E_CAMPAIGN_PREFLIGHT", async () => {
    const r = await run(plan([job("checkout")]), fakeCli(), { ...healthy, hostReadiness: async () => "the host is starved (load 6.00/core)" });
    expect((r as CampaignHostStarvedError).code).toBe("E_HOST_STARVED");
  });

  it("a starved host refuses the campaign before any mission", async () => {
    const cli = fakeCli();
    await run(plan([job("checkout")]), cli, { ...healthy, hostReadiness: async () => "the host is starved" });
    expect(cli.explored).toEqual([]);
  });
});

describe("campaign preflight skip (#746)", () => {
  it("--skip-preflight records the preflight as skipped and checks no persona context", async () => {
    const admin = join(dir, "admin.json");
    const r = (await run(
      plan([job("checkout", { storageState: admin, declaredContext: { role: "admin" } })]),
      fakeCli(),
      "skip",
    )) as CampaignResult;
    expect(r.preflight).toEqual({ ok: true, problems: [], skipped: true });
  });

  it("--skip-preflight does not run the host-readiness check", async () => {
    const r = await run(plan([job("checkout")]), fakeCli(), "skip");
    expect((r as CampaignResult).missions.length).toBe(1);
  });
});

describe("campaign-start host readiness with ignoreHostLoad (#746)", () => {
  it("a starved host with ignoreHostLoad starts the campaign", async () => {
    const r = (await runCampaign(plan([job("checkout")]), {
      newProgram: fakeCli().newProgram,
      journeysDir: dir,
      missionTargetsDir: dir,
      outDir: join(dir, "out"),
      fakeAi: true,
      preflight: { ...healthy, hostReadiness: async () => "the host is starved" },
      ignoreHostLoad: true,
    })) as CampaignResult;
    expect(r.preflight).toEqual({ ok: true, problems: [] });
  });
});
