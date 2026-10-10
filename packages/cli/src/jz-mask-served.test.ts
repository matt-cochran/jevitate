import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { JZ_MASK_FILLS, JzMaskUnprovenError, SecretPixelMask, captureStepScreenshot, maskingPort, type JzRegionKind } from "./demo-capture.js";
import { decodePng, type DecodedPng } from "./png-pixels.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #471 — jz-mask-v1 in real Chromium: every region kind the policy names is painted over in the
 * page before the screenshot (masked, placeholder, left out), proven per capture by the DOM check
 * and by the PNG's own pixels; a capture that cannot be proven is not written; a top document the
 * layer cannot prove during the run is reported (it voids the video).
 */

let server: Server;
let origin: string;

const doc = (body: string): string =>
  `<!doctype html><html><head><style>body{margin:16px;font:16px sans-serif;background:#fff}.b{display:block;margin:6px 0}</style></head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  "/regions": `
<input id="input" class="b" value="ada@example.com">
<textarea id="textarea" class="b">note text</textarea>
<select id="select" class="b"><option>Option A</option></select>
<div contenteditable="TRUE" class="b"><p id="inherited">edited text</p></div>
<div id="marked" data-jz-mask class="b" style="position:relative;height:20px;width:200px">masked<span id="overflow" style="position:absolute;left:300px;top:0">overflowing child</span></div>
<iframe id="iframe" class="b" srcdoc="<p>framed</p>" style="width:200px;height:60px"></iframe>
<video id="video" class="b" style="width:120px;height:40px;background:#123"></video>
<canvas id="canvas" class="b" width="120" height="30"></canvas>
<div id="blocked" data-jz-block class="b" style="height:24px">blocked text</div>
<p id="plain" class="b">plain text stays visible</p>`,
  "/modal": `<dialog id="d"><input value="inside a modal"></dialog><script>document.getElementById("d").showModal();</script>`,
  "/closed": `<x-card id="card"></x-card><script>
customElements.define("x-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<input value='hidden'>"; } });</script>`,
  "/late-modal": `<input value="field"><dialog id="d"><p>later</p></dialog><script>setTimeout(() => document.getElementById("d").showModal(), 200);</script>`,
  "/plain": `<input value="field"><p>nothing else</p>`,
  "/pseudo": `<style>[data-jz-mask]::after{content:"outside";position:absolute;left:400px}</style><div data-jz-mask style="position:relative;width:100px">marked</div>`,
  "/colour": `<input id="f" value="field" style="transition:border-color 5s linear;border:2px solid #000"><script>requestAnimationFrame(() => requestAnimationFrame(() => { document.getElementById("f").style.borderColor = "#f00"; }));</script>`,
  "/slide": `<style>@keyframes slide{from{transform:translateX(0)}to{transform:translateX(200px)}}</style><div style="animation:slide 5s linear infinite"><input value="field"></div>`,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? ""];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(doc(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function open(recordDir?: string): Promise<{ session: BrowserSession; mask: SecretPixelMask }> {
  const mask = new SecretPixelMask([], { jzMaskV1: true });
  const session = await maskingPort(new PlaywrightBrowserPort(), mask).open({
    headless: true,
    allowedOrigins: [origin],
    baseUrl: origin,
    viewport: { width: 800, height: 700 },
    ...(recordDir === undefined ? {} : { recordVideo: { dir: recordDir } }),
  });
  return { session, mask };
}

const rgb = (hex: string): number[] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The share of `box`'s pixels (CSS px, interior) that are exactly `hex`. */
function share(img: DecodedPng, box: { x: number; y: number; width: number; height: number }, hex: string): number {
  const [r, g, b] = rgb(hex);
  let hit = 0;
  let all = 0;
  for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++) {
    for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
      const i = (y * img.width + x) * 4;
      all++;
      if (img.rgba[i] === r && img.rgba[i + 1] === g && img.rgba[i + 2] === b) hit++;
    }
  }
  return all === 0 ? 0 : hit / all;
}

describe("jz-mask-v1 region kinds (served, real Chromium)", () => {
  let dir: string;
  let img: DecodedPng;
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  let regions: number | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-jz-"));
    const { session, mask } = await open();
    try {
      const p = session.page;
      await p.goto(`${origin}/regions`);
      for (const id of ["input", "textarea", "select", "inherited", "marked", "overflow", "iframe", "video", "canvas", "blocked", "plain"]) {
        const b = await p.locator(`#${id}`).boundingBox();
        if (b === null) throw new Error(`no box for #${id}`);
        boxes.set(id, b);
      }
      const jz = mask.jzLayer();
      const file = join(dir, "step-01.png");
      await captureStepScreenshot(p, file, { step: 1 }, [mask.layer(), jz]);
      img = decodePng(readFileSync(file));
      regions = jz.regions(1);
    } finally {
      await session.close();
    }
  }, 90_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, JzRegionKind]> = [
    ["input", "mask"],
    ["textarea", "mask"],
    ["select", "mask"],
    ["inherited", "mask"],
    ["marked", "mask"],
    ["overflow", "mask"],
    ["iframe", "placeholder"],
    ["video", "placeholder"],
    ["canvas", "placeholder"],
    ["blocked", "block"],
  ];
  for (const [id, kind] of cases) {
    it(`#${id} is painted with the ${kind} fill`, () => {
      expect(share(img, boxes.get(id)!, JZ_MASK_FILLS[kind])).toBe(1);
    });
  }

  it("plain text outside every region stays visible", () => {
    expect(share(img, boxes.get("plain")!, JZ_MASK_FILLS.mask)).toBe(0);
  });

  it("records the proven region count of the capture", () => {
    expect(regions).toBeGreaterThanOrEqual(cases.length);
  });
});

describe("jz-mask-v1 fails closed (served, real Chromium)", () => {
  async function attempt(path: string): Promise<{ error: unknown; written: boolean }> {
    const dir = await mkdtemp(join(tmpdir(), "jev-jz-fail-"));
    const { session, mask } = await open();
    try {
      await session.page.goto(`${origin}${path}`);
      const file = join(dir, "step-01.png");
      let error: unknown;
      try {
        await captureStepScreenshot(session.page, file, { step: 1 }, [mask.layer(), mask.jzLayer()]);
      } catch (e) {
        error = e;
      }
      return { error, written: existsSync(file) };
    } finally {
      await session.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("a field in a modal dialog (top layer) cannot be proven: the capture is refused", async () => {
    expect((await attempt("/modal")).error).toBeInstanceOf(JzMaskUnprovenError);
  }, 60_000);

  it("a refused capture writes no screenshot", async () => {
    expect((await attempt("/modal")).written).toBe(false);
  }, 60_000);

  it("a positioned ::after that can paint outside a masked region is unprovable", async () => {
    expect((await attempt("/pseudo")).error).toBeInstanceOf(JzMaskUnprovenError);
  }, 60_000);

  it("a closed shadow root it cannot see into is unprovable", async () => {
    expect((await attempt("/closed")).error).toBeInstanceOf(JzMaskUnprovenError);
  }, 60_000);
});

describe("jz-mask-v1 watches every frame of the top document (served, real Chromium)", () => {
  it("a modal that opens mid-run is reported as a breach (the video is void)", async () => {
    const { session, mask } = await open();
    try {
      await session.page.goto(`${origin}/late-modal`);
      await session.page.waitForFunction(() => (document.getElementById("d") as HTMLDialogElement).open);
      await session.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await mask.verify(session.page);
      expect(mask.jzBreaches().length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 60_000);

  async function breachesOn(path: string): Promise<readonly string[]> {
    const { session, mask } = await open();
    try {
      await session.page.goto(`${origin}${path}`);
      await session.page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
      await mask.verify(session.page);
      return mask.jzBreaches();
    } finally {
      await session.close();
    }
  }

  it("a colour transition on a field moves nothing: no breach", async () => {
    expect(await breachesOn("/colour")).toEqual([]);
  }, 60_000);

  it("a transform animation moving a field is a breach", async () => {
    expect(await breachesOn("/slide")).toContainEqual(expect.stringMatching(/animation moved/));
  }, 60_000);

  it("a page the layer covers throughout reports no breach", async () => {
    const { session, mask } = await open();
    try {
      await session.page.goto(`${origin}/plain`);
      await mask.verify(session.page);
      expect(mask.jzBreaches()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe("jz-mask-v1 in the recorded video (served, real Chromium)", () => {
  it("the field is the mask fill in the recorded WebM's frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-jz-video-"));
    const { session } = await open(dir);
    let videoPath: string | undefined;
    let box: { x: number; y: number; width: number; height: number } | null = null;
    try {
      await session.page.goto(`${origin}/plain`);
      box = await session.page.locator("input").boundingBox();
      await session.page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
      videoPath = session.videoPath;
    } finally {
      await session.close();
    }
    const reader = await open();
    try {
      await reader.session.page.goto(`${origin}/plain`);
      const [mr, mg, mb] = rgb(JZ_MASK_FILLS.mask);
      // BROWSER CODE: decode the WebM, seek near its end and twice before, sample the field's interior.
      const shares = await reader.session.page.evaluate(
        async ({ src, r, fill }) => {
          const v = document.createElement("video");
          v.muted = true;
          v.src = src;
          await new Promise((ok, bad) => {
            v.onloadeddata = ok;
            v.onerror = () => bad(new Error("video decode failed"));
          });
          if (!Number.isFinite(v.duration)) {
            v.currentTime = 1e6;
            await new Promise((ok) => (v.ontimeupdate = ok));
          }
          const out: number[] = [];
          for (const t of [v.duration - 0.2, v.duration - 0.6, v.duration - 1.0]) {
            v.currentTime = Math.max(0, t);
            await new Promise((ok) => (v.onseeked = ok));
            const c = document.createElement("canvas");
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const g = c.getContext("2d")!;
            g.drawImage(v, 0, 0);
            const sx = v.videoWidth / 800;
            const sy = v.videoHeight / 700;
            const d = g.getImageData(Math.floor(r.x * sx) + 2, Math.floor(r.y * sy) + 2, Math.max(1, Math.floor(r.width * sx) - 4), Math.max(1, Math.floor(r.height * sy) - 4)).data;
            let hit = 0;
            for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - fill[0]) <= 24 && Math.abs(d[i + 1]! - fill[1]) <= 24 && Math.abs(d[i + 2]! - fill[2]) <= 24) hit++;
            out.push(hit / (d.length / 4));
          }
          return out;
        },
        { src: `data:video/webm;base64,${readFileSync(videoPath!).toString("base64")}`, r: box!, fill: [mr, mg, mb] as [number, number, number] },
      );
      expect(Math.min(...shares)).toBeGreaterThan(0.9);
    } finally {
      await reader.session.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
