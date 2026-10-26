import { access, readFile } from "node:fs/promises";
import type { AcceptanceAuditAsset, AcceptanceAuditFinding } from "./acceptance-audit-schema.js";

/** Explicit local paths for core acceptance evidence; absent paths are never guessed or inferred. */
export interface CoreAcceptanceAssets {
  readonly requirements?: string;
  readonly persona?: string;
  readonly sourceJourney?: string;
  readonly approvedHash?: string;
  readonly verifyFix?: string;
  readonly strictReview?: string;
}

const CORE: readonly [AcceptanceAuditAsset, keyof CoreAcceptanceAssets][] = [
  ["requirements", "requirements"],
  ["persona", "persona"],
  ["source-journey", "sourceJourney"],
  ["approved-hash", "approvedHash"],
  ["verify-fix", "verifyFix"],
  ["strict-review", "strictReview"],
];

async function finding(asset: AcceptanceAuditAsset, path: string | undefined): Promise<AcceptanceAuditFinding> {
  if (path === undefined || path === "") return { asset, state: "missing", reason: "no explicit local path supplied" };
  try {
    await access(path);
  } catch {
    return { asset, state: "missing", path, reason: "local file does not exist" };
  }
  try {
    if ((await readFile(path, "utf8")).trim() === "") return { asset, state: "inconclusive", path, reason: "local file is empty" };
  } catch {
    return { asset, state: "inconclusive", path, reason: "local file cannot be read as text" };
  }
  return { asset, state: "complete", path };
}

/**
 * Read-only presence/content audit for core evidence. This intentionally validates no relationship
 * between files: mapping a persona, approval, or verification to a Journey belongs to a later,
 * explicit check and is never inferred from filenames or content (#686).
 */
export async function auditCoreAcceptanceAssets(assets: CoreAcceptanceAssets): Promise<AcceptanceAuditFinding[]> {
  return Promise.all(CORE.map(([asset, key]) => finding(asset, assets[key])));
}
