import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { DEMO_OVERLAY_ATTR, DEMO_OVERLAY_HIDE_STYLE } from "@jevitate/explore";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { TITLE_CARD_MIN_MS, demoJourney } from "./journey-demo-api.js";
import type { CaptureLayer } from "./demo-capture.js";

/**
 * #248 served e2e: `jevitate journey demo` replays a Journey with objectives in real (headless)
 * Chromium against a served page and writes a WebM video, a `.vtt` whose cues are the steps' captions
 * (count, order, text), and a Markdown guide with one screenshot per step — the overlay live on the
 * page at capture time but absent from every screenshot, and a secret parameter in no output. A
 * Journey whose target is gone is a stale demo: exit 1, a clear message, nothing written.
 */

const SECRET = "S3cr3t-Tok-9";
const PACE = "50";

const APP = `<!doctype html><html><head><title>Settings</title></head><body style="background:#fff"><main>
  <h1 id="h">Settings</h1>
  <label>API token <input id="tok" type="password" aria-label="API token"></label>
  <button type="button" id="save">Save</button>
  <p data-testid="status"></p>
  <script>
    document.getElementById("save").onclick = () => {
      document.querySelector("[data-testid=status]").textContent = "Saved";
    };
  </script></main></body></html>`;

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-demo-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** Step 1 has an objective, step 2 an objective quoting the secret, step 3 only a label (the fallback). */
function tokenJourney(saveTarget = "Save"): Journey {
  return {
    metadata: {
      id: "token",
      name: "Save an API token",
      goal: `Store the API token ${SECRET} for the integration`,
      promoted: false,
      params: ["apiToken"],
      parameters: [{ name: "apiToken", description: "the token to save", secret: true }],
      preconditions: [{ description: "An account with the integrations page enabled", login: true }],
      successCriteria: [{ description: "The page says Saved" }],
      createdAtIso: "2026-09-29T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/app",
          steps: [
            {
              step: { kind: "navigate", url: "/app", expect: { kind: "visible", target: { role: "heading", name: "Settings" } } },
              objective: "Open the settings page",
              expectedResult: "The Settings page is shown",
            },
            {
              step: { kind: "fill", target: { label: "API token" }, value: { var: "apiToken" }, expect: { kind: "visible", target: { label: "API token" } } },
              variableName: "apiToken",
              objective: `Paste the token ${SECRET} into the API token field`,
            },
            {
              step: { kind: "click", label: "Save the token", target: { role: "button", name: saveTarget }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } },
              expectedResult: "The page says Saved",
            },
          ],
        },
      ],
    },
  };
}

const CAPTIONS = ["Open the settings page", "Paste the token «redacted» into the API token field", "Save the token"];

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

/** WebVTT cues: `{ id, start, end, text }` (times in ms). */
function parseVtt(vtt: string): Array<{ id: string; start: number; end: number; text: string }> {
  const ms = (t: string): number => {
    const [h, m, s] = t.split(":");
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
  };
  return vtt
    .split(/\n\n+/)
    .map((block) => block.split("\n"))
    .filter((lines) => lines[1]?.includes("-->") === true)
    .map((lines) => {
      const [start, end] = (lines[1] ?? "").split(" --> ");
      return { id: lines[0] ?? "", start: ms(start ?? ""), end: ms(end ?? ""), text: lines.slice(2).join("\n").trim() };
    });
}

describe("jevitate journey demo — served (#248)", () => {
  it(
    "writes a video, step-timed subtitles and a guide with one screenshot per step; no secret in any output",
    async () => {
      const journeysDir = join(dir, "j1");
      await new FsJourneyStore(journeysDir).put(tokenJourney());
      const video = join(dir, "out1", "token.webm");
      const guide = join(dir, "out1", "token-guide.md");

      const r = await cli(journeysDir, ["journey", "demo", "token", "--param", `apiToken=${SECRET}`, "--video", video, "--guide", guide, "--pace", PACE, "--json"]);
      expect(r.err).toBe("");
      expect(r.exitCode).toBe(0);
      const env = JSON.parse(r.out) as { ok: boolean; data: { outcome: string; video: string; subtitles: string; guide: string; steps: Array<{ number: number; caption: string; screenshot: string }> } };
      expect(env.ok).toBe(true);
      expect(env.data.outcome).toBe("ok");
      expect(env.data.video).toBe(video);
      expect(env.data.subtitles).toBe(join(dir, "out1", "token.vtt"));
      expect(env.data.guide).toBe(guide);

      // The video: a non-empty WebM (EBML magic).
      const webm = readFileSync(video);
      expect(webm.length).toBeGreaterThan(1000);
      expect(webm.subarray(0, 4).toString("hex")).toBe("1a45dfa3");

      // The subtitles: one cue per step, in order, the caption as text, timed forward.
      const vtt = readFileSync(env.data.subtitles, "utf8");
      expect(vtt.startsWith("WEBVTT\n")).toBe(true);
      const cues = parseVtt(vtt);
      expect(cues.map((c) => c.id)).toEqual(["step-1", "step-2", "step-3"]);
      expect(cues.map((c) => c.text)).toEqual(CAPTIONS);
      for (const [i, c] of cues.entries()) {
        expect(c.end).toBeGreaterThan(c.start);
        expect(c.end - c.start).toBeGreaterThanOrEqual(Number(PACE));
        if (i > 0) expect(c.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
      }

      // The guide: goal, preconditions, and per step number, caption, expected result and a screenshot.
      const md = readFileSync(guide, "utf8");
      expect(md).toContain("# Save an API token");
      expect(md).toContain("**Goal:** Store the API token «redacted» for the integration");
      expect(md).toContain("- An account with the integrations page enabled (signed in)");
      expect(md).toContain("### 1. Open the settings page");
      expect(md).toContain("**Expected result:** The Settings page is shown");
      expect(md).toContain("### 3. Save the token");
      expect(md).toContain("## When it worked");
      const images = [...md.matchAll(/!\[Step (\d+):[^\]]*\]\(([^)]+)\)/g)];
      expect(images.map((m) => m[1])).toEqual(["1", "2", "3"]);
      const assets = join(dir, "out1", "token-guide.assets");
      expect(readdirSync(assets).sort()).toEqual(["step-01.png", "step-02.png", "step-03.png"]);
      for (const m of images) {
        const png = readFileSync(join(dir, "out1", decodeURI(m[2]!)));
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      }

      // No secret anywhere: captions/subtitles, guide, the envelope, stderr.
      for (const text of [vtt, md, r.out, r.err]) expect(text).not.toContain(SECRET);
      expect(vtt + md).toContain("«redacted»");
    },
    120_000,
  );

  it(
    "the video opens on the title card and its cues line up with the video's own timeline",
    async () => {
      const journeysDir = join(dir, "j4");
      await new FsJourneyStore(journeysDir).put(tokenJourney());
      const video = join(dir, "out4", "token.webm");
      const pace = 600;
      const result = await demoJourney({
        dir: journeysDir,
        id: "token",
        params: { apiToken: SECRET },
        video,
        paceMs: pace,
        browserPortFactory: () => new PlaywrightBrowserPort(),
      });
      expect(result.outcome).toBe("ok");
      const cues = parseVtt(readFileSync(join(dir, "out4", "token.vtt"), "utf8"));
      const first = cues[0]!;
      // Cues count from the video's first frame: step 1 starts right after the title card is held
      // (never seconds later, which is what a clock started before the recorder had frames gave).
      expect(first.start).toBeGreaterThanOrEqual(TITLE_CARD_MIN_MS - 50);
      expect(first.start).toBeLessThan(TITLE_CARD_MIN_MS + 2500);

      // Decode the WebM in Chromium and look at the frames around the first cue: just before it the
      // title card (its blue banner) is on screen; just after it, the step-1 caption (a dark panel), no card.
      const reader = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      try {
        await reader.page.goto(`${origin}/app`);
        const frames = await reader.page.evaluate(
          async ({ src, times }) => {
            const v = document.createElement("video");
            v.muted = true;
            v.src = src;
            await new Promise((r, j) => {
              v.onloadeddata = r;
              v.onerror = () => j(new Error("video decode failed"));
            });
            if (!Number.isFinite(v.duration)) {
              v.currentTime = 1e6;
              await new Promise((r) => (v.ontimeupdate = r));
            }
            const c = document.createElement("canvas");
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const g = c.getContext("2d")!;
            const out: { t: number; title: number; dark: number }[] = [];
            for (const t of times) {
              v.currentTime = Math.max(0, t);
              await new Promise((r) => (v.onseeked = r));
              g.drawImage(v, 0, 0);
              const d = g.getImageData(0, 0, c.width, c.height).data;
              let title = 0;
              let dark = 0;
              for (let i = 0; i < d.length; i += 4) {
                const [r, gr, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
                if (b > 110 && b - r > 60 && b - gr > 40 && r < 90) title++; // the title card's blue
                else if (r < 45 && gr < 50 && b < 70) dark++; // the caption panel
              }
              out.push({ t, title: title / (d.length / 4), dark: dark / (d.length / 4) });
            }
            return out;
          },
          { src: `data:video/webm;base64,${readFileSync(video).toString("base64")}`, times: [(first.start - 400) / 1000, (first.start + pace / 2) / 1000] },
        );
        const [card, caption] = frames;
        expect(card!.title, JSON.stringify(frames)).toBeGreaterThan(0.01);
        expect(caption!.title, JSON.stringify(frames)).toBeLessThan(0.002);
        expect(caption!.dark, JSON.stringify(frames)).toBeGreaterThan(0.004);
      } finally {
        await reader.close();
      }
    },
    120_000,
  );

  it(
    "the overlay is on the page at every capture, yet absent from every screenshot",
    async () => {
      const journeysDir = join(dir, "j2");
      await new FsJourneyStore(journeysDir).put(tokenJourney());
      const guide = join(dir, "out2", "guide.md");
      const probes: Array<{ step: number; overlayInDom: number; raw: Buffer; hidden: Buffer }> = [];
      // A probing layer (the plug-in point pixel masking will use): it looks at the page just before the capture.
      const probe: CaptureLayer = {
        name: "probe",
        prepare: async (page, ctx) => {
          probes.push({
            step: ctx.step,
            overlayInDom: await page.locator(`[${DEMO_OVERLAY_ATTR}]`).count(),
            raw: await page.screenshot({ animations: "disabled" }),
            hidden: await page.screenshot({ animations: "disabled", style: DEMO_OVERLAY_HIDE_STYLE }),
          });
        },
      };
      const result = await demoJourney({
        dir: journeysDir,
        id: "token",
        params: { apiToken: SECRET },
        guide,
        paceMs: 50,
        captureLayers: [probe],
        browserPortFactory: () => new PlaywrightBrowserPort(),
      });
      expect(result.outcome).toBe("ok");
      expect(probes.map((p) => p.step)).toEqual([1, 2, 3]);
      for (const p of probes) {
        expect(p.overlayInDom).toBe(1); // the caption was live on the page…
        expect(p.raw.equals(p.hidden)).toBe(false); // …and visible in a plain capture…
        const written = readFileSync(join(dir, "out2", "guide.assets", `step-0${p.step}.png`));
        expect(written.equals(p.hidden)).toBe(true); // …but the guide's screenshot is the overlay-free one.
      }
    },
    120_000,
  );

  it(
    "a stale Journey (its target is gone) exits 1 with a clear message and writes nothing",
    async () => {
      const journeysDir = join(dir, "j3");
      await new FsJourneyStore(journeysDir).put(tokenJourney("Save changes"));
      const video = join(dir, "out3", "token.webm");
      const guide = join(dir, "out3", "guide.md");

      const r = await cli(journeysDir, ["journey", "demo", "token", "--param", `apiToken=${SECRET}`, "--video", video, "--guide", guide, "--pace", "0"]);
      expect(r.exitCode).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain("error: demo of journey 'token' is stale: it no longer replays (stopped at step 3 of 3)");
      expect(r.err).toContain("nothing was written");
      expect(r.err).not.toContain(SECRET);
      expect(existsSync(video)).toBe(false);
      expect(existsSync(join(dir, "out3", "token.vtt"))).toBe(false);
      expect(existsSync(guide)).toBe(false);
    },
    120_000,
  );

  it("refuses an unusable output or pace before any browser opens (exit 64)", async () => {
    const journeysDir = join(dir, "j4");
    await new FsJourneyStore(journeysDir).put(tokenJourney());
    for (const args of [["--video", join(dir, "x.mp4")], ["--guide", join(dir, "x.txt")], ["--pace", "60001"], ["--pace", "fast"]]) {
      const r = await cli(journeysDir, ["journey", "demo", "token", "--param", `apiToken=${SECRET}`, ...args, "--json"]).catch((err: { exitCode?: number }) => ({
        out: "",
        err: "",
        exitCode: err.exitCode,
      }));
      expect(r.exitCode, args.join(" ")).toBe(64);
    }
  });
});
