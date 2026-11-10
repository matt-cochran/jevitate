import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { ProfileManager } from "@jevitate/daemon";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "../../cli/src/program.js";
import { PreferenceJudge, useSkippingTime, type Preference } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all", pageClock: false });

/**
 * 0.30.0 (#800 `explore --goal --job`): the nav lab's `looks-done-wrong-page` case, served, through the CLI with a scripted
 * model (no real model call). The model thinks it is done on Billing, a marketing page; the job's done check (the lab's own state:
 * did the billing SETTINGS page get served) is read in a fresh context after its `done` and says no. A goal with no `--success`
 * and no `--job` is judgment-only: the job reads unverified, a warning names the flags, and the exit follows owner decision 3
 * (exit 2 under the default `doneCheckPolicy: require`; 0 only under `advisory`; `--require-done-check` forces 2).
 */

const GOAL = "Open the billing settings for my account.";
const labPath = resolve(import.meta.dirname, "../../../test/fixtures/nav-lab/app.mjs");
interface Lab {
  readonly url: string;
  close(): Promise<void>;
}
async function startLab(): Promise<Lab> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(labPath).href)) as { startNavLab(o: { caseId: string; port: number; seed: number }): Promise<Lab> };
  return mod.startNavLab({ caseId: "looks-done-wrong-page", port: 0, seed: 0 });
}

const click = (name: string): Preference => ({ op: "click", name });
/** The model reads Billing (a marketing page) and says it is done. */
const WRONG_PAGE = (call: number): readonly Preference[] => (call === 0 ? [click("Billing")] : [{ op: "done" }]);
/** The model finds Account > Payment details and says it is done. */
const RIGHT_PAGE = (call: number): readonly Preference[] =>
  call === 0 ? [click("Account")] : call === 1 ? [click("Payment details")] : [{ op: "done" }];

let root: string;
const labs: Lab[] = [];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jev-explore-done-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(labs.splice(0).map((l) => l.close()));
  process.exitCode = undefined;
});

function project(policy?: "require" | "advisory"): string {
  const dir = join(root, `project-${policy ?? "default"}`);
  mkdirSync(join(dir, "journeys"), { recursive: true });
  writeFileSync(
    join(dir, "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          id: "billing-settings",
          trigger: "a payment card expires",
          motivation: "update how I pay",
          outcome: "I reach my payment details",
          // The lab's own state: true only once GET /settings/billing was served, whatever route was taken.
          done: { version: 1, at: "/__lab/state", check: 'textIncludes:body|"done":true' },
        },
      ],
    }),
  );
  if (policy !== undefined) writeFileSync(join(dir, "project.json"), JSON.stringify({ doneCheckPolicy: policy }));
  return dir;
}

interface Run {
  readonly data: { goalOutcome?: string; missionOutcome?: string; job?: { attainment: string; basis: string }; reason?: string };
  readonly code: number;
  readonly err: string;
}

async function explore(prefs: (call: number) => readonly Preference[], dir: string, ...flags: string[]): Promise<Run> {
  const lab = await startLab();
  labs.push(lab);
  const judge = new PreferenceJudge(prefs, "blocked");
  judge.goalMetProbability = 0.9;
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    dbPath: join(root, "db.sqlite"),
    catalogDir: dir,
    journeysDir: join(dir, "journeys"),
    logs: { autoPrune: false, logsRoot: join(root, "logs") },
    explore: { judge, gen: new FakeGenerationGateway(), browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(
    ["explore", "--url", `${lab.url}/`, "--goal", GOAL, "--max-decisions", "8", "--out", join(root, "out"), "--json", ...flags],
    { from: "user" },
  );
  const code = process.exitCode === undefined ? 0 : Number(process.exitCode);
  process.exitCode = undefined;
  const envelope = JSON.parse(out.join("")) as { data?: Run["data"]; error?: unknown };
  if (envelope.data === undefined) err.push(JSON.stringify(envelope.error));
  return { data: envelope.data ?? {}, code, err: err.join("") };
}

describe("0.30.0 #800 explore --goal --job, served (nav lab looks-done-wrong-page)", () => {
  for (const replicate of [1, 2, 3]) {
    it(
      `--job: done on the marketing Billing page reads not-achieved (replicate ${replicate}/3)`,
      async () => {
        const r = await explore(WRONG_PAGE, project(), "--job", "billing-settings");
        expect(r.data.job, r.err).toEqual({ attainment: "not-achieved", basis: "done-check" });
        expect(r.data.goalOutcome).not.toBe("succeeded");
        expect(r.code).toBe(1);
      },
      180_000,
    );
  }

  it("--job on the real page: achieved, exit 0", async () => {
    const r = await explore(RIGHT_PAGE, project(), "--job", "billing-settings");
    expect(r.data.job, r.err).toEqual({ attainment: "achieved", basis: "done-check" });
    expect(r.data.goalOutcome).toBe("succeeded");
    expect(r.code).toBe(0);
  }, 180_000);

  it("no --success and no --job: unverified, stderr names the flags, exit 2 by default (decision 3)", async () => {
    const r = await explore(RIGHT_PAGE, project());
    expect(r.data.goalOutcome, r.err).toBe("succeeded");
    expect(r.data.job).toEqual({ attainment: "unverified", basis: "no-check" });
    expect(r.err).toContain("add --success or --job");
    expect(r.data.missionOutcome).toBe("inconclusive");
    expect(r.code).toBe(2);
  }, 180_000);

  it("doneCheckPolicy advisory keeps exit 0 (still unverified, still warned); --require-done-check forces exit 2 and inconclusive", async () => {
    const advisory = await explore(RIGHT_PAGE, project("advisory"));
    expect(advisory.data.job).toEqual({ attainment: "unverified", basis: "no-check" });
    expect(advisory.err).toContain("add --success or --job");
    expect(advisory.data.missionOutcome).toBe("clean");
    expect(advisory.code).toBe(0);

    const required = await explore(RIGHT_PAGE, project("advisory"), "--require-done-check");
    expect(required.data.job).toEqual({ attainment: "unverified", basis: "no-check" });
    expect(required.data.missionOutcome).toBe("inconclusive");
    expect(required.code).toBe(2);
  }, 240_000);
});
