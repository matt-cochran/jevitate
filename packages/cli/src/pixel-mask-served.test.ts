import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { DemoOverlay } from "@jevitate/explore";
import { MaskUnavailableError, PIXEL_MASK_ATTR, SecretPixelMask, captureStepScreenshot, maskingPort } from "./demo-capture.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #250/#251 hard requirement — secrets masked in PIXELS, in real Chromium: a served page shows a
 * registered secret in a text node, in a (non-password) input's value and in a `title` attribute.
 * The display-only mask layer covers every occurrence — proven at capture time by the DOM check
 * (every occurrence rect under a painted box) AND by the pixels themselves (every pixel of every
 * occurrence rect is the mask colour, in the screenshot and in the recorded video's frames). The
 * page's own DOM is never changed, the demo overlay never appears in a capture, and a capture whose
 * mask cannot be proven (a secret in a top-layer modal) is refused — no file written.
 */

const SECRET = "sk_live_ZXQ9-SECRET-4242";
let server: Server;
let origin: string;

const page = (body: string): string => `<!doctype html><html><head><style>body{margin:24px;font:16px sans-serif;background:#fff}</style></head><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (b: string): void => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(b));
    if (req.url === "/secret")
      return html(`<h1>Account</h1>
<p id="text">Your API key is ${SECRET} — keep it safe.</p>
<p><input id="field" size="40" value="${SECRET}"></p>
<p><span id="titled" title="${SECRET}" style="display:inline-block;padding:4px;background:#eee">key (hover for value)</span></p>
<p><input id="pw" type="password" value="hunter2-not-registered"></p>
<p id="late"></p>
<script>setTimeout(() => { document.getElementById("late").textContent = "Late: ${SECRET}"; }, 400);</script>`);
    if (req.url === "/modal")
      return html(`<h1>Modal</h1><dialog id="d"><p>Key: ${SECRET}</p></dialog><script>document.getElementById("d").showModal();</script>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Rect = { x: number; y: number; width: number; height: number };

/** Decodes a PNG in the browser and returns, per rect, the share of its pixels within `tol` of magenta. */
async function magentaShare(p: Page, png: Buffer, rects: readonly Rect[], tol = 0): Promise<number[]> {
  return p.evaluate(
    async ({ src, rects, tol }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return rects.map((r) => {
        const x = Math.max(0, Math.floor(r.x));
        const y = Math.max(0, Math.floor(r.y));
        const w = Math.max(1, Math.ceil(r.width));
        const h = Math.max(1, Math.ceil(r.height));
        const d = g.getImageData(x, y, w, h).data;
        let hit = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - 255) <= tol && d[i + 1]! <= tol && Math.abs(d[i + 2]! - 255) <= tol) hit++;
        return hit / (d.length / 4);
      });
    },
    { src: `data:image/png;base64,${png.toString("base64")}`, rects: rects.map((r) => ({ ...r })), tol },
  );
}

async function open(recordDir?: string, secrets: readonly string[] = [SECRET]): Promise<{ session: BrowserSession; mask: SecretPixelMask }> {
  const mask = new SecretPixelMask(secrets);
  const port = maskingPort(new PlaywrightBrowserPort(), mask);
  const session = await port.open({
    headless: true,
    allowedOrigins: [origin],
    baseUrl: origin,
    viewport: { width: 800, height: 600 },
    ...(recordDir === undefined ? {} : { recordVideo: { dir: recordDir } }),
  });
  return { session, mask };
}

describe("pixel masking of registered secrets (served, real Chromium)", () => {
  it(
    "masks the secret in a text node, an input value and a title — DOM-proven and pixel-proven in the screenshot; overlay hidden; page untouched",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-mask-shot-"));
      const { session, mask } = await open();
      try {
        const p = session.page;
        await p.goto(`${origin}/secret`);
        await p.waitForFunction(() => (document.getElementById("late")?.textContent ?? "") !== "");
        // The demo overlay is on screen (a title card at the top) but never in a capture.
        await new DemoOverlay([SECRET]).card(p, "DEMO TITLE CARD", "title");

        const check = await mask.verify(p);
        // text node + input value + title attribute + the late text node; the password field is not one.
        expect(check).toMatchObject({ ok: true, occurrences: 4, masked: 4 });

        const file = join(dir, "shot.png");
        await captureStepScreenshot(p, file, { step: 1 }, [mask.layer()]);
        const png = readFileSync(file);
        // Every pixel of every occurrence is the mask colour (lossless PNG: exact).
        const shares = await magentaShare(p, png, check.rects);
        expect(shares).toEqual(check.rects.map(() => 1));
        // Each kind of occurrence is among them: the text, the field, the titled element.
        const box = async (sel: string): Promise<Rect> => {
          const b = await p.locator(sel).boundingBox();
          if (b === null) throw new Error(`no box for ${sel}`);
          return b;
        };
        const fieldShare = await magentaShare(p, png, [await box("#field"), await box("#titled")]);
        expect(fieldShare).toEqual([1, 1]);
        // The overlay's title card (top centre, dark blue) is not in the image: the page's white is.
        const [top] = await p.evaluate(
          async (src) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext("2d")!;
            g.drawImage(img, 0, 0);
            return [Array.from(g.getImageData(400, 30, 1, 1).data)];
          },
          `data:image/png;base64,${png.toString("base64")}`,
        );
        expect(top).toEqual([255, 255, 255, 255]);
        // The page's own DOM holds no mask marks: only the display-only host on <html>.
        const marks = await p.evaluate(
          (attr) => ({
            inBody: document.body.querySelectorAll("[data-jevitate-mask], jevitate-mask").length,
            hosts: document.documentElement.querySelectorAll(`[${attr}]`).length,
            fieldValue: (document.getElementById("field") as HTMLInputElement).value,
          }),
          PIXEL_MASK_ATTR,
        );
        expect(marks.inBody).toBe(0);
        expect(marks.hosts).toBe(1);
        expect(marks.fieldValue).toBe(SECRET);
      } finally {
        await session.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "control: with no mask the same rects are NOT the mask colour (the pixel check is meaningful)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-mask-ctl-"));
      const masked = await open();
      const bare = await open(undefined, []);
      try {
        await masked.session.page.goto(`${origin}/secret`);
        await bare.session.page.goto(`${origin}/secret`);
        for (const s of [masked.session, bare.session]) await s.page.waitForFunction(() => (document.getElementById("late")?.textContent ?? "") !== "");
        const { rects } = await masked.mask.verify(masked.session.page);
        const file = join(dir, "bare.png");
        await captureStepScreenshot(bare.session.page, file, { step: 1 }, []);
        const shares = await magentaShare(bare.session.page, readFileSync(file), rects);
        for (const s of shares) expect(s).toBeLessThan(0.5);
      } finally {
        await masked.session.close();
        await bare.session.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "masks every video frame from the first paint: the recorded WebM's frames are the mask colour over every occurrence",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-mask-video-"));
      const { session, mask } = await open(dir);
      let videoPath: string | undefined;
      let rects: readonly Rect[] = [];
      try {
        const p = session.page;
        await p.goto(`${origin}/secret`);
        await p.waitForFunction(() => (document.getElementById("late")?.textContent ?? "") !== "");
        const check = await mask.assertMasked(p);
        rects = check.rects;
        await p.waitForTimeout(1200);
        videoPath = session.videoPath;
      } finally {
        await session.close();
      }
      const reader = await open(undefined, []);
      try {
        expect(videoPath).toBeDefined();
        expect(existsSync(videoPath!)).toBe(true);
        const webm = readFileSync(videoPath!).toString("base64");
        await reader.session.page.goto(`${origin}/secret`);
        // Decode the video in the browser, seek near its end (the late secret is on screen), sample.
        const shares = await reader.session.page.evaluate(
          async ({ src, rects }) => {
            const v = document.createElement("video");
            v.muted = true;
            v.src = src;
            await new Promise((r, j) => {
              v.onloadeddata = r;
              v.onerror = () => j(new Error("video decode failed"));
            });
            // WebM from a screencast may report Infinity duration until scanned to the end.
            if (!Number.isFinite(v.duration)) {
              v.currentTime = 1e6;
              await new Promise((r) => (v.ontimeupdate = r));
            }
            const end = v.duration;
            // Per rect: the share of mask-coloured pixels, near-white (unpainted) pixels, and anything
            // else (page content — possibly the secret), so a failure says WHAT the frame showed.
            const out: { t: number; mask: number; blank: number; other: number }[][] = [];
            for (const t of [end - 0.3, end - 0.8]) {
              v.currentTime = Math.max(0, t);
              await new Promise((r) => (v.onseeked = r));
              const c = document.createElement("canvas");
              c.width = v.videoWidth;
              c.height = v.videoHeight;
              const g = c.getContext("2d")!;
              g.drawImage(v, 0, 0);
              const sx = v.videoWidth / 800;
              const sy = v.videoHeight / 600;
              out.push(
                rects.map((r) => {
                  // The rect's interior (compression softens a box's edges).
                  const x = Math.floor(r.x * sx) + 2;
                  const y = Math.floor(r.y * sy) + 2;
                  const w = Math.max(1, Math.floor(r.width * sx) - 4);
                  const h = Math.max(1, Math.floor(r.height * sy) - 4);
                  const d = g.getImageData(x, y, w, h).data;
                  let mask = 0;
                  let blank = 0;
                  for (let i = 0; i < d.length; i += 4) {
                    if (d[i]! > 180 && d[i + 1]! < 90 && d[i + 2]! > 180) mask++;
                    else if (d[i]! > 235 && d[i + 1]! > 235 && d[i + 2]! > 235) blank++;
                  }
                  const n = d.length / 4;
                  return { t: v.currentTime, mask: mask / n, blank: blank / n, other: (n - mask - blank) / n };
                }),
              );
            }
            return out;
          },
          { src: `data:video/webm;base64,${webm}`, rects: rects.map((r) => ({ ...r })) },
        );
        expect(rects.length).toBe(4);
        for (const frame of shares) {
          for (const [i, s] of frame.entries()) {
            const saw = `rect ${i} at t=${s.t.toFixed(2)}s: mask ${s.mask.toFixed(2)}, blank ${s.blank.toFixed(2)}, other ${s.other.toFixed(2)} (other = page content, possibly the secret)`;
            expect(s.mask, saw).toBeGreaterThan(0.9);
          }
        }
      } finally {
        await reader.session.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "fails closed: a secret in a top-layer modal cannot be proven masked — the screenshot is refused and no file is written",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-mask-modal-"));
      const { session, mask } = await open();
      try {
        await session.page.goto(`${origin}/modal`);
        const check = await mask.verify(session.page);
        expect(check.ok).toBe(false);
        expect(check.reason).toMatch(/top-layer/);
        expect(check.reason).not.toContain(SECRET);
        const file = join(dir, "modal.png");
        await expect(captureStepScreenshot(session.page, file, { step: 1 }, [mask.layer()])).rejects.toBeInstanceOf(MaskUnavailableError);
        expect(existsSync(file)).toBe(false);
      } finally {
        await session.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
