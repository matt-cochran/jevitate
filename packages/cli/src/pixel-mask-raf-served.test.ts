import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PlaywrightBrowserPort, type BrowserPort, type BrowserSession } from "@jevitate/playwright";
import { SecretPixelMask, captureStepScreenshot, maskingPort } from "./demo-capture.js";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { sampleVideoFrames, unmaskedSamples, type FrameRect } from "./mask-video-frames.testkit.js";

/**
 * #547: the pixel mask re-measures on requestAnimationFrame, before each paint. A page (a polyfill,
 * an animation library, a test hook) or a script that runs before the mask (another init script,
 * Playwright's page.clock) can replace requestAnimationFrame with a timer-driven fake that is not
 * tied to paints. The mask uses only the browser's own requestAnimationFrame, captured before any
 * page script; when the one it finds is not the browser's own, it fails closed: the whole viewport
 * is painted in the mask colour, every proof fails and a capture is refused (`untrusted-primitive`).
 */

const SECRET = "sk_live_ZXQ9-SECRET-4242";
/** A timer-driven requestAnimationFrame (fires on a 50 ms timer, not before a paint). */
const TIMER_RAF = "window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 50); window.cancelAnimationFrame = (id) => clearTimeout(id);";
/** A MutationObserver that never reports a mutation. */
const DEAF_OBSERVER = "window.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };";
const VIEWPORT = { width: 800, height: 600 };

let server: Server;
let origin: string;

/** The secret blinks on and off 11 times (120 ms apart), then stays: each first frame of it must be masked. */
const BLINK = `<p><span id="blink" style="font:16px monospace"></span></p>
<script>
  let n = 0;
  const el = document.getElementById("blink");
  const iv = setInterval(() => {
    n++;
    el.textContent = n % 2 === 1 ? "${SECRET}" : "";
    if (n >= 11) { clearInterval(iv); el.textContent = "${SECRET}"; window.__done = true; }
  }, 120);
</script>`;

const doc = (head: string, body: string): string =>
  `<!doctype html><html><head>${head}<style>body{margin:24px;font:16px sans-serif;background:#fff}</style></head><body><h1>Keys</h1>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (h: string): void => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(h);
    if (req.url === "/page-shim") return html(doc(`<script>${TIMER_RAF}</script>`, BLINK));
    if (req.url === "/plain") return html(doc("", BLINK));
    if (req.url === "/static") return html(doc("", `<p id="text">Your API key is ${SECRET}.</p>`));
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A port whose sessions run `script` in every new document BEFORE the mask's init script. */
function earlierInitScript(script: string): BrowserPort {
  const inner = new PlaywrightBrowserPort();
  return {
    open: async (o) => {
      const s = await inner.open(o);
      await s.page.context().addInitScript({ content: script });
      return s;
    },
  };
}

/** A port whose sessions have Playwright's page.clock installed BEFORE the mask. */
function pageClockFirst(): BrowserPort {
  const inner = new PlaywrightBrowserPort();
  return {
    open: async (o) => {
      const s = await inner.open(o);
      await s.page.context().clock.install({ time: 0 });
      return s;
    },
  };
}

async function open(base: BrowserPort, recordDir?: string): Promise<{ session: BrowserSession; mask: SecretPixelMask }> {
  const mask = new SecretPixelMask([SECRET]);
  const session = await maskingPort(base, mask).open({
    headless: true,
    allowedOrigins: [origin],
    baseUrl: origin,
    viewport: VIEWPORT,
    ...(recordDir === undefined ? {} : { recordVideo: { dir: recordDir } }),
  });
  return { session, mask };
}

/** The secret's text box (what the mask covers), once the blinking is over. */
async function secretRect(p: Page): Promise<FrameRect> {
  await p.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true);
  return p.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById("blink")!);
    const b = r.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
}

/** Records `path` while the secret blinks, then samples every frame of the video over the secret. */
async function recordBlink(base: BrowserPort, path: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "jev-mask-raf-"));
  try {
    const { session } = await open(base, dir);
    let videoPath: string | undefined;
    let rect: FrameRect;
    try {
      await session.page.goto(`${origin}${path}`);
      rect = await secretRect(session.page);
      await session.page.waitForTimeout(300);
      videoPath = session.videoPath;
    } finally {
      await session.close();
    }
    if (videoPath === undefined || !existsSync(videoPath)) throw new Error("no video was recorded");
    const reader = await open(new PlaywrightBrowserPort());
    try {
      await reader.session.page.goto(`${origin}/static`);
      const frames = await sampleVideoFrames(reader.session.page, videoPath, [rect], VIEWPORT);
      // The load and 11 blinks over ~1.6 s: dozens of frames, not a lucky one or two.
      if (frames.length < 25) throw new Error(`only ${frames.length} frames were recorded`);
      return unmaskedSamples(frames);
    } finally {
      await reader.session.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The share of the viewport's pixels that are the mask colour (magenta), in a raw screenshot. */
async function viewportMaskShare(p: Page): Promise<number> {
  const png = await p.screenshot();
  return p.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let hit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) hit++;
    return hit / (d.length / 4);
  }, `data:image/png;base64,${png.toString("base64")}`);
}

describe("[realtime] #547: a replaced requestAnimationFrame never lets a secret into a video frame (served, real Chromium)", () => {
  it(
    "records no unmasked frame when the page's own script replaces requestAnimationFrame with a timer shim",
    async () => {
      expect(await recordBlink(new PlaywrightBrowserPort(), "/page-shim")).toEqual([]);
    },
    120_000,
  );

  it(
    "records no unmasked frame when an earlier init script replaces requestAnimationFrame before the mask loads",
    async () => {
      expect(await recordBlink(earlierInitScript(TIMER_RAF), "/plain")).toEqual([]);
    },
    120_000,
  );
});

describe("#547: the mask fails closed without the browser's own primitives (served, real Chromium)", () => {
  // The page keeps the browser's own clock: page.clock would itself replace requestAnimationFrame.
  useSkippingTime({ per: "all", pageClock: false });

  it(
    "proves the mask when the page's own script replaced requestAnimationFrame after the mask loaded",
    async () => {
      const { session, mask } = await open(new PlaywrightBrowserPort());
      try {
        await session.page.goto(`${origin}/page-shim`);
        await secretRect(session.page);
        expect((await mask.verify(session.page)).ok).toBe(true);
      } finally {
        await session.close();
      }
    },
    60_000,
  );

  it(
    "refuses a screenshot with reason untrusted-primitive when an earlier init script replaced requestAnimationFrame",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-mask-raf-shot-"));
      const { session, mask } = await open(earlierInitScript(TIMER_RAF));
      try {
        await session.page.goto(`${origin}/static`);
        await expect(captureStepScreenshot(session.page, join(dir, "shot.png"), { step: 1 }, [mask.layer()])).rejects.toMatchObject({
          code: "E_PIXEL_MASK",
          reason: "untrusted-primitive",
        });
      } finally {
        await session.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "writes no screenshot file when an earlier init script replaced requestAnimationFrame",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-mask-raf-file-"));
      const { session, mask } = await open(earlierInitScript(TIMER_RAF));
      const file = join(dir, "shot.png");
      try {
        await session.page.goto(`${origin}/static`);
        await captureStepScreenshot(session.page, file, { step: 1 }, [mask.layer()]).catch(() => undefined);
        expect(existsSync(file)).toBe(false);
      } finally {
        await session.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "paints the whole viewport in the mask colour when an earlier init script replaced requestAnimationFrame",
    async () => {
      const { session } = await open(earlierInitScript(TIMER_RAF));
      try {
        await session.page.goto(`${origin}/static`);
        expect(await viewportMaskShare(session.page)).toBe(1);
      } finally {
        await session.close();
      }
    },
    60_000,
  );

  it(
    "names the replaced MutationObserver when an earlier init script replaced it",
    async () => {
      const { session, mask } = await open(earlierInitScript(DEAF_OBSERVER));
      try {
        await session.page.goto(`${origin}/static`);
        expect((await mask.verify(session.page)).reason).toMatch(/MutationObserver is not the browser's own/);
      } finally {
        await session.close();
      }
    },
    60_000,
  );

  it(
    "refuses to open a masked session with reason untrusted-primitive when page.clock was installed first",
    async () => {
      await expect(open(pageClockFirst())).rejects.toMatchObject({ code: "E_PIXEL_MASK", reason: "untrusted-primitive" });
    },
    60_000,
  );
});
