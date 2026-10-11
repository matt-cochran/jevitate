import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { BrowserSession } from "@jevitate/playwright";
import { runCampaign, type CampaignJobPlan, type CampaignPlan, type CampaignResult } from "./campaign-api.js";
import { formatCampaignHuman } from "./campaign-cli.js";
import { CampaignPreflightError, type CampaignPreflightDeps } from "./campaign-preflight.js";
import { exitCodeForError } from "./exit-codes.js";
import { watchOffAllowlistWrites } from "./journey-api.js";

/**
 * #485: `campaign run` checks its own preconditions before any anchored mission — start URL
 * reachable, sessions signed in, no allow-list origin slip in discovery — and refuses (exit 64)
 * with EVERY problem listed. Seams only: the connect probe, the signed-in check and the child CLI.
 */

let dir: string;
beforeEach(async () => {
  installClock(new FakeClock({ startMs: Date.parse("2026-10-11T09:00:00.000Z") }));
  dir = await mkdtemp(join(tmpdir(), "jev-campaign-preflight-"));
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

/** A child CLI: `journey run <id>` answers `discovery[id]` (default a clean replay); `explore` is recorded and answers a pass. */
function fakeCli(discovery: Record<string, Record<string, unknown>> = {}): { newProgram: () => Command; explored: string[][] } {
  const explored: string[][] = [];
  const newProgram = (): Command => {
    const p = new Command();
    const say = (data: unknown): void => void p.configureOutput().writeOut?.(`${JSON.stringify({ v: 1, ok: true, data })}\n`);
    p.command("journey").command("run").argument("[args...]").allowUnknownOption().action((args: string[]) => say(discovery[args[0] ?? ""] ?? { outcome: "ok" }));
    p.command("explore").argument("[args...]").allowUnknownOption().action((args: string[]) => {
      explored.push(args);
      say({ missionOutcome: "pass", exitCode: 0 });
    });
    return p;
  };
  return { newProgram, explored };
}

const healthy: CampaignPreflightDeps = { probe: async () => null, checkSession: async () => ({ ok: true }) };

async function run(p: CampaignPlan, cli: ReturnType<typeof fakeCli>, preflight: CampaignPreflightDeps | "skip"): Promise<CampaignResult | CampaignPreflightError> {
  try {
    return await runCampaign(p, { newProgram: cli.newProgram, journeysDir: dir, missionTargetsDir: dir, outDir: join(dir, "out"), fakeAi: true, preflight });
  } catch (err) {
    if (err instanceof CampaignPreflightError) return err;
    throw err;
  }
}

describe("campaign run preflight (#485)", () => {
  it("a healthy campaign records a passing preflight in its result", async () => {
    const r = (await run(plan([job("checkout")]), fakeCli(), healthy)) as CampaignResult;
    expect(r.preflight).toEqual({ ok: true, problems: [] });
  });

  it("an unreachable start URL refuses the campaign naming the URL and why", async () => {
    const deps: CampaignPreflightDeps = { ...healthy, probe: async () => "connection refused — is the app running at http://localhost:3000?" };
    const r = await run(plan([job("checkout")]), fakeCli(), deps);
    expect((r as CampaignPreflightError).message).toContain("job checkout: the start URL http://localhost:3000/app is not reachable: connection refused");
  });

  it("an expired storage state refuses the campaign with the signed-in check's reason", async () => {
    const deps: CampaignPreflightDeps = {
      ...healthy,
      checkSession: async () => ({ ok: false, reason: "the session in admin.json is not signed in: /app redirected to the sign-in page /login", landedUrl: `${APP}/login` }),
    };
    const r = await run(plan([job("checkout", { storageState: join(dir, "admin.json") })]), fakeCli(), deps);
    expect((r as CampaignPreflightError).message).toContain("job checkout: the session in admin.json is not signed in: /app redirected to the sign-in page /login");
  });

  it("a discovery write to 127.0.0.1 while the allow list names localhost refuses with the exact origin to add", async () => {
    const cli = fakeCli({ "checkout-journey": { outcome: "ok", offAllowlistWrites: ["http://127.0.0.1:3000"] } });
    const r = await run(plan([job("checkout")]), cli, healthy);
    expect((r as CampaignPreflightError).problems.map((p) => [p.check, p.origin])).toEqual([["allow-origin", "http://127.0.0.1:3000"]]);
  });

  it("a third-party write in discovery is not an allow-list problem", async () => {
    const cli = fakeCli({ "checkout-journey": { outcome: "ok", offAllowlistWrites: ["https://m.stripe.com"] } });
    const r = (await run(plan([job("checkout")]), cli, healthy)) as CampaignResult;
    expect(r.preflight?.ok).toBe(true);
  });

  it("every problem of every job is listed, not just the first", async () => {
    const cli = fakeCli({ "search-journey": { outcome: "ok", offAllowlistWrites: ["http://127.0.0.1:3000"] } });
    const deps: CampaignPreflightDeps = { ...healthy, checkSession: async () => ({ ok: false, reason: "the session in a.json is not signed in", landedUrl: "" }) };
    const r = await run(plan([job("checkout", { storageState: join(dir, "a.json") }), job("search")]), cli, deps);
    expect((r as CampaignPreflightError).problems.map((p) => `${p.job}:${p.check}`)).toEqual(["checkout:auth", "search:allow-origin"]);
  });

  it("a refused campaign runs no mission", async () => {
    const cli = fakeCli();
    await run(plan([job("checkout")]), cli, { ...healthy, probe: async () => "connection refused" });
    expect(cli.explored).toEqual([]);
  });

  it("a refused campaign still writes its result with the preflight's problems", async () => {
    const r = (await run(plan([job("checkout")]), fakeCli(), { ...healthy, probe: async () => "connection refused" })) as CampaignPreflightError;
    expect(JSON.parse(readFileSync(r.resultPath, "utf8")).preflight.problems[0].check).toBe("reachability");
  });

  it("a preflight refusal is a usage refusal (exit 64)", () => {
    expect(exitCodeForError(new CampaignPreflightError([], "x").code)).toBe(64);
  });

  it("--skip-preflight checks nothing and records the preflight as skipped", async () => {
    const r = (await run(plan([job("checkout")]), fakeCli({ "checkout-journey": { outcome: "ok", offAllowlistWrites: ["http://127.0.0.1:3000"] } }), "skip")) as CampaignResult;
    expect(r.preflight).toEqual({ ok: true, problems: [], skipped: true });
  });

  it("the human summary states the preflight's verdict", async () => {
    const r = (await run(plan([job("checkout")]), fakeCli(), healthy)) as CampaignResult;
    expect(formatCampaignHuman(r)).toContain("preflight ok");
  });

  it("the campaign report says the preflight passed", async () => {
    const r = (await run(plan([job("checkout")]), fakeCli(), healthy)) as CampaignResult;
    expect(existsSync(r.reportPath) && readFileSync(r.reportPath, "utf8")).toContain("## Preflight");
  });
});

describe("a journey replay observes off-allow-list writes (#485)", () => {
  function session(): { s: BrowserSession; context: EventEmitter } {
    const context = new EventEmitter();
    return { s: { page: { context: () => context } } as unknown as BrowserSession, context };
  }
  const request = (method: string, url: string) => ({ method: () => method, url: () => url });

  it("returns each distinct off-allow-list origin a write went to, never a read's or an allowed one's", () => {
    const { s, context } = session();
    const watch = watchOffAllowlistWrites(s, ["http://localhost:3000"]);
    context.emit("request", request("POST", "http://127.0.0.1:3000/api/orders?token=x"));
    context.emit("request", request("PUT", "http://127.0.0.1:3000/api/orders/1"));
    context.emit("request", request("GET", "http://127.0.0.1:8080/health"));
    context.emit("request", request("POST", "http://localhost:3000/api/ok"));
    expect(watch.stop()).toEqual(["http://127.0.0.1:3000"]);
  });
});
