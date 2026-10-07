import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Journey } from "@jevitate/journey";
import { demoGuide, demoSubtitles } from "./journey-demo-api.js";
import { JOURNEEZE_GUIDE_FOOTER, PromotionsConfigError, promotionsEnabled } from "./promotions.js";

function withConfig(contents: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jev-promotions-"));
  const path = join(dir, "config.json");
  if (contents !== undefined) writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("promotionsEnabled", () => {
  it("is on by default (no file, no key, no env)", () => {
    withConfig(undefined, (path) => expect(promotionsEnabled({}, path)).toBe(true));
    withConfig({ ux: {} }, (path) => expect(promotionsEnabled({}, path)).toBe(true));
  });

  it("is off with \"promotions\": false in the config", () => {
    withConfig({ promotions: false }, (path) => expect(promotionsEnabled({}, path)).toBe(false));
  });

  it("the env var wins over the config, both ways", () => {
    for (const off of ["0", "false", "OFF", "no"]) {
      withConfig({ promotions: true }, (path) => expect(promotionsEnabled({ JEVITATE_PROMOTIONS: off }, path)).toBe(false));
    }
    withConfig({ promotions: false }, (path) => expect(promotionsEnabled({ JEVITATE_PROMOTIONS: "1" }, path)).toBe(true));
  });

  it("fails closed on malformed settings", () => {
    withConfig("{not json", (path) => expect(() => promotionsEnabled({}, path)).toThrow(PromotionsConfigError));
    withConfig({ promotions: "nope" }, (path) => expect(() => promotionsEnabled({}, path)).toThrow(PromotionsConfigError));
    withConfig(undefined, (path) => expect(() => promotionsEnabled({ JEVITATE_PROMOTIONS: "maybe" }, path)).toThrow(PromotionsConfigError));
  });
});

describe("the Journeeze line stays out of machine-readable outputs", () => {
  it("links journeeze.dev and is one Markdown line", () => {
    expect(JOURNEEZE_GUIDE_FOOTER).toContain("https://journeeze.dev");
    expect(JOURNEEZE_GUIDE_FOOTER).not.toContain("\n");
  });

  it("SARIF, JUnit, check and the JSON envelope never reference it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = [
      join(here, "../../findings/src/sarif.ts"),
      join(here, "../../findings/src/junit.ts"),
      join(here, "check-cli.ts"),
      join(here, "envelope.ts"),
    ];
    for (const file of sources) expect(readFileSync(file, "utf8"), file).not.toMatch(/promotions|journeeze/i);
  });
});

describe("demo guide footer", () => {
  const journey = { metadata: { id: "checkout", name: "Check out" } } as unknown as Journey;
  const steps = [{ number: 1, caption: "Open the cart", cue: { startMs: 0, endMs: 1000 } }] as unknown as Parameters<typeof demoGuide>[2];

  it("ends the guide with the Journeeze line when given", () => {
    const md = demoGuide(journey, "Buy one item", steps, "guide.assets", (s) => s, false, JOURNEEZE_GUIDE_FOOTER);
    expect(md.trimEnd().endsWith(JOURNEEZE_GUIDE_FOOTER)).toBe(true);
  });

  it("is absent when promotions are off, and never in the subtitles", () => {
    const md = demoGuide(journey, "Buy one item", steps, "guide.assets", (s) => s, false, undefined);
    expect(md).not.toMatch(/journeeze/i);
    expect(demoSubtitles("Buy one item", steps)).not.toMatch(/journeeze/i);
  });
});
