import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, flatJourneySteps } from "@jevitate/journey";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { DEMO_OVERLAY_ATTR, GOAL_ALREADY_MET_QUESTION, GOAL_MET_QUESTION } from "@jevitate/explore";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { demoJourney } from "./journey-demo-api.js";
import type { CaptureLayer } from "./demo-capture.js";

/**
 * #249 served e2e: `jevitate demo "<aspect>"` explores a small served app with a deterministic
 * scripted judge that takes a DETOUR (opens and closes a tips panel) before doing the job. The
 * clean path drops the detour; the minimized Journey replays and meets its success check; the draft
 * demo is marked DRAFT (overlay watermark, subtitles, guide); `demo approve` promotes the Journey and
 * renders final, unmarked outputs; a `production: true` environment is refused (exit 64).
 */

const APP = `<!doctype html><html><head><title>Profile</title></head><body><main>
  <h1>Profile</h1>
  <button type="button" id="tips">Show tips</button>
  <div id="tipbox" hidden><p>Tip: a short name reads best.</p><button type="button" id="hide">Hide tips</button></div>
  <label>Display name <input id="name" aria-label="Display name"></label>
  <button type="button" id="save">Save</button>
  <p data-testid="status" role="status"></p>
  <script>
    const box = document.getElementById("tipbox");
    document.getElementById("tips").onclick = () => { box.hidden = false; };
    document.getElementById("hide").onclick = () => { box.hidden = true; };
    document.getElementById("save").onclick = () => {
      const v = document.getElementById("name").value.trim();
      document.querySelector("[data-testid=status]").textContent = v === "" ? "A display name is required" : "Saved " + v;
    };
  </script></main></body></html>`;

const SUCCESS = "textIncludes:testId=status|Saved";
const ASPECT = "Save your display name";

let server: Server;
let origin: string;
let dir: string;
let envFile: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-demo-aspect-"));
  envFile = join(dir, "environments.json");
  writeFileSync(envFile, JSON.stringify({ staging: { baseUrl: origin }, prod: { baseUrl: origin, production: true } }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** Picks, in order: Show tips (detour), Hide tips (detour), type the name, Save, done — matched by the offered action's description. */
function detourJudge(): JudgmentPort & { calls: number } {
  const script = [/click .*Show tips/, /click .*Hide tips/, /type into .*Display name/, /click .*"Save"/];
  let at = 0;
  const judge = {
    calls: 0,
    async systemOne({ questions }: { questions: Record<string, { kind: string; options?: string[]; descriptions?: Record<string, string> }> }) {
      judge.calls += 1;
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === "action" && q.kind === "choice") {
          const want = script[at];
          const pick = want === undefined ? "done" : (q.options ?? []).find((id) => want.test(q.descriptions?.[id] ?? ""));
          if (pick !== undefined && want !== undefined) at += 1;
          out[key] = { kind: "choice", value: pick ?? "wait", confidence: 0.9 };
        } else if (key === GOAL_MET_QUESTION) out[key] = { kind: "noul", value: true, probability: 0.95 };
        else if (key === GOAL_ALREADY_MET_QUESTION) out[key] = { kind: "noul", value: false, probability: 0.05 };
        else if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options?.[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  };
  return judge as unknown as JudgmentPort & { calls: number };
}

async function cli(journeysDir: string, judge: JudgmentPort, args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    environmentsFile: envFile,
    explore: { judge, gen: new FakeGenerationGateway(), browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(dir, "no-targets.json") },
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

/** A capture layer recording whether the overlay host carries the DRAFT watermark at each capture. */
function watermarkProbe(seen: string[]): CaptureLayer {
  return {
    name: "watermark-probe",
    prepare: async (page) => {
      seen.push(String(await page.locator(`[${DEMO_OVERLAY_ATTR}]`).first().getAttribute("data-jevitate-watermark")));
    },
  };
}

describe("jevitate demo — served (#249)", () => {
  it(
    "explore with a detour → a minimized Journey without it that replays; DRAFT outputs; approve promotes and renders final outputs",
    async () => {
      const journeysDir = join(dir, "j1");
      const draftDir = join(dir, "draft");
      const judge = detourJudge();
      const r = await cli(journeysDir, judge, ["demo", ASPECT, "--env", "staging", "--success", SUCCESS, "--out", draftDir, "--pace", "0", "--json"]);
      expect(r.err).toBe("");
      expect(r.exitCode).toBe(0);
      const env = JSON.parse(r.out) as {
        ok: boolean;
        data: { id: string; outcome: string; minimize: { exploredSteps: number; keptSteps: number; dropped: string[] }; draft: { video: string; subtitles: string; guide: string }; next: string };
      };
      expect(env.ok).toBe(true);
      const d = env.data;
      expect(d.outcome).toBe("drafted");
      expect(d.id).toBe("demo-save-your-display-name");
      expect(d.next).toBe("jevitate demo approve demo-save-your-display-name");

      // Clean path: the detour (open + close the tips panel) is gone; the job and its proof remain.
      expect(d.minimize.dropped.some((s) => s.includes("Show tips"))).toBe(true);
      expect(d.minimize.dropped.some((s) => s.includes("Hide tips"))).toBe(true);
      expect(d.minimize.keptSteps).toBeLessThan(d.minimize.exploredSteps);
      const journey = await new FsJourneyStore(journeysDir).get(d.id);
      expect(journey?.metadata.promoted).toBe(false); // never promoted without approval
      const kinds = flatJourneySteps(journey!).map((s) => JSON.stringify(s.recorded.step));
      expect(kinds.some((k) => k.includes("tips"))).toBe(false);
      expect(kinds.some((k) => k.includes('"fill"'))).toBe(true);
      expect(kinds[kinds.length - 1]).toContain('"assert"');
      expect(journey?.metadata.goal).toBe(ASPECT);
      expect(journey?.metadata.successCriteria?.[0]?.check).toEqual({ kind: "textIncludes", target: { testId: "status" }, text: "Saved" });
      // The Journey itself carries no annotations yet: they are a draft until approval.
      expect(flatJourneySteps(journey!).every((s) => s.recorded.objective === undefined)).toBe(true);

      // The minimized Journey replays and meets its success check (its last step).
      const run = await cli(journeysDir, judge, ["journey", "run", d.id, "--env", "staging", "--json"]);
      expect(run.exitCode ?? 0).toBe(0);
      expect((JSON.parse(run.out) as { data: { outcome: string } }).data.outcome).toBe("ok");

      // Drafts are marked DRAFT: subtitles, guide (and the overlay — checked below).
      const vtt = readFileSync(d.draft.subtitles, "utf8");
      expect(vtt).toContain("NOTE DRAFT");
      expect(vtt).toMatch(/\n\[DRAFT\] /);
      const guide = readFileSync(d.draft.guide, "utf8");
      expect(guide.startsWith(`# DRAFT: ${ASPECT}`)).toBe(true);
      expect(guide).toContain(`jevitate demo approve ${d.id}`);
      expect(guide).toContain("Step 1 of"); // narrated with the drafted objectives
      expect(readFileSync(d.draft.video).subarray(0, 4).toString("hex")).toBe("1a45dfa3");

      // The overlay watermark: on every frame of a draft render, never on a final one.
      const drafted: string[] = [];
      const { draft: annotations } = await import("./journey-annotate-api.js").then((m) => m.readAnnotationDraft(journeysDir, d.id));
      const probeRun = await demoJourney({
        dir: journeysDir,
        id: d.id,
        params: {},
        guide: join(dir, "probe", "guide.md"),
        paceMs: 0,
        annotations,
        draft: true,
        captureLayers: [watermarkProbe(drafted)],
        browserPortFactory: () => new PlaywrightBrowserPort(),
      });
      expect(probeRun.outcome).toBe("ok");
      expect(drafted.length).toBeGreaterThan(0);
      expect(drafted.every((w) => w === "DRAFT")).toBe(true);

      // One approval: shows the Journey + annotations, promotes it, applies them, renders final outputs.
      const finalDir = join(dir, "final");
      const human = await cli(journeysDir, judge, ["demo", "approve", d.id, "--out", finalDir, "--pace", "0"]);
      expect(human.err).toBe("");
      expect(human.exitCode).toBe(0);
      expect(human.out).toContain(`journey '${d.id}'`);
      expect(human.out).toContain("Step 1 of");
      expect(human.out).toContain(`approved: journey '${d.id}' promoted`);
      const approved = await new FsJourneyStore(journeysDir).get(d.id);
      expect(approved?.metadata.promoted).toBe(true);
      expect(flatJourneySteps(approved!).every((s) => (s.recorded.objective ?? "") !== "")).toBe(true);
      expect(approved?.metadata.successCriteria?.[0]?.check).toBeDefined(); // the code check survives approval
      const finalVtt = readFileSync(join(finalDir, "demo.vtt"), "utf8");
      const finalGuide = readFileSync(join(finalDir, "guide.md"), "utf8");
      expect(finalVtt).not.toContain("DRAFT");
      expect(finalGuide).not.toContain("DRAFT");
      expect(finalGuide.startsWith(`# ${ASPECT}`)).toBe(true);
      expect(existsSync(join(journeysDir, ".drafts", `${d.id}.demo.json`))).toBe(false);

      const final: string[] = [];
      await demoJourney({ dir: journeysDir, id: d.id, params: {}, guide: join(dir, "probe2", "guide.md"), paceMs: 0, captureLayers: [watermarkProbe(final)], browserPortFactory: () => new PlaywrightBrowserPort() });
      expect(final.length).toBeGreaterThan(0);
      expect(final.every((w) => w === "null")).toBe(true);

      // Approving again: there is no demo draft any more (usage error, nothing re-rendered).
      const again = await cli(journeysDir, judge, ["demo", "approve", d.id, "--json"]).catch((e: { exitCode?: number }) => ({ out: "", err: "", exitCode: e.exitCode }));
      expect(again.exitCode).toBe(64);
    },
    600_000,
  );

  it("refuses an environment flagged production: true before anything runs (exit 64)", async () => {
    const journeysDir = join(dir, "j2");
    const judge = detourJudge();
    const r = await cli(journeysDir, judge, ["demo", ASPECT, "--env", "prod", "--success", SUCCESS, "--json"]).catch((e: { exitCode?: number }) => ({
      out: "",
      err: "",
      exitCode: e.exitCode,
    }));
    expect(r.exitCode).toBe(64);
    expect((JSON.parse(r.out) as { error: { code: string } }).error.code).toBe("E_DEMO_PRODUCTION_ENV");
    expect(judge.calls).toBe(0);
    expect(existsSync(journeysDir)).toBe(false);
  });
});
