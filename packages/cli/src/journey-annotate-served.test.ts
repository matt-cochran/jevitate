import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneySchema, type Journey } from "@jevitate/journey";
import { FakeGenerationGateway, type GenerationPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { annotationDraftPath } from "./journey-annotate-api.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #246 served e2e: `jevitate journey annotate` replays a Journey in a real browser against a served
 * page, drafts each step's objective with a deterministic fake generator into a SIDECAR (the Journey
 * file is byte-for-byte untouched), `--approve` writes the reviewed draft, an approval against a
 * Journey that changed since the draft is refused, and a Journey needing a secret is refused before the
 * model.
 */

const SECRET = "S3cr3t-Tok-9";

const APP = `<!doctype html><html><head><title>Settings</title></head><body><main>
  <h1 id="h">Settings</h1>
  <label>API token <input id="tok" aria-label="API token"></label>
  <button type="button" id="save">Save</button>
  <p data-testid="status"></p>
  <script>
    document.getElementById("save").onclick = () => {
      const v = document.getElementById("tok").value;
      document.getElementById("h").textContent = "Saved token " + v;
      document.querySelector("[data-testid=status]").textContent = "Saved";
    };
  </script></main></body></html>`;

const SETTINGS_PAGE = `<!doctype html><html><head><title>Settings</title></head><body><main>
  <h1>Settings</h1>
  <label>Display name <input aria-label="Display name"></label>
  <button type="button" onclick="document.querySelector('[data-testid=status]').textContent='Saved'">Save</button>
  <p data-testid="status"></p>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
    if (path === "/settings") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SETTINGS_PAGE);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-annotate-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function tokenJourney(): Journey {
  return {
    metadata: {
      id: "token",
      name: "Save an API token",
      promoted: false,
      params: ["note"],
      parameters: [{ name: "note", description: "the token to save" }],
      createdAtIso: "2026-09-28T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/app",
          steps: [
            { step: { kind: "navigate", url: "/app", expect: { kind: "visible", target: { role: "heading", name: "Settings" } } } },
            {
              step: { kind: "fill", target: { label: "API token" }, value: { var: "note" }, expect: { kind: "visible", target: { label: "API token" } } },
              variableName: "note",
            },
            { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } } },
          ],
        },
      ],
    },
  };
}

/** A fake generator that also records every input it was shown (what a model would have seen). */
function recordingFake(): { gen: GenerationPort; seen: unknown[] } {
  const fake = new FakeGenerationGateway();
  const seen: unknown[] = [];
  return {
    seen,
    gen: {
      generate: async (kind, input) => {
        seen.push({ kind, input });
        return fake.generate(kind, input);
      },
    },
  };
}

async function cli(journeysDir: string, args: string[], gen?: GenerationPort): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    approval: { env: {}, stdinIsTTY: () => true, stdoutIsTTY: () => true, prompt: async () => "token", user: () => "offline-test" },
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), ...(gen === undefined ? {} : { gen }) },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

describe("jevitate journey annotate — served (#246)", () => {
  it(
    "drafts an objective per step into the sidecar and never touches the Journey",
    async () => {
      const journeysDir = join(dir, "j1");
      await new FsJourneyStore(journeysDir).put(tokenJourney());
      const journeyFile = join(journeysDir, "token.json");
      const before = await readFile(journeyFile, "utf8");
      const { gen, seen } = recordingFake();

      const r = await cli(journeysDir, ["journey", "annotate", "token", "--param", `note=${SECRET}`, "--json"], gen);
      expect(r.exitCode).toBe(0);
      const env = JSON.parse(r.out) as { ok: boolean; data: { draftPath: string; replay: unknown; drafted: unknown; proposed: unknown[] } };
      expect(env.ok).toBe(true);
      expect(env.data.replay).toEqual({ outcome: "completed", reachedSteps: 3, totalSteps: 3 });
      expect(env.data.drafted).toEqual({ objectives: 3, expectedResults: 3, goal: true, successCriteria: 1 });
      expect(env.data.draftPath).toBe(annotationDraftPath(journeysDir, "token"));

      // The Journey is untouched; the draft is a sidecar with one objective per step.
      expect(await readFile(journeyFile, "utf8")).toBe(before);
      const draftRaw = await readFile(env.data.draftPath, "utf8");
      const draft = JSON.parse(draftRaw) as { steps: Array<{ index: number; objective: string; expectedResult: string }>; goal: string };
      expect(draft.steps.map((s) => s.index)).toEqual([0, 1, 2]);
      expect(draft.steps.every((s) => s.objective.length > 0)).toBe(true);
      expect(draft.steps[1]!.objective).toContain("<param note>");
      expect(draft.goal).toBe('Complete "Save an API token" (3 steps).');
      // Before/after evidence: after Save the page heading showed the value.
      expect(draft.steps[2]!.expectedResult).toBe(`The page shows "Saved token ${SECRET}".`);
      expect(seen.length).toBe(4); // 3 × journey.step + 1 × journey.goal

      // `journey run` reports steps without objectives (informational).
      const run = await cli(journeysDir, ["journey", "run", "token", "--param", `note=${SECRET}`, "--json"]);
      expect(run.exitCode).toBe(0);
      const runEnv = JSON.parse(run.out) as { data: { outcome: string; output: Record<string, string>; intent: { steps: number; withoutObjective: number } } };
      expect(runEnv.data.outcome).toBe("ok");
      expect(runEnv.data.output.note).toBe(SECRET);
      expect(runEnv.data.intent).toMatchObject({ steps: 3, withoutObjective: 3 });

      // Approval (the human gate) writes the draft into the Journey, then removes the draft.
      const approve = await cli(journeysDir, ["journey", "annotate", "token", "--approve"]);
      expect(approve.exitCode).toBe(0);
      expect(approve.out).toContain("~ step 1 objective");
      expect(approve.out).toContain("applied 8 change(s) to journey 'token' (3/3 steps now have an objective)");
      expect(existsSync(env.data.draftPath)).toBe(false);
      const annotated = JourneySchema.parse(JSON.parse(readFileSync(journeyFile, "utf8")));
      expect(annotated.metadata.goal).toBe('Complete "Save an API token" (3 steps).');
      expect(annotated.metadata.promoted).toBe(false); // approval annotates; it never promotes
      expect(annotated.recording.pages[0]!.steps.map((s) => s.objective)).toEqual(draft.steps.map((s) => s.objective));

      const rerun = await cli(journeysDir, ["journey", "run", "token", "--param", `note=${SECRET}`, "--json"]);
      expect((JSON.parse(rerun.out) as { data: { intent: { withoutObjective: number } } }).data.intent.withoutObjective).toBe(0);
    },
    120_000,
  );

  it("a Journey needing a secret parameter is refused by name, and no model call goes out", async () => {
    const journeysDir = join(dir, "j-secret");
    const secret = tokenJourney();
    secret.metadata.parameters = [{ name: "note", description: "the token to save", secret: true }];
    await new FsJourneyStore(journeysDir).put(secret);
    const { gen, seen } = recordingFake();
    const r = await cli(journeysDir, ["journey", "annotate", "token", "--param", `note=${SECRET}`, "--json"], gen);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_MODEL_REFUSED_SECRET" } });
    expect(seen).toEqual([]);
    expect(r.out + r.err).not.toContain(SECRET);
  }, 120_000);

  it(
    "approval refuses a stale draft (the Journey changed since) and writes nothing",
    async () => {
      const journeysDir = join(dir, "j2");
      const store = new FsJourneyStore(journeysDir);
      await store.put(tokenJourney());
      const r = await cli(journeysDir, ["journey", "annotate", "token", "--param", `note=${SECRET}`, "--json"], recordingFake().gen);
      expect(r.exitCode).toBe(0);

      // Someone edits the Journey after the draft was made.
      const edited = { ...tokenJourney(), metadata: { ...tokenJourney().metadata, name: "Save a token (renamed)" } };
      await store.put(edited);
      const beforeApprove = readFileSync(join(journeysDir, "token.json"), "utf8");

      const approve = await cli(journeysDir, ["journey", "annotate", "token", "--approve", "--json"]);
      expect(approve.exitCode).toBe(64);
      expect(JSON.parse(approve.out)).toMatchObject({ ok: false, error: { code: "E_JOURNEY_ANNOTATIONS_STALE" } });
      expect(readFileSync(join(journeysDir, "token.json"), "utf8")).toBe(beforeApprove);

      // No draft at all is a usage refusal too.
      const none = await cli(join(dir, "j2-empty"), ["journey", "annotate", "token", "--approve", "--json"]);
      expect(none.exitCode).toBe(64);
    },
    120_000,
  );

  it(
    "a pre-#246 Journey (the golden fixture, no intent fields) still runs unchanged",
    async () => {
      const journeysDir = join(dir, "j3");
      const here = dirname(fileURLToPath(import.meta.url));
      const golden = JSON.parse(
        await readFile(join(here, "..", "..", "journey", "src", "__fixtures__", "pre-intent-journey.json"), "utf8"),
      ) as Journey;
      await mkdir(journeysDir, { recursive: true });
      await writeFile(join(journeysDir, "save-settings.json"), JSON.stringify({ ...golden, recording: { ...golden.recording, site: origin } }));

      const run = await cli(journeysDir, ["journey", "run", "save-settings", "--param", "displayName=Dana", "--json"]);
      expect(run.exitCode).toBe(0);
      const env = JSON.parse(run.out) as { data: { outcome: string; output: Record<string, string>; intent: unknown } };
      expect(env.data.outcome).toBe("ok");
      expect(env.data.output.displayName).toBe("Dana");
      expect(env.data.intent).toMatchObject({ steps: 4, withoutObjective: 4 });
    },
    120_000,
  );
});

/** #755: a one-step read-only Journey landing on /settings (the final page's text is "Settings"). */
function groundingJourney(id: string): Journey {
  return {
    metadata: {
      id,
      name: "Open settings",
      promoted: false,
      params: [],
      createdAtIso: "2026-09-28T00:00:00.000Z",
      endState: [{ kind: "page", assertion: { kind: "urlIncludes", text: "/settings" } }],
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/settings",
          steps: [
            { step: { kind: "navigate", url: "/settings", expect: { kind: "visible", target: { role: "heading", name: "Settings" } } } },
          ],
        },
      ],
    },
  };
}

/** A generator that returns canned success criteria for journey.goal and records what the model was shown. */
function cannedGoal(criteria: string[]): { gen: GenerationPort; seen: unknown[] } {
  const fake = new FakeGenerationGateway({ "journey.goal": { goal: null, successCriteria: criteria } });
  const seen: unknown[] = [];
  return {
    seen,
    gen: {
      generate: async (kind, input) => {
        seen.push({ kind, input });
        return fake.generate(kind, input);
      },
    },
  };
}

/** Runs a grounded annotate for `id` and returns the CLI envelope, the draft and what journey.goal was shown. */
async function groundedRun(journeysDir: string, id: string, criteria: string[]) {
  await new FsJourneyStore(journeysDir).put(groundingJourney(id));
  const { gen, seen } = cannedGoal(criteria);
  const r = await cli(journeysDir, ["journey", "annotate", id, "--json"], gen);
  if (r.exitCode !== 0) throw new Error(`annotate failed for ${id}: ${r.err || r.out}`);
  const draft = JSON.parse(await readFile(annotationDraftPath(journeysDir, id), "utf8")) as { successCriteria?: string[] };
  return { r, seen, draft, env: JSON.parse(r.out) as { data: { unverifiableCriteria: string[] } } };
}

describe("jevitate journey annotate — grounded goal/success drafts (#755)", () => {
  it(
    "shows the journey.goal model the Journey's existing assertions",
    async () => {
      const journeysDir = join(dir, "g1");
      const { seen } = await groundedRun(journeysDir, "g1", ['The final page shows "Settings".']);
      const goalInput = (seen.find((s) => (s as { kind: string }).kind === "journey.goal") as { input: { assertions: string[] } }).input;
      expect(goalInput.assertions).toContain('the "Settings" heading is visible');
    },
    120_000,
  );

  it(
    "keeps a success criterion grounded in the final page text",
    async () => {
      const journeysDir = join(dir, "g2");
      const { draft } = await groundedRun(journeysDir, "g2", ['The final page shows "Settings".']);
      expect(draft.successCriteria).toEqual(['The final page shows "Settings".']);
    },
    120_000,
  );

  it(
    "shows the journey.goal model the Journey's end-state assertions",
    async () => {
      const journeysDir = join(dir, "g7");
      const { seen } = await groundedRun(journeysDir, "g7", ['The final page shows "Settings".']);
      const goalInput = (seen.find((s) => (s as { kind: string }).kind === "journey.goal") as { input: { assertions: string[] } }).input;
      expect(goalInput.assertions).toContain('the URL contains "/settings"');
    },
    120_000,
  );

  it(
    "keeps a success criterion grounded in an existing assertion",
    async () => {
      const journeysDir = join(dir, "g6");
      const { draft } = await groundedRun(journeysDir, "g6", ['The "heading" is visible.']);
      expect(draft.successCriteria).toEqual(['The "heading" is visible.']);
    },
    120_000,
  );

  it(
    "drops a success criterion neither the final page nor the assertions support",
    async () => {
      const journeysDir = join(dir, "g3");
      const unsupported = 'The page shows "ACTIVE" with no campaigns.';
      const { draft } = await groundedRun(journeysDir, "g3", [unsupported]);
      expect(draft.successCriteria ?? []).not.toContain(unsupported);
    },
    120_000,
  );

  it(
    "reports an unsupported success criterion as unverifiable",
    async () => {
      const journeysDir = join(dir, "g4");
      const unsupported = 'The page shows "ACTIVE" with no campaigns.';
      const { env } = await groundedRun(journeysDir, "g4", [unsupported]);
      expect(env.data.unverifiableCriteria).toContain(unsupported);
    },
    120_000,
  );

  it(
    "falls back to a minimal criterion derived from an existing assertion",
    async () => {
      const journeysDir = join(dir, "g5");
      const { draft } = await groundedRun(journeysDir, "g5", ['The page shows "ACTIVE" with no campaigns.']);
      expect(draft.successCriteria).toEqual(['the URL contains "/settings"']);
    },
    120_000,
  );
});

