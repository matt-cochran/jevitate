import { readFileSync } from "node:fs";
import type { CredentialKey } from "@jevitate/ai-core";
import { resolveDataDir } from "./data-dir.js";

/**
 * The machine-local credential file written by `jevitate init` / `jevitate ai setup`
 * (`~/.jevitate/credentials.json`, mode 0600). Every credential READ site loads it
 * through this module so what setup persists is what status/explore/generate see
 * (env vars still win — see `envCredentialStore`).
 */

const KNOWN_KEYS: readonly CredentialKey[] = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"];

export class CredentialsFileError extends Error {}

export interface CredentialsFileDeps {
  readonly homedir?: () => string;
  readonly readFile?: (path: string) => string;
}

export function credentialsFilePath(deps: CredentialsFileDeps = {}): string {
  return resolveDataDir(["credentials.json"], deps.homedir ? { homedir: deps.homedir } : {});
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/**
 * Reads the credential file. A MISSING file means "no local keys" ({}); anything
 * else wrong with it (unreadable, not JSON, not an object) fails closed with an
 * actionable error — never a silent empty store that looks like "keys missing".
 * Only the known key names with string values are returned.
 */
export function loadLocalCredentials(
  deps: CredentialsFileDeps = {},
): Partial<Record<CredentialKey, string>> {
  const path = credentialsFilePath(deps);
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = read(path);
  } catch (err) {
    if (isMissingFile(err)) return {};
    throw new CredentialsFileError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialsFileError(
      `${path} is not valid JSON — fix or delete it, then run \`jevitate init\``,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialsFileError(
      `${path} must be a JSON object of credential keys — fix or delete it, then run \`jevitate init\``,
    );
  }
  const values = new Map<string, unknown>(Object.entries(parsed));
  const out: Partial<Record<CredentialKey, string>> = {};
  for (const key of KNOWN_KEYS) {
    const value = values.get(key);
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
