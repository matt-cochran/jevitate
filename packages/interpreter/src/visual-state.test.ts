import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor, type Actor } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import { AssertionSchema, RecordingSchema, type Assertion, type Recording } from "@jevitate/recording";
import { compareStyle, parseColor, styleChannel } from "./css-values.js";
import { boxesOverlap, intersectionRatio, sizeViolation } from "./geometry.js";
import { checkAssertion, readAssertionEvidence } from "./assertion.js";
import { installFlashRecorder } from "./flash-recorder.js";
import { RecordingInterpreter } from "./interpreter.js";

/** #148 — visual-state assertions (style, geometry, attribute, flash) and rich-text replay. */

describe("css values (pure)", () => {
  it("parses computed and authored colors, and compares colors as colors", () => {
    expect(parseColor("rgba(255, 200, 0, 0.4)")).toEqual({ r: 255, g: 200, b: 0, a: 0.4 });
    expect(parseColor("rgb(1 2 3 / 50%)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor("#f00")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("transparent")?.a).toBe(0);
    expect(parseColor("bogus")).toBeNull();
    expect(compareStyle("rgb(255, 0, 0)", undefined, "=", "red")).toEqual({ held: true, observed: "rgb(255, 0, 0)" });
    expect(compareStyle("rgb(255, 0, 0)", undefined, "!=", "#ff0000")).toMatchObject({ held: false });
    expect(styleChannel("rgba(255, 200, 0, 0)", "alpha")).toBe(0);
    expect(compareStyle("rgba(255, 200, 0, 0.4)", "alpha", ">", "0")).toMatchObject({ held: true, observed: "0.4" });
    expect(compareStyle("3px", "px", ">=", "2")).toMatchObject({ held: true });
    expect(compareStyle("block", undefined, "=", "BLOCK")).toMatchObject({ held: true });
    // Unreadable is never "held".
    expect(compareStyle("none", "alpha", ">", "0")).toHaveProperty("unreadable");
    expect(compareStyle("block", undefined, ">", "1")).toHaveProperty("unreadable");
  });
});

describe("geometry (pure)", () => {
  const vp = { x: 0, y: 0, width: 100, height: 100 };
  it("intersection ratio, overlap and size bounds", () => {
    expect(intersectionRatio({ x: 0, y: 0, width: 10, height: 10 }, vp)).toBe(1);
    expect(intersectionRatio({ x: 0, y: 95, width: 10, height: 10 }, vp)).toBe(0.5);
    expect(intersectionRatio({ x: 0, y: 500, width: 10, height: 10 }, vp)).toBe(0);
    expect(intersectionRatio({ x: 0, y: 0, width: 0, height: 10 }, vp)).toBe(0);
    expect(boxesOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(boxesOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(sizeViolation({ x: 0, y: 0, width: 12, height: 5 }, { minWidth: 20 })).toBe("width 12 < minWidth 20");
    expect(sizeViolation({ x: 0, y: 0, width: 12, height: 5 }, { maxHeight: 10 })).toBeNull();
  });
});

describe("assertion schema (additive)", () => {
  it("accepts the visual kinds and rejects a non-allowlisted property or an unscoped flash", () => {
    expect(AssertionSchema.safeParse({ kind: "style", target: { css: "a" }, property: "color", op: "=", value: "red" }).success).toBe(true);
    expect(AssertionSchema.safeParse({ kind: "style", target: { css: "a" }, property: "content", op: "=", value: "x" }).success).toBe(false);
    expect(AssertionSchema.safeParse({ kind: "flashed", target: { css: "a" } }).success).toBe(false);
    expect(AssertionSchema.safeParse({ kind: "flashed", target: { css: "a" }, className: "flash", animation: true }).success).toBe(false);
    expect(AssertionSchema.safeParse({ kind: "attr", target: { css: "a" }, name: "data-x", value: "1", absent: true }).success).toBe(false);
  });
});

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; }
  #box { position: absolute; left: 10px; top: 10px; width: 100px; height: 50px; color: rgb(255, 0, 0); opacity: 0.5; }
  #over { position: absolute; left: 60px; top: 40px; width: 20px; height: 20px; }
  #apart { position: absolute; left: 300px; top: 10px; width: 20px; height: 20px; }
  #below { position: absolute; left: 0; top: 5000px; width: 20px; height: 20px; }
  #go { position: absolute; left: 10px; top: 200px; }
  .hl { background-color: rgba(255, 200, 0, 0.4); }
  .hl.off { background-color: rgba(255, 200, 0, 0); }
</style></head><body>
  <div id="box" data-state="open">Box</div><div id="over">o</div><div id="apart">a</div><div id="below">b</div>
  <span class="hl">one</span><span class="hl">two</span><span class="hl off" id="dead">three</span>
  <button id="go" onclick="document.getElementById('box').classList.add('flash'); setTimeout(() => document.getElementById('box').classList.remove('flash'), 300)">go</button>
</body></html>`;

let session: BrowserSession;
let actor: Actor;
let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
  session = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("visual").whoCan(new BrowseTheWeb(session, [site.url]));
}, 60_000);
afterAll(async () => {
  await session.close();
  await site.close();
});

const holds = (a: Assertion): Promise<boolean> => checkAssertion(actor, AssertionSchema.parse(a), { timeoutMs: 0 });

describe("visual-state assertions on a real page (#148)", () => {
  it(
    "style, inViewport, box, overlap and attr pass and fail correctly, with evidence",
    async () => {
      await session.page.setContent(PAGE);
      const box = { css: "#box" };
      expect(await holds({ kind: "style", target: box, property: "color", op: "=", value: "rgb(255, 0, 0)" })).toBe(true);
      expect(await holds({ kind: "style", target: box, property: "color", op: "=", value: "blue" })).toBe(false);
      expect(await holds({ kind: "style", target: box, property: "opacity", op: "<", value: "1" })).toBe(true);
      // Every match must satisfy: the one alpha-0 span fails the whole check.
      expect(await holds({ kind: "style", target: { css: ".hl:not(.off)" }, property: "background-color", channel: "alpha", op: ">", value: "0" })).toBe(true);
      const heat: Assertion = { kind: "style", target: { css: ".hl" }, property: "background-color", channel: "alpha", op: ">", value: "0" };
      expect(await holds(heat)).toBe(false);
      expect(await readAssertionEvidence(actor, heat)).toBe("alpha(background-color) > 0 failed on 1 of 3 element(s) (observed 0)");
      // A missing target never holds.
      expect(await holds({ kind: "style", target: { css: "#nope" }, property: "color", op: "=", value: "red" })).toBe(false);

      expect(await holds({ kind: "inViewport", target: box })).toBe(true);
      expect(await holds({ kind: "inViewport", target: { css: "#below" } })).toBe(false);
      expect(await readAssertionEvidence(actor, { kind: "inViewport", target: { css: "#below" }, min: 0.5 })).toMatch(/^not in viewport: ratio 0 < 0\.5/);

      expect(await holds({ kind: "box", target: box, minWidth: 90, maxWidth: 110, minHeight: 40, maxHeight: 60 })).toBe(true);
      expect(await holds({ kind: "box", target: box, maxHeight: 20 })).toBe(false);

      expect(await holds({ kind: "overlap", target: box, other: { css: "#over" }, overlapping: true })).toBe(true);
      expect(await holds({ kind: "overlap", target: box, other: { css: "#apart" }, overlapping: false })).toBe(true);
      expect(await holds({ kind: "overlap", target: box, other: { css: "#apart" }, overlapping: true })).toBe(false);

      expect(await holds({ kind: "attr", target: box, name: "data-state", value: "open" })).toBe(true);
      expect(await holds({ kind: "attr", target: box, name: "data-state", value: "closed" })).toBe(false);
      expect(await holds({ kind: "attr", target: box, name: "data-missing", absent: true })).toBe(true);
      expect(await holds({ kind: "attr", target: box, name: "data-missing" })).toBe(false);
    },
    60_000,
  );

  it(
    "flashed: catches a 300 ms class after the click; not installed → never holds",
    async () => {
      const flash: Assertion = { kind: "flashed", target: { css: "#box" }, className: "flash", withinMs: 1_000 };
      await session.page.goto(`${site.url}/login`);
      await session.page.setContent(PAGE);
      expect(await holds(flash)).toBe(false);
      expect(await readAssertionEvidence(actor, flash)).toBe("unreadable: the flash recorder was not installed before the action");

      await installFlashRecorder(session.page);
      expect(await holds(flash)).toBe(false);
      await session.page.click("#go");
      await session.page.waitForTimeout(500); // the class is gone again by now
      expect(await session.page.locator("#box.flash").count()).toBe(0);
      expect(await holds(flash)).toBe(true);
      expect(await readAssertionEvidence(actor, flash)).toMatch(/^gained class \.flash \d+ms after the last input$/);
      expect(await holds({ ...flash, className: "other" } as Assertion)).toBe(false);
    },
    60_000,
  );
});

describe("editText replay (#148)", () => {
  const recording = (steps: unknown[]): Recording =>
    RecordingSchema.parse({ version: "1", site: "t", pages: [{ url: "/editor-fixture", steps: steps.map((step) => ({ step })) }] });
  const nav = { kind: "navigate", url: "/editor-fixture", expect: { kind: "urlIncludes", text: "/editor-fixture" } };
  const b2 = { anchor: { id: "b2" }, css: "#b2" };
  const anyB2 = { kind: "count", target: b2, min: 0 };

  it(
    "insert, offsets and format place the same anchor every time; a missing quote fails closed",
    async () => {
      const run = async (steps: unknown[]) => {
        const server = await startServer();
        const s = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [server.url], baseUrl: server.url });
        try {
          const a = CastActor.named("replay").whoCan(new BrowseTheWeb(s, [server.url]));
          const r = await new RecordingInterpreter().run(a, recording([nav, ...steps]));
          return { r, html: await s.page.locator("#b2").evaluate((el) => el.innerHTML) };
        } finally {
          await s.close();
          await server.close();
        }
      };
      const edits = [
        { kind: "editText", target: b2, anchor: { quote: "lazy dog" }, action: "insertBefore", value: { redacted: false, value: "very " }, expect: anyB2 },
        { kind: "editText", target: b2, anchor: { start: 0, end: 13 }, action: "replace", value: { redacted: false, value: "Part two" }, expect: anyB2 },
        { kind: "editText", target: b2, anchor: { quote: "brown fox" }, action: "format", format: "bold", expect: anyB2 },
        { kind: "editText", target: b2, anchor: { at: "end" }, action: "insertAfter", value: { redacted: false, value: " The end." }, expect: anyB2 },
      ];
      const first = await run(edits);
      expect(first.r.outcome).toBe("completed");
      expect(first.html).toBe("Part two says the quick <b>brown fox</b> jumps over the very lazy dog. The end.");
      const second = await run(edits);
      expect(second.html).toBe(first.html);

      const missing = await run([{ ...edits[0], anchor: { quote: "purple cow" } }]);
      expect(missing.r).toMatchObject({ outcome: "failed", at: 1 });
      expect(missing.r.outcome === "failed" ? missing.r.error : "").toContain('quote "purple cow" is not in the target\'s text');
      expect(missing.html).toBe("Paragraph two says the quick brown fox jumps over the lazy dog.");
    },
    120_000,
  );

  it("the schema rejects an edit whose parts do not fit", () => {
    const bad = (step: Record<string, unknown>) =>
      RecordingSchema.safeParse({ version: "1", site: "t", pages: [{ url: "/", steps: [{ step: { kind: "editText", target: b2, expect: anyB2, ...step } }] }] })
        .success;
    expect(bad({ anchor: { quote: "x" }, action: "replace" })).toBe(false); // no value
    expect(bad({ anchor: { at: "end" }, action: "replace", value: { redacted: false, value: "x" } })).toBe(false);
    expect(bad({ anchor: { quote: "x" }, action: "format", format: "bold", value: { redacted: false, value: "x" } })).toBe(false);
    expect(bad({ anchor: { start: 5, end: 2 }, action: "replace", value: { redacted: false, value: "x" } })).toBe(false);
    expect(bad({ anchor: { quote: "x" }, action: "replace", value: { redacted: false, value: "y" } })).toBe(true);
  });
});
