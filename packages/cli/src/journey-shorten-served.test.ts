import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { startAccuracyLab } from "../../../test/fixtures/accuracy-lab/app.mjs";
import { registerDoneCheckHooks } from "./journey-done-check-hook.js";
import { resetRunHooksForTests } from "./journey-run-hooks.js";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all", pageClock: false });

/**
 * #801 served acceptance: `journey shorten` (in process, real Chromium) on the accuracy lab's J2
 * ("send a message to a contact", the path-search experiment's Journey, scripts/path-search-lab).
 * Every candidate is a full replay with the fixture's reset around it, decided only by the job's done
 * check (`count:testId=sent-row|min=1`) in fresh contexts; ddmin drops the detour and the message
 * typing/selection: 6 → 3 steps within the default 30-replay budget. The output is an UNPROMOTED draft;
 * the source Journey is left as it was.
 */

let lab: { url: string; close: () => Promise<void> };
let root: string;
let journeysDir: string;
let projectDir: string;
let fixturesFile: string;

const tid = (testId: string) => ({ testId });
const visible = (testId: string) => ({ kind: "visible", target: tid(testId) });
const text = (testId: string, t: string) => ({ kind: "textIncludes", target: tid(testId), text: t });

/** The experiment's J2 (scripts/path-search-lab/journeys.mjs), on the lab's own origin. */
function j2(site: string): Journey {
  return {
    metadata: { id: "j2-send-message", name: "J2 send a message", promoted: false, params: [], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1.0",
      site,
      intent: "J2 send a message",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: visible("job-send-message") } },
            { step: { kind: "click", target: tid("nav-profile"), expect: { kind: "urlIncludes", text: "/profile" } } },
            { step: { kind: "click", target: tid("nav-contacts"), expect: { kind: "urlIncludes", text: "/contacts" } } },
            {
              step: {
                kind: "select",
                target: tid("contact-select"),
                value: { redacted: false, value: "grace@example.com" },
                expect: { kind: "valueEquals", target: tid("contact-select"), value: "grace@example.com" },
              },
            },
            { step: { kind: "fill", target: tid("message-body"), value: { redacted: false, value: "Hello Grace" }, expect: { kind: "valueEquals", target: tid("message-body"), value: "Hello Grace" } } },
            { step: { kind: "click", target: { ...tid("send-message"), display: { role: "button", name: "Send" } }, expect: text("message-status", "Message sent") } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

beforeAll(async () => {
  lab = await startAccuracyLab({ variant: "clean", port: 0 });
  root = mkdtempSync(join(tmpdir(), "jev-801-shorten-served-"));
  journeysDir = join(root, "journeys");
  projectDir = join(root, ".jevitate");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "project.json"), "{}");
  writeFileSync(
    join(projectDir, "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          id: "send-message",
          trigger: "When a contact needs to hear from me",
          motivation: "I want to send them a message",
          outcome: "they have it",
          done: { version: 1, at: "/contacts", check: "count:testId=sent-row|min=1" },
        },
        { id: "no-check", trigger: "When I have nothing to check", motivation: "I want nothing", outcome: "nothing" },
      ],
    }),
  );
  // The reset between candidates: the lab back to its seed state before and after every replay.
  fixturesFile = join(root, "fixtures.json");
  writeFileSync(fixturesFile, JSON.stringify({ setup: [{ name: "reset", method: "POST", url: "/api/reset" }], restore: [{ name: "reset", method: "POST", url: "/api/reset" }] }));
  await new JourneyRegistry(new FsJourneyStore(journeysDir)).put(j2(lab.url));
});

afterAll(async () => {
  await lab.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  registerDoneCheckHooks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRunHooksForTests();
});

interface Shortened {
  readonly envelope: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
  readonly code: number;
}

async function shorten(...args: string[]): Promise<Shortened> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    dbPath: join(root, "db.sqlite"),
    catalogDir: projectDir,
    logs: { autoPrune: false, logsRoot: join(root, "logs") },
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(root, "targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(["journey", "shorten", ...args, "--journeys-dir", journeysDir, "--json"], { from: "user" });
  const code = process.exitCode === undefined ? 0 : Number(process.exitCode);
  process.exitCode = undefined;
  return { envelope: JSON.parse(out.join("")) as Shortened["envelope"], code };
}

describe("#801 journey shorten on the accuracy lab (real Chromium)", () => {
  it("shortens J2 from 6 steps to 3 within the 30-replay budget and writes an unpromoted draft", async () => {
    const r = await shorten("j2-send-message", "--job", "send-message", "--fixtures", fixturesFile);
    expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
    expect(r.code).toBe(0);
    expect(r.envelope.data).toMatchObject({
      wording: "shortest found within budget",
      journeyId: "j2-send-message",
      job: "send-message",
      originalSteps: 6,
      shortestSteps: 3,
      budget: 30,
      stopped: "searched",
      baseline: "achieved",
      draftId: "j2-send-message-shortest",
      removed: [
        { step: 2, kind: "click" },
        { step: 4, kind: "select" },
        { step: 5, kind: "fill" },
      ],
    });
    expect(r.envelope.data?.["replaysUsed"] as number).toBeLessThanOrEqual(30);
    expect(JSON.stringify(r.envelope)).not.toMatch(/optimal/i);

    const store = new FsJourneyStore(journeysDir);
    const draft = await store.get("j2-send-message-shortest");
    expect(draft?.metadata.promoted).toBe(false);
    expect(draft?.metadata.job).toBe("send-message");
    expect(draft?.recording.pages.flatMap((p) => p.steps).map((s) => s.step.kind)).toEqual(["navigate", "click", "click"]);
    // The source Journey is untouched: still six steps, still a draft.
    const source = await store.get("j2-send-message");
    expect(source?.recording.pages.flatMap((p) => p.steps)).toHaveLength(6);
  }, 600_000);

  it("refuses a job without a done check before any replay (only the done check decides a candidate)", async () => {
    const r = await shorten("j2-send-message", "--job", "no-check", "--out-id", "j2-unchecked");
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "E_JOURNEY_SHORTEN_JOB" } });
    expect(await new FsJourneyStore(journeysDir).get("j2-unchecked")).toBeNull();
  }, 60_000);
});
