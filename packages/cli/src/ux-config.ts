import { readFileSync } from "node:fs";
import { resolveDataDir } from "./data-dir.js";

/**
 * The UX-review slice of `~/.jevitate/config.json`:
 *
 * ```json
 * { "ux": { "minConfidence": 0.75 } }
 * ```
 *
 * A missing file (or missing key) is "not configured"; a malformed file or a non-numeric value
 * fails closed — it is never silently replaced by the default.
 */
export class UxConfigError extends Error {
  readonly code = "E_UX_CONFIG" as const;
}

export function loadUxMinConfidence(path = resolveDataDir(["config.json"])): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return undefined;
    throw new UxConfigError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UxConfigError(`${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UxConfigError(`${path} must be a JSON object`);
  }
  const ux = (parsed as Record<string, unknown>).ux;
  if (ux === undefined) return undefined;
  if (ux === null || typeof ux !== "object" || Array.isArray(ux)) throw new UxConfigError(`${path}: "ux" must be an object`);
  const v = (ux as Record<string, unknown>).minConfidence;
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new UxConfigError(`${path}: ux.minConfidence must be a number in [0,1]`);
  }
  return v;
}
