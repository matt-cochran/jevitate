import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Page } from "playwright";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { runCoverageMission } from "./explore-api.js";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PersistedMissionResultSchema } from "@jevitate/domain";
import { parseScreenshotsArg, ScreenshotsArgError } from "./run-screenshots.js";

/**
 * #251 served acceptance: a Journey that visits 3 distinct screens over 6 steps (A → B → C, a
 * value typed on C, → A → B) run with `--screenshots` gives 3 screenshots (one per distinct screen,
 * deduplicated by the coverage page-state fingerprint — a typed value is not a new state) and with
 * `--screenshots steps` 6, each with an `index.md` contact sheet (image, step, route, what happened).
 * The secret parameter — shown as text on B and typed into a field on C — is masked in every image
 * (pixel-checked over the element's measured box) and appears in no written text.
 */

const SECRET = "S3cr3t-Tok-9f7";

const html = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title><style>body{margin:24px;font:16px sans-serif;background:#fff}</style></head><body><h1>${title}</h1>${body}</body></html>`;
const PAGES: Record<string, string> = {
  "/a": html("Alpha", `<a href="/b">To B</a>`),
  "/b": html("Bravo", `<p>Your token: <span id="s">${SECRET}</span></p><a href="/c">To C</a>`),
  "/c": html("Charlie", `<label>Note <input id="note" size="30"></label> <a href="/a">To A</a>`),
};

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = PAGES[(req.url ?? "").split("?")[0] ?? ""];
    if (page !== undefined) return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jev-251-"));
  const journey: Journey = {
    metadata: {
      id: "tour",
      name: "Tour three screens",
      promoted: false,
      params: ["token"],
      parameters: [{ name: "token", description: "an API token", secret: true }],
      createdAtIso: "2026-09-29T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/a",
          steps: [
            { step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { role: "heading", name: "Alpha" } } }, objective: "Open Alpha" },
            { step: { kind: "click", target: { role: "link", name: "To B" }, expect: { kind: "visible", target: { role: "heading", name: "Bravo" } } } },
            { step: { kind: "click", label: "Go to Charlie", target: { role: "link", name: "To C" }, expect: { kind: "visible", target: { role: "heading", name: "Charlie" } } } },
            {
              step: { kind: "fill", target: { label: "Note" }, value: { var: "token" }, expect: { kind: "visible", target: { label: "Note" } } },
              variableName: "token",
              objective: `Type the token ${SECRET} as a note`,
            },
            { step: { kind: "click", target: { role: "link", name: "To A" }, expect: { kind: "visible", target: { role: "heading", name: "Alpha" } } } },
            { step: { kind: "click", target: { role: "link", name: "To B" }, expect: { kind: "visible", target: { role: "heading", name: "Bravo" } } } },
          ],
        },
      ],
    },
  };
  await new FsJourneyStore(join(dir, "journeys")).put(journey);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** Share of magenta pixels in `png` over each rect (decoded in the browser). */
async function magentaShare(p: Page, png: Buffer, rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): Promise<number[]> {
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
        const d = g.getImageData(Math.floor(r.x), Math.floor(r.y), Math.max(1, Math.ceil(r.width)), Math.max(1, Math.ceil(r.height))).data;
        let hit = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) hit++;
        return hit / (d.length / 4);
      });
    },
    { src: `data:image/png;base64,${png.toString("base64")}`, rects: rects.map((r) => ({ ...r })) },
  );
}

async function run(mode: "screens" | "steps", out: string): Promise<Awaited<ReturnType<typeof runJourneyProgrammatically>>> {
  return runJourneyProgrammatically({
    dir: join(dir, "journeys"),
    id: "tour",
    params: { token: SECRET },
    browserPortFactory: () => new PlaywrightBrowserPort(),
    screenshots: { mode, dir: out },
  });
}

describe("--screenshots (served, real Chromium)", () => {
  it(
    "screens mode: 3 distinct screens over 6 steps → 3 screenshots + index.md; steps mode → 6; secret masked in every image, absent from the index",
    async () => {
      const screens = await run("screens", join(dir, "screens"));
      expect(screens.outcome).toBe("ok");
      expect(screens.screenshotPaths).toHaveLength(3);
      expect(screens.screenshotsSkipped).toBeUndefined();
      // The first capture of each screen: step 1 (A), step 2 (B), step 3 (C).
      expect(screens.screenshotPaths?.map((p) => basename(p))).toEqual(["01-step-01.png", "02-step-02.png", "03-step-03.png"]);

      const steps = await run("steps", join(dir, "steps"));
      expect(steps.outcome).toBe("ok");
      expect(steps.screenshotPaths).toHaveLength(6);

      for (const r of [screens, steps]) {
        const index = readFileSync(r.screenshotIndex ?? "", "utf8");
        expect(index).not.toContain(SECRET);
        for (const p of r.screenshotPaths ?? []) {
          expect(existsSync(p)).toBe(true);
          expect(index).toContain(`](${basename(p)})`);
        }
      }
      const index = readFileSync(steps.screenshotIndex ?? "", "utf8");
      expect(index).toContain("Mode: one per step · 6 screenshot(s) over 6 step(s)");
      expect(index).toMatch(/## 2\. Step 2 · `\/b`/);
      expect(index).toContain("**What happened:** Go to Charlie");
      expect(index).toContain("Type the token «redacted» as a note");

      // Pixels: measure where the secret renders (an unmasked browser, same default viewport), then
      // prove every image of B (steps 2, 6) and of C after typing (step 4) is the mask colour there.
      const port = new PlaywrightBrowserPort();
      const probe = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      try {
        await probe.page.goto(`${origin}/b`);
        const text = await probe.page.locator("#s").boundingBox();
        await probe.page.goto(`${origin}/c`);
        await probe.page.locator("#note").fill(SECRET);
        const field = await probe.page.locator("#note").boundingBox();
        if (text === null || field === null) throw new Error("no boxes");
        const shots = steps.screenshotPaths ?? [];
        const [b2] = await magentaShare(probe.page, readFileSync(shots[1]!), [text]);
        const [c4] = await magentaShare(probe.page, readFileSync(shots[3]!), [field]);
        const [b6] = await magentaShare(probe.page, readFileSync(shots[5]!), [text]);
        expect([b2, c4, b6]).toEqual([1, 1, 1]);
        // Control: an unmasked image of B is not the mask colour there.
        const bare = await probe.page.goto(`${origin}/b`).then(() => probe.page.screenshot());
        const [ctl] = await magentaShare(probe.page, bare, [text]);
        expect(ctl).toBeLessThan(0.5);
      } finally {
        await probe.close();
      }
    },
    180_000,
  );

  it(
    "an explore strategy (coverage) captures one screenshot per distinct screen, listed in the result and the persisted file",
    async () => {
      const outDir = join(dir, "cov");
      const r = await runCoverageMission({
        url: `${origin}/a`,
        allowlist: [origin],
        judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
        gen: new FakeGenerationGateway(),
        bounds: { maxActions: 6 },
        outDir,
        browserPortFactory: () => new PlaywrightBrowserPort(),
        screenshots: { mode: "screens" },
      });
      const shots = r.screenshotPaths ?? [];
      expect(shots.length).toBeGreaterThanOrEqual(1);
      expect(new Set(shots).size).toBe(shots.length);
      for (const p of shots) expect(existsSync(p)).toBe(true);
      expect(r.screenshotIndex).toMatch(/coverage-.*\.screenshots\/index\.md$/);
      const persisted = PersistedMissionResultSchema.parse(JSON.parse(readFileSync(r.resultPath, "utf8")));
      expect(persisted.result.screenshotPaths).toEqual(shots);
    },
    180_000,
  );

  it("parses --screenshots values and refuses an unusable one (exit 64, nothing runs)", async () => {
    expect(parseScreenshotsArg(true)).toEqual({ mode: "screens" });
    expect(parseScreenshotsArg("steps")).toEqual({ mode: "steps" });
    expect(parseScreenshotsArg("steps:/tmp/x")).toEqual({ mode: "steps", dir: "/tmp/x" });
    expect(parseScreenshotsArg("/tmp/y")).toEqual({ mode: "screens", dir: "/tmp/y" });
    expect(() => parseScreenshotsArg("")).toThrow(ScreenshotsArgError);
    expect(() => parseScreenshotsArg("steps:")).toThrow(ScreenshotsArgError);

    const err: string[] = [];
    const program = buildProgram({
      profiles: new ProfileManager("/unused"),
      journeysDir: join(dir, "journeys"),
      dbPath: join(dir, "no-site-policy.sqlite"),
      explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
    });
    program.configureOutput({ writeOut: () => undefined, writeErr: (s) => err.push(s) });
    const override = (c: Command): void => {
      c.exitOverride();
      c.commands.forEach(override);
    };
    override(program);
    process.exitCode = undefined;
    await program.parseAsync(["journey", "run", "tour", "--param", `token=${SECRET}`, "--screenshots", "steps:", "--json"], { from: "user" });
    expect(process.exitCode).toBe(64);
    process.exitCode = undefined;
  });
});
