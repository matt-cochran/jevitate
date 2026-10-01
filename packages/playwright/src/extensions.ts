import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * #256 — unpacked browser extensions (`--extension <dir>`). An extension is identified BEFORE any
 * browser launches, by code, from its directory alone: the manifest is read and checked, and the
 * extension id is computed exactly as Chromium computes it for an unpacked load — from the
 * manifest's `key` (base64 SubjectPublicKeyInfo) when it has one, else from the directory's
 * absolute, symlink-resolved path. So the `chrome-extension://<id>` origin a run may act on is
 * known (and allowlisted) before the run starts, and recorded so a replay can refuse a different
 * build.
 */

/** One unpacked extension, as loaded: where it lives and what its manifest says. */
export interface UnpackedExtension {
  /** Absolute, symlink-resolved directory (what Chromium is given, so the id is stable). */
  readonly dir: string;
  /** The Chromium extension id (32 letters a–p). */
  readonly id: string;
  /** `manifest.json` `name` (as written: a `__MSG_…__` name is not localized). */
  readonly name: string;
  /** `manifest.json` `version`. */
  readonly version: string;
  /** `manifest.json` `manifest_version` (2 or 3). */
  readonly manifestVersion: number;
}

/** An `--extension` directory that cannot be loaded: refused before any browser opens (a usage error). */
export class ExtensionDirError extends Error {
  readonly code = "E_EXTENSION_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExtensionDirError";
  }
}

/** Chromium loaded the browser but not the extension (e.g. a branded Chrome that ignores --load-extension). */
export class ExtensionLoadError extends Error {
  readonly code = "E_EXTENSION_LOAD" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtensionLoadError";
  }
}

/** Chromium's id alphabet: each hex digit of the first 16 SHA-256 bytes mapped 0–f → a–p. */
function idFromDigest(bytes: Uint8Array): string {
  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** The id Chromium gives an unpacked extension loaded from `absDir` (no manifest `key`). POSIX paths. */
export function extensionIdForPath(absDir: string): string {
  return idFromDigest(Buffer.from(absDir, "utf8"));
}

/** The id Chromium gives an extension whose manifest pins `key` (base64 DER public key). */
export function extensionIdForKey(base64Key: string): string {
  return idFromDigest(Buffer.from(base64Key.replace(/\s+/g, ""), "base64"));
}

/** A Chromium extension id: exactly 32 letters a–p. */
export const EXTENSION_ID = /^[a-p]{32}$/;

/** `chrome-extension://<id>` — the origin a loaded extension's pages are served from. */
export function extensionOrigin(id: string): string {
  return `chrome-extension://${id}`;
}

/**
 * Reads and checks an unpacked extension directory: it must exist, be a directory and hold a
 * `manifest.json` that parses to an object with a numeric `manifest_version` (2 or 3) and string
 * `name`/`version`. Throws `ExtensionDirError` with the reason otherwise. `cwd` resolves a relative
 * `dir`.
 */
export function readUnpackedExtension(dir: string, cwd: string = process.cwd()): UnpackedExtension {
  if (dir.trim() === "") throw new ExtensionDirError("--extension needs a directory");
  const given = isAbsolute(dir) ? dir : resolve(cwd, dir);
  let real: string;
  try {
    real = realpathSync(given);
  } catch {
    throw new ExtensionDirError(`extension directory not found: ${given}`);
  }
  if (!statSync(real).isDirectory()) throw new ExtensionDirError(`--extension must be an unpacked extension directory (got a file: ${given})`);
  const manifestPath = resolve(real, "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new ExtensionDirError(`not an unpacked extension (no manifest.json): ${given}`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new ExtensionDirError(`${manifestPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ExtensionDirError(`${manifestPath} is not a JSON object`);
  }
  const m = manifest as Record<string, unknown>;
  const mv = m.manifest_version;
  if (mv !== 2 && mv !== 3) throw new ExtensionDirError(`${manifestPath}: manifest_version must be 2 or 3`);
  if (typeof m.name !== "string" || m.name.trim() === "") throw new ExtensionDirError(`${manifestPath}: "name" must be a non-empty string`);
  if (typeof m.version !== "string" || m.version.trim() === "") throw new ExtensionDirError(`${manifestPath}: "version" must be a non-empty string`);
  if (m.key !== undefined && typeof m.key !== "string") throw new ExtensionDirError(`${manifestPath}: "key" must be a base64 string`);
  const id = typeof m.key === "string" ? extensionIdForKey(m.key) : extensionIdForPath(real);
  return { dir: real, id, name: m.name, version: m.version, manifestVersion: mv };
}

/** Reads every directory; two that resolve to the same extension id are refused (Chromium would load one). */
export function readUnpackedExtensions(dirs: readonly string[], cwd: string = process.cwd()): UnpackedExtension[] {
  const out: UnpackedExtension[] = [];
  for (const d of dirs) {
    const ext = readUnpackedExtension(d, cwd);
    const dup = out.find((e) => e.id === ext.id);
    if (dup !== undefined) {
      if (dup.dir === ext.dir) continue;
      throw new ExtensionDirError(`two --extension directories have the same extension id ${ext.id}: ${dup.dir} and ${ext.dir}`);
    }
    out.push(ext);
  }
  return out;
}

/** The Chromium switches that load exactly these extensions (and no others). */
export function extensionLaunchArgs(extensions: readonly UnpackedExtension[]): string[] {
  if (extensions.length === 0) return [];
  const dirs = extensions.map((e) => e.dir).join(",");
  return [`--disable-extensions-except=${dirs}`, `--load-extension=${dirs}`];
}

/** What a run records about a loaded extension (the Recording's `extensions`): no local path. */
export interface ExtensionIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export function extensionIdentity(e: UnpackedExtension): ExtensionIdentity {
  return { id: e.id, name: e.name, version: e.version };
}

/**
 * Whether two extension sets are the same build: the same ids, each with the same name and version
 * (order-insensitive). An absent set equals an empty one.
 */
export function sameExtensionBuild(a: readonly ExtensionIdentity[] | undefined, b: readonly ExtensionIdentity[] | undefined): boolean {
  const key = (xs: readonly ExtensionIdentity[] | undefined): string =>
    (xs ?? [])
      .map((x) => `${x.id}\u0000${x.name}\u0000${x.version}`)
      .sort()
      .join("\n");
  return key(a) === key(b);
}

/** `name@version (id)` per extension, for messages. */
export function describeExtensions(xs: readonly ExtensionIdentity[] | undefined): string {
  if (xs === undefined || xs.length === 0) return "none";
  return xs.map((x) => `${x.name}@${x.version} (${x.id})`).join(", ");
}
