import type { Locator, Page } from "playwright";
import { DEMO_OVERLAY_HIDE_STYLE } from "@jevitate/explore";

/**
 * #248 — the ONE place a demo screenshot is taken. The overlay is always hidden (Playwright's
 * `screenshot({ style })`, applied only for the capture: the page's DOM is never touched), and the
 * capture is built from LAYERS so later safety passes plug in without touching the callers: pixel
 * masking of secret fields (#250/#251) is a layer contributing `mask` locators and/or extra `style`.
 * A layer cannot drop the overlay-hiding style: styles are concatenated, never replaced.
 */

/** What a layer adds to one capture. */
export interface CaptureContribution {
  /** Extra CSS applied only while capturing (appended after the overlay-hiding style). */
  readonly style?: string;
  /** Elements painted over in the image (Playwright `mask`). */
  readonly mask?: readonly Locator[];
  /** The mask colour (Playwright `maskColor`); the last layer that sets one wins. */
  readonly maskColor?: string;
}

/** Where in the demo a capture is taken. */
export interface CaptureContext {
  /** 1-based step number. */
  readonly step: number;
}

/** A capture layer: consulted just before each screenshot. It must not change the page. */
export interface CaptureLayer {
  readonly name: string;
  prepare(page: Page, ctx: CaptureContext): Promise<CaptureContribution | void>;
}

/** The screenshot options a set of layers produces (the overlay-hiding style always first). */
export async function captureOptions(
  page: Page,
  ctx: CaptureContext,
  layers: readonly CaptureLayer[],
): Promise<{ style: string; mask: Locator[]; maskColor?: string }> {
  const styles = [DEMO_OVERLAY_HIDE_STYLE];
  const mask: Locator[] = [];
  let maskColor: string | undefined;
  for (const layer of layers) {
    const c = await layer.prepare(page, ctx);
    if (c === undefined) continue;
    if (c.style !== undefined && c.style !== "") styles.push(c.style);
    if (c.mask !== undefined) mask.push(...c.mask);
    if (c.maskColor !== undefined) maskColor = c.maskColor;
  }
  return { style: styles.join("\n"), mask, ...(maskColor === undefined ? {} : { maskColor }) };
}

/** Writes one step's PNG at `path`: the viewport, overlay hidden, every layer applied. Throws on failure. */
export async function captureStepScreenshot(page: Page, path: string, ctx: CaptureContext, layers: readonly CaptureLayer[] = []): Promise<void> {
  const { style, mask, maskColor } = await captureOptions(page, ctx, layers);
  await page.screenshot({
    path,
    type: "png",
    animations: "disabled",
    style,
    ...(mask.length === 0 ? {} : { mask }),
    ...(maskColor === undefined ? {} : { maskColor }),
  });
}
