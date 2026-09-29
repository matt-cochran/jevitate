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

/**
 * #246 served e2e: `jevitate journey annotate` replays a Journey in a real browser against a served
 * page, drafts each step's objective with a deterministic fake generator into a SIDECAR (the Journey
 * file is byte-for-byte untouched), `--approve` writes the reviewed draft, an approval against a
 * Journey that changed since the draft is refused, and a secret parameter's value never reaches the
 * model, the draft, the Journey or the output.
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
      params: ["apiToken"],
      parameters: [{ name: "apiToken", description: "the token to save", secret: true }],
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
              step: { kind: "fill", target: { label: "API token" }, value: { var: "apiToken" }, expect: { kind: "visible", target: { label: "API token" } } },
              variableName: "apiToken",
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
    "drafts an objective per step into the sidecar, never touches the Journey, and never leaks a secret param",
    async () => {
      const journeysDir = join(dir, "j1");
      await new FsJourneyStore(journeysDir).put(tokenJourney());
      const journeyFile = join(journeysDir, "token.json");
      const before = await readFile(journeyFile, "utf8");
      const { gen, seen } = recordingFake();

      const r = await cli(journeysDir, ["journey", "annotate", "token", "--param", `apiToken=${SECRET}`, "--json"], gen);
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
      expect(draft.steps[1]!.objective).toContain("<param apiToken>");
      expect(draft.goal).toBe('Complete "Save an API token" (3 steps).');
      // Before/after evidence: after Save the page heading showed the token — redacted everywhere.
      expect(draft.steps[2]!.expectedResult).toBe('The page shows "Saved token «redacted»".');

      // The secret never reached the model, the draft file or the output.
      expect(seen.length).toBe(4); // 3 × journey.step + 1 × journey.goal
      expect(JSON.stringify(seen)).not.toContain(SECRET);
      expect(JSON.stringify(seen)).toContain("«redacted»");
      expect(draftRaw).not.toContain(SECRET);
      expect(r.out + r.err).not.toContain(SECRET);

      // `journey run` masks the secret param in its output and reports steps without objectives (informational).
      const run = await cli(journeysDir, ["journey", "run", "token", "--param", `apiToken=${SECRET}`, "--json"]);
      expect(run.exitCode).toBe(0);
      expect(run.out).not.toContain(SECRET);
      const runEnv = JSON.parse(run.out) as { data: { outcome: string; output: Record<string, string>; intent: { steps: number; withoutObjective: number } } };
      expect(runEnv.data.outcome).toBe("ok");
      expect(runEnv.data.output.apiToken).toBe("«redacted»");
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
      expect(readFileSync(journeyFile, "utf8")).not.toContain(SECRET);

      const rerun = await cli(journeysDir, ["journey", "run", "token", "--param", `apiToken=${SECRET}`, "--json"]);
      expect((JSON.parse(rerun.out) as { data: { intent: { withoutObjective: number } } }).data.intent.withoutObjective).toBe(0);
    },
    120_000,
  );

  it(
    "approval refuses a stale draft (the Journey changed since) and writes nothing",
    async () => {
      const journeysDir = join(dir, "j2");
      const store = new FsJourneyStore(journeysDir);
      await store.put(tokenJourney());
      const r = await cli(journeysDir, ["journey", "annotate", "token", "--param", `apiToken=${SECRET}`, "--json"], recordingFake().gen);
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

