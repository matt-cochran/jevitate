import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { SecretPixelMask, captureStepScreenshot, maskingPort, revealedSecretsIn } from "./demo-capture.js";
import { RunScreenshots } from "./run-screenshots.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #298 — a secret the app REVEALS during the run (a freshly minted API key on a one-time reveal
 * panel) was never registered, so screenshots showed it in clear. With NO registered secret, the
 * mask now covers (a) elements the app marks as secret and (b) credential-shaped values — learned
 * for the rest of the run (masked where it reappears unmarked, scrubbed from the screenshot index).
 * Real Chromium; pixels sampled from the PNG.
 */

// An id.secret hex pair (the shape Preveti mints) and an unshaped token only a marker identifies.
const MINTED = "3f9a1c2b7d.4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b";
const MARKED_ONLY = "pvk9Q2x7Lm3nR8tZ";
const UUID = "123e4567-e89b-12d3-a456-426614174000";

let server: Server;
let origin: string;
const doc = (body: string): string =>
  `<!doctype html><html><head><style>body{margin:24px;font:16px sans-serif;background:#fff}</style></head><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (b: string): void => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(doc(b));
    if (req.url === "/keys")
      return html(`<h1>API keys</h1><label>Key name <input id="name" value="Matrix CI"></label>
<button id="create" onclick="document.getElementById('panel').hidden=false">Create key</button>
<div id="panel" hidden>
  <p>Copy it now — it will not be shown again.</p>
  <input id="keyfield" data-testid="new-key-secret" size="50" value="${MINTED}" readonly>
  <pre id="snippet">export PREVETI_API_KEY='${MINTED}'</pre>
  <p>Short code: <code id="marked" data-jevitate-mask>${MARKED_ONLY}</code></p>
</div>`);
    if (req.url === "/later") return html(`<h1>Integrations</h1><p id="again">Matrix CI uses <code>${MARKED_ONLY}</code></p>`);
    if (req.url === "/plain") return html(`<h1>Settings</h1><p>Request ${UUID} — Generate a report for Matrix CI.</p>`);
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

describe("pixel masking of secrets the app reveals mid-run (#298)", () => {
  it("credential shapes are recognised; ordinary text and ids are not", () => {
    expect(revealedSecretsIn(`export PREVETI_API_KEY='${MINTED}'`)).toEqual([MINTED]);
    expect(revealedSecretsIn(fakeStripeShapedKey() + " and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toHaveLength(2);
    expect(revealedSecretsIn(`Request ${UUID} — Generate a report for Matrix CI.`)).toEqual([]);
  });

  it(
    "with no registered secret: the revealed key, the marked code and its later unmarked reappearance are masked in pixels; the index never holds them",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-reveal-"));
      const mask = new SecretPixelMask([]);
      const session = await maskingPort(new PlaywrightBrowserPort(), mask).open({
        headless: true,
        allowedOrigins: [origin],
        baseUrl: origin,
        viewport: { width: 900, height: 600 },
      });
      try {
        const p = session.page;
        await p.goto(`${origin}/keys`);
        // Before the reveal: nothing secret on screen, the key-NAME field is not masked.
        expect(await mask.verify(p)).toMatchObject({ ok: true, occurrences: 0 });
        await p.click("#create");
        const check = await mask.verify(p);
        expect(check.ok).toBe(true);
        expect(check.occurrences).toBeGreaterThanOrEqual(3);
        expect(mask.revealed()).toEqual(expect.arrayContaining([MINTED, MARKED_ONLY]));
        const file = join(dir, "reveal.png");
        await captureStepScreenshot(p, file, { step: 1 }, [mask.layer()]);
        const png = readFileSync(file);
        expect(await magentaShare(p, png, check.rects)).toEqual(check.rects.map(() => 1));
        const box = async (sel: string): Promise<Rect> => (await p.locator(sel).boundingBox())!;
        // The whole key field, the key inside the export snippet and the marked code are covered.
        const [field, marked] = await magentaShare(p, png, [await box("#keyfield"), await box("#marked")]);
        expect(field).toBe(1);
        expect(marked).toBe(1);
        // The key name is not a secret: not masked.
        const [name] = await magentaShare(p, png, [await box("#name")]);
        expect(name).toBeLessThan(0.5);

        // Another screen: the marked-only code reappears with no marker and no credential shape.
        await p.goto(`${origin}/later`);
        const later = await mask.verify(p);
        expect(later).toMatchObject({ ok: true, occurrences: 1, masked: 1 });

        // The screenshot index scrubs what the app revealed (a step's "what happened" quoting the key).
        const shots = new RunScreenshots({ spec: { mode: "steps" }, dir, secrets: [], title: "keys", mask });
        await shots.capture(p, { step: 2, what: `report: the key is ${MINTED} (code ${MARKED_ONLY})` });
        const result = await shots.finish();
        const md = readFileSync(result.screenshotIndex, "utf8");
        expect(md).not.toContain(MINTED);
        expect(md).not.toContain(MARKED_ONLY);
        expect(md).toContain("«redacted»");
        expect(readdirSync(dir).some((f) => f.endsWith(".png"))).toBe(true);
      } finally {
        await session.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "a page with no secret marker and no credential shape is not masked (ids, words)",
    async () => {
      const mask = new SecretPixelMask([]);
      const session = await maskingPort(new PlaywrightBrowserPort(), mask).open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      try {
        await session.page.goto(`${origin}/plain`);
        expect(await mask.verify(session.page)).toMatchObject({ ok: true, occurrences: 0 });
        expect(mask.revealed()).toEqual([]);
      } finally {
        await session.close();
      }
    },
    60_000,
  );
});

/** A Stripe-shaped value made at test time: random, never a real key, and nothing key-like in the source. */
function fakeStripeShapedKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let body = "";
  for (let i = 0; i < 24; i += 1) body += alphabet[Math.floor(Math.random() * alphabet.length)];
  return ["sk", "live", body].join("_");
}
