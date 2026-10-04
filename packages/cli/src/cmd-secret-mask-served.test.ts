import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { parseSecretField } from "@jevitate/explore";
import { SecretPixelMask, captureStepScreenshot, maskingPort } from "./demo-capture.js";
import { runExploration } from "./explore-goal.js";
import { runUsabilityMission } from "./ux-api.js";
import { ScriptedJudge, useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #360 — a value a `cmd:` secret source reads mid-run (a one-time code) was redacted from text but
 * not from PIXELS: the run's pixel mask took its secret list when it was built, before the code
 * existed. `SecretPixelMask.addSecret` masks it from the moment it is read — in every live frame and
 * every later document — whatever its length (a 6-digit code is far below the 8-character floor of
 * what the mask learns on its own, #298). Real Chromium; pixels sampled from the PNG.
 */

const CODE = "482913";

let server: Server;
let origin: string;
const doc = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:24px;font:18px sans-serif;background:#fff}</style></head><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (b: string): void => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(doc(b));
    const path = (req.url ?? "").split("?")[0];
    if (path === "/verify-email")
      return html(`<h1>Verify your email</h1><p>We emailed you a 6-digit code.</p>
<form method="post" action="/verify"><label for="c">Verification code</label> <input id="c" name="c" autocomplete="off">
<button type="submit">Verify</button></form>`);
    if (req.method === "POST" && path === "/verify") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const got = new URLSearchParams(body).get("c") ?? "";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(doc(`<h1 data-testid="ok">Email verified</h1><p id="echo">Your code ${got} was accepted.</p>`));
      });
      return;
    }
    if (path === "/code") return html(`<h1>Code</h1><input id="field" value="${CODE}" size="10"><p id="text">Your code is ${CODE}.</p>`);
    if (path === "/next") return html(`<h1>Next</h1><p id="again">Code ${CODE} used.</p>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Rect = { x: number; y: number; width: number; height: number };
async function magentaShare(p: Page, png: Buffer, rects: readonly Rect[]): Promise<number[]> {
  return p.evaluate(
    async ({ src, rects }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return rects.map((r) => {
        const d = g.getImageData(Math.max(0, Math.floor(r.x)), Math.max(0, Math.floor(r.y)), Math.max(1, Math.ceil(r.width)), Math.max(1, Math.ceil(r.height))).data;
        let hit = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) hit++;
        return hit / (d.length / 4);
      });
    },
    { src: `data:image/png;base64,${png.toString("base64")}`, rects: rects.map((r) => ({ ...r })) },
  );
}

describe("a cmd: secret read mid-run is masked in pixels (#360)", () => {
  it("addSecret masks a short code in the live page and in every document after it; before it, the mask did not know it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cmd-mask-"));
    const mask = new SecretPixelMask([]);
    const session = await maskingPort(new PlaywrightBrowserPort(), mask).open({ headless: true, allowedOrigins: [origin], baseUrl: origin, viewport: { width: 900, height: 600 } });
    try {
      const p = session.page;
      await p.goto(`${origin}/code`);
      // The bug: a 6-digit code the run read mid-run was unknown to the mask (and too short to learn).
      expect(await mask.verify(p)).toMatchObject({ ok: true, occurrences: 0 });

      await mask.addSecret(CODE);
      const check = await mask.verify(p);
      expect(check.ok).toBe(true);
      expect(check.occurrences).toBeGreaterThanOrEqual(2); // the field and the sentence
      expect(check.masked).toBe(check.occurrences);
      const file = join(dir, "code.png");
      await captureStepScreenshot(p, file, { step: 1 }, [mask.layer()]);
      const png = readFileSync(file);
      expect(await magentaShare(p, png, check.rects)).toEqual(check.rects.map(() => 1));
      const field = (await p.locator("#field").boundingBox())!;
      expect((await magentaShare(p, png, [field]))[0]).toBe(1);

      // A later document (a navigation) has it from its first paint: the init script carries it.
      await p.goto(`${origin}/next`);
      expect(await mask.verify(p)).toMatchObject({ ok: true, occurrences: 1, masked: 1 });
      // Adding it again is a no-op.
      await mask.addSecret(CODE);
      expect(await mask.verify(p)).toMatchObject({ ok: true, occurrences: 1, masked: 1 });
    } finally {
      await session.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a goal run with --screenshots and video: the code is masked in every screenshot and absent from every written artifact", async () => {
    const out = await mkdtemp(join(tmpdir(), "jev-cmd-run-"));
    try {
      const secretFields = [parseSecretField("label=Verification code=cmd:./read-code.sh", "value", {}, { allowCmd: true })];
      // [0] Verification code, [1] Verify.
      const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]);
      const result = await runExploration({
        url: `${origin}/verify-email`,
        allowlist: [origin],
        goal: "Verify your email with the code we sent",
        successAssertion: { kind: "visible", target: { testId: "ok" } },
        judge,
        gen: new FakeGenerationGateway(),
        outDir: out,
        secretFields,
        secretCommand: async () => `${CODE}\n`,
        screenshots: { mode: "steps" },
        browser: { recordVideo: { dir: join(out, "video") } },
        browserPortFactory: () => new PlaywrightBrowserPort(),
      });
      const r = result as unknown as { goalOutcome: string; screenshotPaths?: string[]; screenshotsSkipped?: unknown[]; resultPath: string; videoPaths?: string[] };
      expect(r.goalOutcome).toBe("succeeded");
      // Every screenshot was taken (none refused for an unprovable mask), and the echo page is among them.
      expect(r.screenshotsSkipped ?? []).toEqual([]);
      const shots = r.screenshotPaths ?? [];
      expect(shots.length).toBeGreaterThanOrEqual(2);
      // The page echoed the code after the submit: the last screenshot must carry mask fill (the bug:
      // the mask never knew the code, so that screenshot showed it in clear and had no fill at all).
      const decoder = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      try {
        const png = readFileSync(shots[shots.length - 1]!);
        const whole = await decoder.page.evaluate(async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          return { w: img.naturalWidth, h: img.naturalHeight };
        }, `data:image/png;base64,${png.toString("base64")}`);
        const [share] = await magentaShare(decoder.page, png, [{ x: 0, y: 0, width: whole.w, height: whole.h }]);
        expect(share).toBeGreaterThan(0);
      } finally {
        await decoder.close();
      }
      expect((r.videoPaths ?? []).length).toBeGreaterThan(0);
      // No written artifact holds the code: result, transcript, Recording, index, issue drafts.
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const f = join(d, e.name);
          if (e.isDirectory()) walk(f);
          else files.push(f);
        }
      };
      walk(out);
      const text = files.filter((f) => /\.(json|md|txt|jsonl)$/.test(f));
      expect(text.length).toBeGreaterThan(0);
      for (const f of text) expect(readFileSync(f, "utf8"), f).not.toContain(CODE);
      expect(existsSync(r.resultPath)).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);

  it("a usability run types a cmd: field too (its runner reaches the engine), and the code is in no artifact", async () => {
    const out = await mkdtemp(join(tmpdir(), "jev-cmd-ux-"));
    let runs = 0;
    // Plays the action script; answers every UX question benignly.
    const actions = ["type:0", "click:1", "done"];
    let i = 0;
    const judge: JudgmentPort = {
      async systemOne({ questions }) {
        if ("action" in questions) return { action: { kind: "choice", value: actions[Math.min(i++, actions.length - 1)]!, confidence: 0.9 } };
        const answers: Record<string, Answer> = {};
        for (const [k, q] of Object.entries(questions)) {
          answers[k] = q.kind === "noul" ? { kind: "noul", value: false, probability: 0.1 } : q.kind === "score" ? { kind: "score", value: 0.1 } : { kind: "choice", value: q.options[0] ?? "", confidence: 0.5 };
        }
        return answers;
      },
    };
    try {
      const result = await runUsabilityMission({
        url: `${origin}/verify-email`,
        job: "verify your email with the code we sent",
        allowlist: [origin],
        appContext: { appClass: "consumer", job: "verify your email" },
        judge,
        gen: new FakeGenerationGateway(),
        secretFields: [parseSecretField("label=Verification code=cmd:./read-code.sh", "value", {}, { allowCmd: true })],
        secretCommand: async () => {
          runs += 1;
          return `${CODE}\n`;
        },
        bounds: { maxDecisions: 4 },
        judgmentBudget: 1,
        minConfidence: 0,
        outDir: out,
        browserPortFactory: () => new PlaywrightBrowserPort(),
      });
      expect(runs).toBe(1);
      const transcript = JSON.parse(readFileSync(result.transcriptPath, "utf8")) as Array<{ op: string; actOk: boolean }>;
      const typed = transcript.find((e) => e.op === "type");
      expect(typed?.actOk).toBe(true);
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (f: string) => files.push(f))(join(d, e.name));
      };
      walk(out);
      for (const f of files.filter((f) => /\.(json|md|txt|jsonl)$/.test(f))) expect(readFileSync(f, "utf8"), f).not.toContain(CODE);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);
});
