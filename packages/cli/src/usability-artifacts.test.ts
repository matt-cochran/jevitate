import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { parseSecretField } from "@jevitate/explore";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { Recording } from "@jevitate/recording";
import { runUsabilityMission } from "./ux-api.js";

/**
 * #98 + #96 end to end on REAL Chromium: a usability run writes the goal/adversarial artifact shape
 * next to its report — per-step screenshots (secret-bearing elements masked), a transcript carrying
 * each step's redacted typed value and screenshot, and a Recording — and reports signal findings
 * (duplicate write, internal id, inert control) citing step, request, text and screenshot.
 *
 * Secret canary: a registered secret rendered as page text, a bound secret field typed by code, and
 * a pre-filled password field. No canary may appear in any artifact (bytes of every file written),
 * and the screenshots must show the mask color over each of those elements.
 */

const REGISTERED = `jev canary/${randomUUID()}`;
const KEY = `keycanary-${randomUUID()}`;
const PASSWORD = `pwcanary-${randomUUID()}`;
const INTERNAL_ID = "3f2b8c1e-9a4d-4e7f-8b21-6c5d4a3b2e10";
const launches: number[] = [];

// Controls (DOM order): [0] Title, [1] API key, [2] Password, [3] Launch, [4] Double down.
const PAGE = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
  <h1 id="head" style="margin:0;padding:8px;height:40px">Bet 7</h1>
  <p>Decision maker ${INTERNAL_ID}</p>
  <p id="tok" style="display:inline-block;padding:8px">Token ${REGISTERED}</p>
  <div><label for="title">Title</label> <input id="title" /></div>
  <div><label for="key">API key</label> <input id="key" style="width:320px" /></div>
  <div><label for="pw">Password</label> <input id="pw" type="password" value="${PASSWORD}" /></div>
  <button id="launch" type="button">Launch</button>
  <button type="button">Double down</button>
  <p id="out"></p>
  <script>
    document.getElementById("launch").addEventListener("click", async () => {
      const r = await fetch("/api/launch", { method: "POST" });
      document.getElementById("out").textContent = "Launched (" + r.status + ")";
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;
const shots = new Map<string, Buffer>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST" && path === "/api/launch") {
      launches.push(Date.now());
      res.writeHead(201, { "content-type": "application/json" }).end(`{"ok":true}`);
      return;
    }
    if (path?.startsWith("/__shot/")) {
      const png = shots.get(path.slice("/__shot/".length));
      if (png === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "image/png" }).end(png);
      return;
    }
    if (path === "/blank") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html><body></body></html>");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Plays the action script; answers every UX-rubric question benignly. */
function scriptedJudge(actions: readonly string[]): JudgmentPort {
  let i = 0;
  return {
    async systemOne({ questions }) {
      if ("action" in questions) {
        const value = actions[Math.min(i, actions.length - 1)]!;
        i += 1;
        return { action: { kind: "choice", value, confidence: 0.9 } };
      }
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (q.kind === "noul") out[key] = { kind: "noul", value: true, probability: 0.9 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.9 };
        else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.5 };
      }
      return out;
    },
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const forms = (v: string): string[] => [v, encodeURIComponent(v)];
const CANARIES = [...forms(REGISTERED), ...forms(KEY), ...forms(PASSWORD)];

describe("usability run artifacts (#98) and run-signal findings (#96) — served, real Chromium", () => {
  it(
    "writes masked per-step screenshots, a transcript with redacted typed values, a Recording, and cited signal findings; no secret in any artifact",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-usability-art-"));
      try {
        const secretFields = [parseSecretField("label=API key=env:APP_KEY", "value", { APP_KEY: KEY })];
        const result = await runUsabilityMission({
          url: `${origin}/app`,
          job: "launch the bet",
          allowlist: [origin],
          appContext: { appClass: "admin", job: "launch the bet" },
          judge: scriptedJudge(["type:0", "type:1", "click:3", "click:3", "click:4", "click:4", "click:4"]),
          gen: new FakeGenerationGateway(),
          secrets: [REGISTERED],
          secretFields,
          bounds: { maxDecisions: 7 },
          judgmentBudget: 2,
          minConfidence: 0,
          outDir,
          nowIso: () => "2026-09-24T00:00:00.000Z",
          browserPortFactory: () => new PlaywrightBrowserPort(),
        });

        // --- #98: the artifact shape, next to the report ---
        expect(result.reportPath).not.toBeNull();
        expect(result.recordingPath).toBe(join(outDir, "usability-2026-09-24T00-00-00-000Z.recording.json"));
        expect(result.transcriptPath).toBe(join(outDir, "usability-2026-09-24T00-00-00-000Z.transcript.json"));
        const recording = JSON.parse(readFileSync(result.recordingPath, "utf8")) as Recording;
        const steps = recording.pages.flatMap((p) => p.steps.map((s) => s.step));
        // Launch, then Double down: the second Launch is refused (#92 — its POST already succeeded and
        // the page offers no retry), so it never becomes a Recording step.
        expect(steps.filter((s) => s.kind === "click").length, result.stop).toBeGreaterThanOrEqual(2);
        expect(steps.filter((s) => s.kind === "fill").map((s) => (s.kind === "fill" ? s.value : null))).toEqual([
          { redacted: false, value: "value:Title" },
          { redacted: true, length: KEY.length },
        ]);

        expect(result.screenshots.length).toBeGreaterThanOrEqual(5);
        for (const shot of result.screenshots) {
          expect(shot.startsWith(result.screenshotDir)).toBe(true);
          expect(readFileSync(shot).subarray(1, 4).toString()).toBe("PNG");
        }
        const transcript = JSON.parse(readFileSync(result.transcriptPath, "utf8")) as Array<{
          step: number;
          op: string | null;
          value?: string;
          screenshot?: string;
          actOk: boolean;
        }>;
        const typed = transcript.filter((e) => e.op === "type");
        expect(typed.map((e) => e.value)).toEqual(["value:Title", "«secret:APP_KEY»"]);
        for (const e of transcript.filter((x) => x.op !== null)) {
          expect(e.screenshot, `step ${e.step} has a screenshot`).toBeDefined();
          expect(existsSync(e.screenshot!)).toBe(true);
        }

        // --- #96: signal findings, each citing its evidence ---
        // The run never repeats the side effect itself (#92): exactly one launch reached the server.
        expect(launches.length).toBe(1);
        const findings = result.report!.findings;
        const byId = (id: string) => findings.find((f) => f.rubricItemId === id);
        const dup = byId("signal-duplicate-write");
        expect(dup, JSON.stringify(findings.map((f) => f.rubricItemId))).toBeDefined();
        expect(dup!.tier).toBe("signal");
        // The evidence is the successful POST plus the unguarded control the run refused to re-click.
        expect(dup!.signal!.requests.map((r) => [r.method, r.status])).toEqual([["POST", 201]]);
        expect(dup!.signal!.steps).toHaveLength(2);
        expect(dup!.observation).toMatch(/jevitate declined to repeat it/);
        const id = byId("signal-internal-id");
        expect(id!.quotes[0]).toContain(`Decision maker ${INTERNAL_ID}`);
        expect(id!.signal!.text).toContain(INTERNAL_ID);
        const inert = byId("signal-inert-control");
        expect(inert!.controls[0]).toContain("Double down");
        for (const f of [dup!, id!, inert!]) {
          expect(f.signal!.steps.length).toBeGreaterThan(0);
          expect(f.signal!.screenshot).toBeDefined();
          expect(existsSync(f.signal!.screenshot!)).toBe(true);
        }

        // --- secret canary: no secret in ANY artifact (JSON and PNG bytes alike) ---
        const files = filesUnder(outDir);
        expect(files.length).toBeGreaterThanOrEqual(result.screenshots.length + 3);
        for (const file of files) {
          const bytes = readFileSync(file).toString("latin1");
          for (const canary of CANARIES) expect(bytes.includes(canary), `${canary} in ${file}`).toBe(false);
        }
        expect(readFileSync(result.transcriptPath, "utf8")).toContain("«secret:APP_KEY»");
        expect(JSON.stringify(result.report)).not.toContain(REGISTERED);

        // --- the pixels: every secret-bearing element is covered by the mask color ---
        const last = result.screenshots[result.screenshots.length - 1]!;
        shots.set("last", readFileSync(last));
        const check = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
        try {
          await check.page.goto(`${origin}/app`);
          const centre = async (sel: string) => {
            const b = await check.page.locator(sel).boundingBox();
            if (b === null) throw new Error(`no box for ${sel}`);
            return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
          };
          const points = { key: await centre("#key"), pw: await centre("#pw"), tok: await centre("#tok"), head: await centre("#head") };
          await check.page.goto(`${origin}/blank`);
          const colors = await check.page.evaluate(async (pts) => {
            const img = new Image();
            img.src = "/__shot/last";
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const ctx = c.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            const out: Record<string, string> = {};
            for (const [k, p] of Object.entries(pts)) {
              const d = ctx.getImageData(p.x, p.y, 1, 1).data;
              out[k] = `${d[0]},${d[1]},${d[2]}`;
            }
            return out;
          }, points);
          expect(colors).toMatchObject({ key: "255,0,255", pw: "255,0,255", tok: "255,0,255" });
          expect(colors.head).not.toBe("255,0,255"); // the mask is targeted, not the whole page
        } finally {
          await check.close();
        }
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
