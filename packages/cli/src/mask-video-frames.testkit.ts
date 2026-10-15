import { readFileSync } from "node:fs";
import type { Page } from "playwright";

/**
 * TEST SUPPORT (#540, #547): decodes a recorded WebM in a real browser page and samples EVERY frame
 * over the given rects, so a pixel-mask test can prove no frame showed a secret unmasked. Shared by
 * the served pixel-mask suites; not used by the product.
 */

export type FrameRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * One rect in one frame: the share of mask-coloured (magenta) pixels, near-white (unpainted page)
 * pixels, near-black pixels (the encoder's pre-roll before the first screencast frame) and anything
 * else (page content — possibly the secret), so a failure says WHAT the frame showed.
 */
export interface FrameSample {
  readonly t: number;
  readonly end: number;
  readonly mask: number;
  readonly blank: number;
  readonly dark: number;
  readonly other: number;
}

/**
 * Every frame (25 fps, mid-frame seeks) of the video at `videoPath`, per rect. `reader` is any open
 * page (it decodes the video; a page of the served origin is enough); `viewport` is the recorded
 * page's CSS viewport, which the rects are in.
 */
export async function sampleVideoFrames(
  reader: Page,
  videoPath: string,
  rects: readonly FrameRect[],
  viewport: { readonly width: number; readonly height: number } = { width: 800, height: 600 },
): Promise<FrameSample[][]> {
  const webm = readFileSync(videoPath).toString("base64");
  return reader.evaluate(
    async ({ src, rects, vw, vh }) => {
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
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      const sx = v.videoWidth / vw;
      const sy = v.videoHeight / vh;
      const out: { t: number; end: number; mask: number; blank: number; dark: number; other: number }[][] = [];
      // Mid-frame times (a 25 fps frame lasts 0.04 s), so each seek lands inside one frame.
      for (let t = 0.02; t < end; t += 0.04) {
        v.currentTime = t;
        await new Promise((r) => (v.onseeked = r));
        g.drawImage(v, 0, 0);
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
            let dark = 0;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i]! > 180 && d[i + 1]! < 90 && d[i + 2]! > 180) mask++;
              else if (d[i]! > 235 && d[i + 1]! > 235 && d[i + 2]! > 235) blank++;
              else if (d[i]! < 20 && d[i + 1]! < 20 && d[i + 2]! < 20) dark++;
            }
            const n = d.length / 4;
            return { t: v.currentTime, end, mask: mask / n, blank: blank / n, dark: dark / n, other: (n - mask - blank - dark) / n };
          }),
        );
      }
      return out;
    },
    { src: `data:video/webm;base64,${webm}`, rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })), vw: viewport.width, vh: viewport.height },
  );
}

/** A readable description of one sample (never the pixels themselves). */
export function describeSample(i: number, s: FrameSample): string {
  return `rect ${i} at t=${s.t.toFixed(2)}s of ${s.end.toFixed(2)}s: mask ${s.mask.toFixed(2)}, blank ${s.blank.toFixed(2)}, dark ${s.dark.toFixed(2)}, other ${s.other.toFixed(2)} (other = page content, possibly the secret)`;
}

/** A sample is safe when it is the mask colour, or not painted yet (page white, or the encoder's black pre-roll). */
export function sampleIsSafe(s: FrameSample): boolean {
  return s.mask > 0.9 || s.blank > 0.95 || s.dark > 0.95;
}

/** Every unsafe sample of every frame, described — empty when no frame showed page content over a rect. */
export function unmaskedSamples(frames: readonly (readonly FrameSample[])[]): string[] {
  const out: string[] = [];
  for (const frame of frames) for (const [i, s] of frame.entries()) if (!sampleIsSafe(s)) out.push(describeSample(i, s));
  return out;
}
