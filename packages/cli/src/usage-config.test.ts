import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJevUnitPriceUsd, loadModelPrices, resolveJevUnitPrice, resolveUsagePricing, UsageConfigError } from "./usage-config.js";

function withConfig(contents: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jev-usage-config-"));
  const path = join(dir, "config.json");
  if (contents !== undefined) writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadJevUnitPriceUsd (#136)", () => {
  it("a missing file, or a file with no usage.jevUnitPriceUsd, is 'not configured'", () => {
    withConfig(undefined, (path) => expect(loadJevUnitPriceUsd(path)).toBeUndefined());
    withConfig({}, (path) => expect(loadJevUnitPriceUsd(path)).toBeUndefined());
    withConfig({ usage: {} }, (path) => expect(loadJevUnitPriceUsd(path)).toBeUndefined());
  });

  it("reads usage.jevUnitPriceUsd", () => {
    withConfig({ usage: { jevUnitPriceUsd: 0.006 } }, (path) => expect(loadJevUnitPriceUsd(path)).toBe(0.006));
  });

  it("fails closed on malformed JSON, a non-object usage, or a negative/non-numeric price — never silently ignored", () => {
    withConfig("{not json", (path) => expect(() => loadJevUnitPriceUsd(path)).toThrow(UsageConfigError));
    withConfig({ usage: "nope" }, (path) => expect(() => loadJevUnitPriceUsd(path)).toThrow(/"usage" must be an object/));
    withConfig({ usage: { jevUnitPriceUsd: -1 } }, (path) => expect(() => loadJevUnitPriceUsd(path)).toThrow(/non-negative number/));
    withConfig({ usage: { jevUnitPriceUsd: "0.01" } }, (path) => expect(() => loadJevUnitPriceUsd(path)).toThrow(/non-negative number/));
  });
});

describe("resolveJevUnitPrice (#136) — env beats config; neither = unpriced", () => {
  it("undefined when neither is set (jevUsd then stays unpriced, exactly as before #136)", () => {
    withConfig(undefined, (path) => expect(resolveJevUnitPrice({}, path)).toBeUndefined());
  });

  it("config alone: sourced and labelled with the config path", () => {
    withConfig({ usage: { jevUnitPriceUsd: 0.006 } }, (path) => {
      expect(resolveJevUnitPrice({}, path)).toEqual({ unitPriceUsd: 0.006, source: `config:${path} usage.jevUnitPriceUsd` });
    });
  });

  it("the env var wins over config, and is labelled by its own name — never the value", () => {
    withConfig({ usage: { jevUnitPriceUsd: 0.006 } }, (path) => {
      const r = resolveJevUnitPrice({ JEVITATE_JEV_UNIT_PRICE_USD: "0.01" }, path);
      expect(r).toEqual({ unitPriceUsd: 0.01, source: "env:JEVITATE_JEV_UNIT_PRICE_USD" });
    });
  });

  it("a malformed env value fails closed, naming the variable, never echoing a config value", () => {
    withConfig(undefined, (path) => {
      expect(() => resolveJevUnitPrice({ JEVITATE_JEV_UNIT_PRICE_USD: "nope" }, path)).toThrow(/JEVITATE_JEV_UNIT_PRICE_USD/);
      expect(() => resolveJevUnitPrice({ JEVITATE_JEV_UNIT_PRICE_USD: "-1" }, path)).toThrow(/non-negative/);
    });
  });

  it("an empty env value falls through to config, not an error", () => {
    withConfig({ usage: { jevUnitPriceUsd: 0.006 } }, (path) => {
      expect(resolveJevUnitPrice({ JEVITATE_JEV_UNIT_PRICE_USD: "" }, path)?.unitPriceUsd).toBe(0.006);
    });
  });
});

describe("usage.modelPrices / resolveUsagePricing (#163)", () => {
  it("reads per-model token prices with a labelled source; absent is 'not configured'", () => {
    withConfig({ usage: { modelPrices: { "acme/x": { inputUsdPerMtok: 1, outputUsdPerMtok: 2 } } } }, (path) => {
      expect(loadModelPrices(path)).toEqual({ prices: { "acme/x": { inputUsdPerMtok: 1, outputUsdPerMtok: 2 } }, source: `config:${path} usage.modelPrices` });
      expect(resolveUsagePricing({}, path)).toEqual({ modelPrices: loadModelPrices(path) });
    });
    withConfig({ usage: {} }, (path) => expect(resolveUsagePricing({}, path)).toEqual({}));
  });

  it("fails closed on a malformed model price", () => {
    withConfig({ usage: { modelPrices: [] } }, (path) => expect(() => loadModelPrices(path)).toThrow(UsageConfigError));
    withConfig({ usage: { modelPrices: { m: { inputUsdPerMtok: 1 } } } }, (path) => expect(() => loadModelPrices(path)).toThrow(/outputUsdPerMtok must be a non-negative number/));
  });

  it("the env unit price still wins for Jev", () => {
    withConfig({ usage: { jevUnitPriceUsd: 0.5 } }, (path) => {
      expect(resolveUsagePricing({ JEVITATE_JEV_UNIT_PRICE_USD: "0.01" }, path).jevUnitPrice).toEqual({ unitPriceUsd: 0.01, source: "env:JEVITATE_JEV_UNIT_PRICE_USD" });
    });
  });
});
