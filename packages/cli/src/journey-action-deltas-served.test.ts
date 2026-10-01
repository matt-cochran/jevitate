import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * #303 `--action-deltas` on replays (real Chromium): `journey run` records each replayed step's delta
 * and compares it with the one the Journey's Recording stored (a mismatch is reported); `journey
 * annotate` drafts each step's expected result from its delta, by code; `journey demo` captions each
 * step with its recorded delta. A secret parameter never appears in any of it. Off: none of it.
 */

const SECRET = "S3cr3t-Tok-9";
const APP = `<!doctype html><html><head><title>Settings</title></head><body><main>
  <h1>Settings</h1>
  <label>API token <input id="tok" aria-label="API token"></label>
  <button type="button" id="save" onclick="document.getElementById('st').textContent='Saved'">Save</button>
  <div role="status" id="st"></div>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-deltas-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** The Save step's stored delta says it changed nothing — the replay will show otherwise. */
function journey(): Journey {
  return {
    metadata: {
      id: "token",
      name: "Save an API token",
      promoted: false,
      params: ["apiToken"],
      parameters: [{ name: "apiToken", description: "the token", secret: true }],
      createdAtIso: "2026-09-28T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/app",
          steps: [
            { step: { kind: "navigate", url: "/app", expect: { kind: "visible", target: { role: "heading", name: "Settings" } } }, objective: "Open the settings" },
            {
              step: { kind: "fill", target: { label: "API token" }, value: { var: "apiToken" }, expect: { kind: "visible", target: { label: "API token" } } },
              variableName: "apiToken",
              objective: "Enter the token",
            },
            {
              step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { role: "button", name: "Save" } } },
              objective: "Save it",
              delta: { verdict: "no-change", why: "nothing changed and no request was sent", changes: [], overheadMs: 0 },
            },
          ],
        },
      ],
    },
  };
}

async function cli(journeysDir: string, args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

interface StepDelta {
  step: number;
  delta: { verdict: string; changes: string[] };
  matchesRecorded?: boolean;
  differences?: string[];
}

describe("--action-deltas on replays (#303, served)", () => {
  it("journey run: each step's delta, compared with the recorded one; off: none", async () => {
    const journeysDir = join(dir, "run");
    await new FsJourneyStore(journeysDir).put(journey());
    const on = await cli(journeysDir, ["journey", "run", "token", "--param", `apiToken=${SECRET}`, "--action-deltas", "--json"]);
    expect(on.exitCode).toBe(0);
    expect(on.out).not.toContain(SECRET);
    const data = (JSON.parse(on.out) as { data: { actionDeltas: { steps: StepDelta[]; mismatches: number } } }).data;
    expect(data.actionDeltas.steps.map((s) => s.step)).toEqual([1, 2, 3]);
    const save = data.actionDeltas.steps[2]!;
    expect(save.delta.verdict).toBe("relevant-change");
    expect(save.matchesRecorded).toBe(false);
    expect(save.differences).toContain("verdict: recorded no-change, now relevant-change");
    expect(data.actionDeltas.mismatches).toBe(1);

    const off = await cli(journeysDir, ["journey", "run", "token", "--param", `apiToken=${SECRET}`, "--json"]);
    expect(off.exitCode).toBe(0);
    expect(JSON.parse(off.out).data.actionDeltas).toBeUndefined();
  }, 120_000);

  it("journey annotate: the expected result is drafted by code from the step's delta (no model call, nothing secret)", async () => {
    const journeysDir = join(dir, "annotate");
    await new FsJourneyStore(journeysDir).put(journey());
    const r = await cli(journeysDir, ["journey", "annotate", "token", "--param", `apiToken=${SECRET}`, "--action-deltas", "--fake-ai", "--json"]);
    expect(r.exitCode).toBe(0);
    const draftPath = (JSON.parse(r.out) as { data: { draftPath: string } }).data.draftPath;
    const raw = await readFile(draftPath, "utf8");
    expect(raw).not.toContain(SECRET);
    const draft = JSON.parse(raw) as { steps: Array<{ index: number; expectedResult?: string }> };
    expect(draft.steps.find((s) => s.index === 2)?.expectedResult).toMatch(/status: "" → "Saved"/);
  }, 120_000);

  it("journey demo: each step's guide entry carries an 'Observed' line from its recorded delta", async () => {
    const journeysDir = join(dir, "demo");
    await new FsJourneyStore(journeysDir).put(journey());
    const guide = join(dir, "demo-out", "token-guide.md");
    const r = await cli(journeysDir, ["journey", "demo", "token", "--param", `apiToken=${SECRET}`, "--guide", guide, "--pace", "0", "--action-deltas", "--json"]);
    expect(r.exitCode).toBe(0);
    const md = await readFile(guide, "utf8");
    expect(md).toContain("**Observed:** observed: nothing visible changes");
    expect(md).not.toContain(SECRET);
  }, 120_000);
});
