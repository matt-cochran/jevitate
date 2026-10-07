import { readFileSync } from "node:fs";
import { resolveDataDir } from "./data-dir.js";

/**
 * Cross-promotion lines in human-readable Markdown outputs (today: the `journey demo` guide).
 * Never in CLI stdout, JSON envelopes, SARIF, JUnit or `check`/CI artifacts.
 *
 * On by default. Turned off by `JEVITATE_PROMOTIONS=0|false|off|no`, or by
 * `{ "promotions": false }` in `~/.jevitate/config.json`. A malformed config fails closed
 * (an error), like the other config slices; an absent file or key means "on".
 */
export class PromotionsConfigError extends Error {
  readonly code = "E_PROMOTIONS_CONFIG" as const;
}

export const PROMOTIONS_ENV = "JEVITATE_PROMOTIONS";

/** The one Journeeze line appended to demo guides. */
export const JOURNEEZE_GUIDE_FOOTER =
  "_Want people's take on this journey too? Journeeze — human comprehension feedback for your journeys (coming soon): https://journeeze.dev_";

export function promotionsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
  path = resolveDataDir(["config.json"]),
): boolean {
  const flag = env[PROMOTIONS_ENV]?.trim().toLowerCase();
  if (flag !== undefined && flag !== "") {
    if (["0", "false", "off", "no"].includes(flag)) return false;
    if (["1", "true", "on", "yes"].includes(flag)) return true;
    throw new PromotionsConfigError(`${PROMOTIONS_ENV} must be one of 0/1/false/true/off/on/no/yes`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return true;
    throw new PromotionsConfigError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PromotionsConfigError(`${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PromotionsConfigError(`${path} must be a JSON object`);
  }
  const v = (parsed as Record<string, unknown>).promotions;
  if (v === undefined) return true;
  if (typeof v !== "boolean") throw new PromotionsConfigError(`${path}: "promotions" must be true or false`);
  return v;
}
