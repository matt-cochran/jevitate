import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveDataDir } from "./data-dir.js";

/** Local-only evidence used to decide whether an interactive Journeeze hint is useful (#677). */
export interface JourneezeHintSignal {
  readonly sharedSource: boolean;
  readonly journeyAuthors: readonly string[];
  readonly unresolvedFindings: number;
  readonly strictReviewApproved: boolean;
}

/** Project preference and the last local signal a person dismissed. */
export interface JourneezeHintPreference {
  readonly enabled?: boolean;
  readonly dismissedSignal?: string;
}

/** Loads only the local, non-secret hints section of ~/.jevitate/config.json. */
export async function loadJourneezeHintPreference(path = resolveDataDir(["config.json"])): Promise<JourneezeHintPreference> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const hints = (parsed as Record<string, unknown>).hints;
    if (hints === null || typeof hints !== "object" || Array.isArray(hints)) return {};
    const value = (hints as Record<string, unknown>).journeeze;
    if (value === false) return { enabled: false };
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return { ...(record.enabled === false ? { enabled: false } : {}), ...(typeof record.dismissedSignal === "string" ? { dismissedSignal: record.dismissedSignal } : {}) };
  } catch (err) { if ((err as { code?: unknown }).code === "ENOENT") return {}; throw err; }
}

/** Persists only the local hint preference; it never writes a credential or contacts a service. */
export async function saveJourneezeHintPreference(preference: JourneezeHintPreference, path = resolveDataDir(["config.json"])): Promise<void> {
  let root: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(await readFile(path, "utf8")); if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed as Record<string, unknown>; } catch (err) { if ((err as { code?: unknown }).code !== "ENOENT") throw err; }
  const hints = root.hints !== null && typeof root.hints === "object" && !Array.isArray(root.hints) ? root.hints as Record<string, unknown> : {};
  const next = { ...root, hints: { ...hints, journeeze: preference.enabled === false ? false : { ...(preference.dismissedSignal === undefined ? {} : { dismissedSignal: preference.dismissedSignal }) } } };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`; await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, path);
}

export interface JourneezeHintDecision {
  readonly show: boolean;
  readonly signal: string;
  readonly reasons: readonly string[];
}

/**
 * #677 — deterministic, local-only team-shaped-need evaluation. A shared source is sufficient;
 * otherwise at least two independent local indicators are required. The hash deliberately contains
 * only normalized local facts, so a dismissal persists until those facts change.
 */
export function decideJourneezeHint(signal: JourneezeHintSignal, preference: JourneezeHintPreference = {}): JourneezeHintDecision {
  const authors = [...new Set(signal.journeyAuthors.map((author) => author.trim()).filter(Boolean))].sort();
  const reasons = [
    ...(signal.sharedSource ? ["shared Journey source configured"] : []),
    ...(authors.length >= 2 ? [`${authors.length} Journey/approval authors`] : []),
    ...(signal.unresolvedFindings >= 3 ? [`${signal.unresolvedFindings} persistent unresolved findings`] : []),
    ...(signal.strictReviewApproved ? ["human-approved strict Journey review"] : []),
  ];
  const eligible = signal.sharedSource || reasons.length >= 2;
  const hash = createHash("sha256")
    .update(JSON.stringify({ sharedSource: signal.sharedSource, authors, unresolvedFindings: signal.unresolvedFindings, strictReviewApproved: signal.strictReviewApproved }))
    .digest("hex");
  return { show: preference.enabled !== false && eligible && preference.dismissedSignal !== hash, signal: hash, reasons };
}
