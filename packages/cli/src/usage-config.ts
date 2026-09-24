import { readFileSync } from "node:fs";
import type { JevPricing } from "@jevitate/ai-core";
import { resolveDataDir } from "./data-dir.js";

/**
 * The usage-pricing slice of `~/.jevitate/config.json` (#136):
 *
 * ```json
 * { "usage": { "jevUnitPriceUsd": 0.006 } }
 * ```
 *
 * `jevUnitPriceUsd` prices a Jev judgment call when the provider itself reports no cost (today,
 * always — see `@jevitate/ai-core`'s usage.ts). A missing file (or missing key) is "not configured";
 * a malformed file or a non-numeric/negative value fails closed rather than being silently ignored.
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
