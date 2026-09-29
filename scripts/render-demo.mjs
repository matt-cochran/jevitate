#!/usr/bin/env node
// Renders the README / website demo (docs/assets/demo.{gif,mp4,webm} + demo-poster.png) from a REAL
// run against the example app (apps/example-site, /demo/profile). Nothing in the footage is staged:
//
//   1. `journey demo` replays a small Journey (goal title card, captioned steps): the user saves the
//      display name "Zoë 😀" and the page says "Saved".
//   2. `explore --strategy adversarial --evidence-video` finds the planted bug; the HTTP 500
//      defect's evidence clip replays its repro and marks the Save click that sent the failing
//      request ("server returned 500 (PUT /demo/api/profile)").
//   3. `verify-fix` (3/3 still reproduces), `regression capture` + `regression run` (reproduces).
//   4. The app restarts with the fix; `verify-fix --record-video` on the 500 gives the captioned
//      "after" clip (fixed), and the regression passes.
//
// The only added frames are an intro, one interstitial and an end card (rendered from HTML by
// Playwright). The end card's lines are built from the commands' actual verdicts, and the script
// refuses to render when a verdict is not the expected one.
//
// Usage: pnpm demo:render [--out <dir>] [--keep] [--compose-only <work dir kept by --keep>]
//   --compose-only re-cuts and re-encodes an earlier recording (its manifest.json) without re-running.
//   Needs a built CLI (`pnpm -r build`), Playwright's Chromium, and `ffmpeg` on PATH (libx264,
//   libvpx-vp9). No API keys: the run uses --fake-ai (models never decide a finding anyway).

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outDir = resolve(repo, args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs/assets");
const keep = args.includes("--keep");
const composeOnly = args.includes("--compose-only") ? resolve(args[args.indexOf("--compose-only") + 1] ?? "") : null;

const cli = join(repo, "packages/cli/dist/bin.js");
const siteServe = join(repo, "apps/example-site/dist/serve.js");
const invariants = join(repo, "apps/example-site/demo-invariants.json");

/** Output size; the browser records at 720x450 (the whole form, "Saved" included) and is scaled up. */
const W = 800;
const H = 500;
const REC = "720x450";

function die(msg) {
  console.error(`render-demo: ${msg}`);
  process.exit(1);
}

// ---- preflight: every tool is required; nothing falls back ---------------------------------------
const ff = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
if (ff.error !== undefined || ff.status !== 0) {
  die("ffmpeg was not found on PATH. Install ffmpeg (with libx264 and libvpx) and run again; nothing was rendered.");
}
const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
for (const enc of ["libx264", "libvpx-vp9"]) if (!encoders.includes(enc)) die(`this ffmpeg has no ${enc} encoder; nothing was rendered.`);
if (!existsSync(cli)) die(`no built CLI at ${cli}: run \`pnpm -r build\` first.`);
if (!existsSync(siteServe)) die(`no built example site at ${siteServe}: run \`pnpm -r build\` first.`);
const { chromium } = createRequire(join(repo, "packages/cli/package.json"))("playwright");

const work = composeOnly ?? mkdtempSync(join(tmpdir(), "jevitate-demo-"));
if (composeOnly !== null && !existsSync(join(work, "manifest.json"))) die(`no manifest.json in ${work} (record once with --keep)`);
// Children get a throwaway HOME, so nothing from (or into) the operator's ~/.jevitate is used.
const childEnv = {
  ...process.env,
  HOME: join(work, "home"),
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright"),
  NO_COLOR: "1",
};
mkdirSync(childEnv.HOME, { recursive: true });
console.log(`render-demo: working in ${work}`);

let site = null;
process.on("exit", () => {
  if (site !== null) site.kill("SIGTERM");
  if (!keep && composeOnly === null) rmSync(work, { recursive: true, force: true });
});

// ---- helpers -------------------------------------------------------------------------------------
function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function startSite(port, fixed) {
  const child = spawn(process.execPath, [siteServe], {
    env: { ...process.env, PORT: String(port), DEMO_FIXED: fixed ? "1" : "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("the example site did not start within 20 s")), 20_000);
    child.stdout.on("data", (b) => {
      if (String(b).includes("example site:")) {
        clearTimeout(t);
        ok();
      }
    });
    child.once("exit", (code) => fail(new Error(`the example site exited (${code})`)));
  });
  return child;
}

async function stopSite() {
  if (site === null) return;
  const s = site;
  site = null;
  await new Promise((ok) => {
    s.once("exit", ok);
    s.kill("SIGTERM");
  });
}

/** Runs the CLI; returns { code, out }. `expect` is the exit code the step must end with. */
function jev(label, cliArgs, expect) {
  console.log(`render-demo: ${label}`);
  const r = spawnSync(process.execPath, [cli, ...cliArgs], { cwd: work, env: childEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== expect) {
    process.stderr.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    die(`${label}: expected exit ${expect}, got ${r.status}`);
  }
  return { code: r.status, out: r.stdout };
}

function jsonData(label, out) {
  try {
    return JSON.parse(out).data;
  } catch {
    return die(`${label}: the --json output did not parse`);
  }
}

function ffmpeg(ffArgs) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...ffArgs], { encoding: "utf8" });
  if (r.status !== 0) die(`ffmpeg ${ffArgs.join(" ")}\n${r.stderr}`);
}

function durationOf(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file], { encoding: "utf8" });
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr ?? "");
  if (m === null) return die(`cannot read the duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** A plain title frame (PNG) rendered by Chromium. */
async function card(browser, file, { kicker, title, lines = [], foot }) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    main{height:100%;box-sizing:border-box;padding:48px 56px;display:flex;flex-direction:column;justify-content:center;gap:14px}
    .k{font:600 15px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd}
    h1{margin:0;font-size:34px;line-height:1.2;font-weight:700;color:#f8fafc}
    ul{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
    li{font-size:20px;line-height:1.3}
    li::before{content:"✓";color:#4ade80;font-weight:700;margin-right:12px}
    .f{margin-top:10px;font-size:15px;color:#94a3b8}
  </style></head><body><main>
    ${kicker === undefined ? "" : `<div class="k">${esc(kicker)}</div>`}
    <h1>${esc(title)}</h1>
    ${lines.length === 0 ? "" : `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`}
    ${foot === undefined ? "" : `<div class="f">${esc(foot)}</div>`}
  </main></body></html>`);
  await page.screenshot({ path: file });
  await page.close();
}

// ---- 1. record -----------------------------------------------------------------------------------
async function record() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  site = await startSite(port, false);

  const journeysDir = join(work, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  const GOAL = "Change your display name to Zoë 😀";
  writeFileSync(
    join(journeysDir, "change-display-name.json"),
    JSON.stringify(
      {
        metadata: {
          id: "change-display-name",
          name: "Change your display name",
          description: "Profile settings on the example app: save a new display name",
          goal: GOAL,
          persona: "A signed-in user",
          promoted: false,
          params: [],
          authoredBy: "human-demonstration",
          successCriteria: [{ description: "The page says Saved" }],
          createdAtIso: "2026-09-29T00:00:00.000Z",
        },
        recording: {
          version: "1",
          site: origin,
          pages: [
            {
              url: "/demo/profile",
              steps: [
                {
                  step: { kind: "navigate", url: "/demo/profile", expect: { kind: "visible", target: { role: "heading", name: "Profile settings" } } },
                  objective: "Open Profile settings",
                  expectedResult: "The profile form is shown",
                },
                {
                  step: {
                    kind: "fill",
                    target: { role: "textbox", name: "Display name" },
                    value: { redacted: false, value: "Zoë 😀" },
                    expect: { kind: "visible", target: { role: "textbox", name: "Display name" } },
                  },
                  objective: "Type the new display name: Zoë 😀",
                },
                {
                  step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } },
                  objective: "Click Save",
                  expectedResult: "The page says Saved",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  const journeyVideo = join(work, "journey", "journey.webm");
  jev(
    "journey demo (the user's view: Zoë 😀 → Saved)",
    ["journey", "demo", "change-display-name", "--dir", journeysDir, "--base-url", origin, "--viewport", REC, "--pace", "2500", "--video", journeyVideo],
    0,
  );

  const runs = join(work, "runs");
  const explore = jev(
    "explore --strategy adversarial --evidence-video (~2 min)",
    ["explore", "--strategy", "adversarial", "--url", `${origin}/demo/profile`, "--invariants", invariants, "--viewport", REC, "--fake-ai", "--evidence-video", "--out", runs, "--json"],
    1,
  );
  const run = jsonData("explore", explore.out);
  if (run.outcome !== "defects-found") die(`explore: outcome ${run.outcome}, expected defects-found`);
  const d500 = run.defects.find((d) => d.kind === "http-5xx");
  const dInv = run.defects.find((d) => d.kind === "invariant");
  if (d500 === undefined || dInv === undefined) die("explore: expected both an http-5xx and an invariant defect");
  const ev = d500.evidence;
  // The 500's clip must replay to the step that SENT the failing request (the Save click), see the
  // 500 fire again, and mark it with the request's method and path.
  if (ev?.videoPath === undefined || ev.replay?.outcome !== "completed" || ev.reproduced !== true || !existsSync(ev.videoPath)) {
    die(`explore: the HTTP 500 defect has no complete, reproduced evidence clip (${JSON.stringify(ev)})`);
  }
  if (!/^server returned 500 \(PUT \/demo\/api\/profile\)$/.test(ev.signal ?? "")) die(`explore: the 500's clip is marked "${ev.signal}", expected "server returned 500 (PUT /demo/api/profile)"`);
  const runRecording = JSON.parse(readFileSync(run.resultPath.replace(/\.result\.json$/, ".json"), "utf8"));
  const replayed = d500.repro?.recording ?? runRecording.recording ?? runRecording;
  const marked = replayed.pages.flatMap((p) => p.steps)[ev.failingStep - 1]?.step;
  if (marked?.kind !== "click" || !JSON.stringify(marked.target ?? {}).includes('"Save"')) die(`explore: the 500's clip marks step ${ev.failingStep} (${JSON.stringify(marked)}), expected the Save click`);
  const resultPath = run.resultPath;
  const recordingPath = resultPath.replace(/\.result\.json$/, ".json");

  const vf500 = jsonData("verify-fix", jev("verify-fix (HTTP 500, bug present)", ["verify-fix", "--result", resultPath, "--fingerprint", d500.fingerprint, "--json"], 1).out);
  if (vf500.verdict !== "still-reproduces") die(`verify-fix: verdict ${vf500.verdict}, expected still-reproduces`);
  const replays = /(\d+)\/(\d+) replay/.exec(vf500.reason ?? "");
  if (replays === null) die(`verify-fix: cannot read the replay count from "${vf500.reason}"`);

  const regDir = join(work, "regressions");
  jev("regression capture", ["regression", "capture", "--from", recordingPath, "--result", resultPath, "--fingerprint", dInv.fingerprint, "--id", "saved-means-stored", "--dir", regDir], 0);
  jev("regression run (bug present → reproduces)", ["regression", "run", "saved-means-stored", "--dir", regDir], 1);

  await stopSite();
  site = await startSite(port, true);
  const vfAfter = jsonData(
    "verify-fix after the fix",
    jev(
      "verify-fix --record-video (fix on)",
      ["verify-fix", "--result", resultPath, "--fingerprint", d500.fingerprint, "--record-video", join(work, "vf"), "--json"],
      0,
    ).out,
  );
  if (vfAfter.verdict !== "fixed") die(`verify-fix after the fix: verdict ${vfAfter.verdict}, expected fixed`);
  const afterClip = vfAfter.evidence?.after?.videoPath;
  if (afterClip === undefined || !existsSync(afterClip)) die("verify-fix --record-video wrote no after clip");
  jev("regression run (fix on → fixed)", ["regression", "run", "saved-means-stored", "--dir", regDir], 0);
  await stopSite();
  const manifest = { journeyVideo, evidenceVideo: ev.videoPath, failingStep: ev.failingStep, signal: ev.signal, afterClip, replays: [Number(replays[1]), Number(replays[2])] };
  writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

const m = composeOnly === null ? await record() : JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));

// ---- 2. compose ----------------------------------------------------------------------------------
const seg = join(work, "seg");
rmSync(seg, { recursive: true, force: true });
mkdirSync(seg, { recursive: true });
const browser = await chromium.launch();
try {
  await card(browser, join(seg, "intro.png"), {
    kicker: "Jevitate in action · a real run",
    title: "A profile form says “Saved”. Is it?",
    lines: [],
    foot: "Journey: “Change your display name to Zoë 😀” · the example app in this repo · no API keys",
  });
  await card(browser, join(seg, "mid.png"), {
    kicker: "explore --strategy adversarial --evidence-video",
    title: "The page said “Saved”. The server returned HTTP 500 and kept the old name.",
    foot: `Jevitate misused the form and caught it. Its evidence clip replays the repro and marks the step that sent the failing request:`,
  });
  await card(browser, join(seg, "end.png"), {
    kicker: "Decided by code, not by a model",
    title: "Found, reproduced, locked in, fixed",
    lines: [
      "HTTP 500 + invariant “saved-means-stored” violated",
      `verify-fix: still reproduces on ${m.replays[0]}/${m.replays[1]} fresh replays`,
      "regression captured: fails before the fix, passes after",
      "with the fix: verify-fix → fixed",
    ],
    foot: "jevitate.com · github.com/matt-cochran/jevitate",
  });
} finally {
  await browser.close();
}

// Every segment is normalised to 800x450, 25 fps; the concat filter joins them.
const NORM = `scale=${W}:${H}:flags=lanczos,fps=25,format=yuv420p,setsar=1`;
const segments = [];
const still = (png, seconds) => segments.push({ input: ["-loop", "1", "-t", String(seconds), "-i", png], vf: NORM });
const clip = (src, from, to, speed = 1) =>
  segments.push({ input: ["-ss", from.toFixed(2), "-to", to.toFixed(2), "-i", src], vf: `setpts=(PTS-STARTPTS)/${speed},${NORM}` });

still(join(seg, "intro.png"), 1.6);
// The Journey demo from its first frame (the goal title card), captioned steps at 2.5x ("Saved" and
// the Done card at the end).
const jd = durationOf(m.journeyVideo);
clip(m.journeyVideo, 0, jd - 0.1, 2.5);
still(join(seg, "mid.png"), 2.4);
// The HTTP 500's evidence clip: its last steps (the Save click captioned, then marked "✗ … server
// returned 500 (PUT /demo/api/profile)" with the red defect card).
const evd = durationOf(m.evidenceVideo);
clip(m.evidenceVideo, Math.max(0, evd - 4.75), evd - 0.15);
// verify-fix --record-video on the 500 with the fix on: the same Save, ending on the verdict card.
const afd = durationOf(m.afterClip);
clip(m.afterClip, Math.max(0, afd - 2.55), afd - 0.15);
still(join(seg, "end.png"), 3.2);

const master = join(seg, "master.mp4");
const graph =
  segments.map((sgm, i) => `[${i}:v]${sgm.vf}[v${i}]`).join(";") +
  ";" +
  segments.map((_, i) => `[v${i}]`).join("") +
  `concat=n=${segments.length}:v=1:a=0[out]`;
ffmpeg([...segments.flatMap((sgm) => sgm.input), "-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-crf", "10", "-preset", "veryfast", master]);

// ---- 3. export -----------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const gif = join(outDir, "demo.gif");
const mp4 = join(outDir, "demo.mp4");
const webm = join(outDir, "demo.webm");
const poster = join(outDir, "demo-poster.png");
// GIF: 12 fps, one palette, and repeated frames dropped (the GIF keeps their time as frame delay).
const gifChain = `fps=12,mpdecimate=hi=768:lo=320:frac=0.5:max=6,split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
ffmpeg(["-i", master, "-filter_complex", gifChain, "-fps_mode", "vfr", "-loop", "0", gif]);
ffmpeg(["-i", master, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-pix_fmt", "yuv420p", "-r", "20", "-movflags", "+faststart", mp4]);
ffmpeg(["-i", master, "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-row-mt", "1", "-pix_fmt", "yuv420p", "-r", "20", webm]);
ffmpeg(["-i", master, "-frames:v", "1", "-update", "1", poster]);

const kb = (f) => `${(statSync(f).size / 1024).toFixed(0)} KB`;
console.log(`render-demo: ${durationOf(master).toFixed(1)} s, ${W}x${H}`);
for (const f of [gif, mp4, webm, poster]) console.log(`  ${f} (${kb(f)})`);
if (keep) console.log(`render-demo: recording kept in ${work} (re-cut it with --compose-only ${work})`);
