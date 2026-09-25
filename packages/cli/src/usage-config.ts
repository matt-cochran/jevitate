import { readFileSync } from "node:fs";
import type { ConfiguredModelPrices, JevPricing, ModelPrice, UsagePricing } from "@jevitate/ai-core";
import { resolveDataDir } from "./data-dir.js";

/**
 * The usage-pricing slice of `~/.jevitate/config.json` (#136):
 *
 * ```json
 * { "usage": {
 *     "jevUnitPriceUsd": 0.006,
 *     "modelPrices": { "openai/gpt-4o": { "inputUsdPerMtok": 2.5, "outputUsdPerMtok": 10 } } } }
 * ```
 *
 * `jevUnitPriceUsd` prices each Jev judgment call when the provider itself reports no cost (it
 * overrides the built-in Jev price table). `modelPrices` (#163) prices any model per million tokens
 * — Jev or generation — overriding the built-in tables (and pricing a model they don't list). A
 * missing file (or key) is "not configured"; a malformed file or a non-numeric/negative value fails
 * closed rather than being silently ignored.
 */
export class UsageConfigError extends Error {
  readonly code = "E_USAGE_CONFIG" as const;
}

const ENV_VAR = "JEVITATE_JEV_UNIT_PRICE_USD";

function loadUsageSection(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return undefined;
    throw new UsageConfigError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageConfigError(`${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageConfigError(`${path} must be a JSON object`);
  }
  const usage = (parsed as Record<string, unknown>).usage;
  if (usage === undefined) return undefined;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    throw new UsageConfigError(`${path}: "usage" must be an object`);
  }
  return usage as Record<string, unknown>;
}

function positiveNumber(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new UsageConfigError(`${at} must be a non-negative number, got ${JSON.stringify(v)}`);
  }
  return v;
}

/** `usage.jevUnitPriceUsd` from the config file. Undefined when the file or key is absent. */
export function loadJevUnitPriceUsd(path = resolveDataDir(["config.json"])): number | undefined {
  const v = loadUsageSection(path)?.jevUnitPriceUsd;
  if (v === undefined) return undefined;
  return positiveNumber(v, `${path}: usage.jevUnitPriceUsd`);
}

/**
 * Resolves the Jev per-judgment unit price (#136): `JEVITATE_JEV_UNIT_PRICE_USD` (env) beats
 * `usage.jevUnitPriceUsd` (config); undefined when neither is set — `jevUsd` then stays unpriced,
 * exactly as it did before #136. The result's `source` is what `UsageCounts.jevPriceSource` echoes,
 * so a priced run's number is never unexplained. A malformed value fails closed (never silently
 * ignored, never silently mispriced): the CLI surfaces it as a setup error before any run starts.
 */
export function resolveJevUnitPrice(
  env: Readonly<Record<string, string | undefined>> = process.env,
  configPath = resolveDataDir(["config.json"]),
): JevPricing | undefined {
  const raw = env[ENV_VAR];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new UsageConfigError(`${ENV_VAR} must be a non-negative number, got ${JSON.stringify(raw)}`);
    }
    return { unitPriceUsd: n, source: `env:${ENV_VAR}` };
  }
  const fromConfig = loadJevUnitPriceUsd(configPath);
  if (fromConfig === undefined) return undefined;
  return { unitPriceUsd: fromConfig, source: `config:${configPath} usage.jevUnitPriceUsd` };
}

/** `usage.modelPrices` from the config file (#163). Undefined when the file or key is absent. */
export function loadModelPrices(path = resolveDataDir(["config.json"])): ConfiguredModelPrices | undefined {
  const v = loadUsageSection(path)?.modelPrices;
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new UsageConfigError(`${path}: usage.modelPrices must be an object of { "<model>": { inputUsdPerMtok, outputUsdPerMtok } }`);
  }
  const prices: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries(v as Record<string, unknown>)) {
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      throw new UsageConfigError(`${path}: usage.modelPrices.${model} must be { inputUsdPerMtok, outputUsdPerMtok }`);
    }
    const o = p as Record<string, unknown>;
    prices[model] = {
      inputUsdPerMtok: positiveNumber(o.inputUsdPerMtok, `${path}: usage.modelPrices.${model}.inputUsdPerMtok`),
      outputUsdPerMtok: positiveNumber(o.outputUsdPerMtok, `${path}: usage.modelPrices.${model}.outputUsdPerMtok`),
    };
  }
  return { prices, source: `config:${path} usage.modelPrices` };
}

/**
 * Every configured price (#163): the Jev unit price (`resolveJevUnitPrice`) and `usage.modelPrices`.
 * Whatever is not configured is priced from the built-in tables in `@jevitate/ai-core`'s usage.ts.
 */
export function resolveUsagePricing(
  env: Readonly<Record<string, string | undefined>> = process.env,
  configPath = resolveDataDir(["config.json"]),
): UsagePricing {
  const jevUnitPrice = resolveJevUnitPrice(env, configPath);
  const modelPrices = loadModelPrices(configPath);
  return { ...(jevUnitPrice === undefined ? {} : { jevUnitPrice }), ...(modelPrices === undefined ? {} : { modelPrices }) };
}
