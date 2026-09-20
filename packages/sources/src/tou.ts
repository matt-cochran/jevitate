import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JevitateManifest, SiteDeclaration } from "./manifest.js";
import { UndeclaredTouError } from "./errors.js";
import { resolveDataDir } from "./data-dir.js";

export interface TouAck {
  sourceName: string;
  gitUrl: string;
  origins: string[];
  ackedBy: string;
  ackedAtIso: string;
}

export interface AckStore {
  get(sourceName: string): Promise<TouAck | null>;
  put(ack: TouAck): Promise<void>;
}

/** §14.1 — acks are LOCAL/per-user, like `TrustStore`: acknowledging a
 * source's Terms of Use is a human act on this machine, never granted by a
 * teammate's shared lockfile. */
export const DEFAULT_ACK_DIR = resolveDataDir(["trust", "acks"]);

function assertSafeName(name: string): void {
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.length === 0) {
    throw new Error(`Invalid source name (path traversal risk): ${name}`);
  }
}

function isNodeError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

export class FsAckStore implements AckStore {
  constructor(private readonly dir: string) {}

  private pathFor(sourceName: string): string {
    assertSafeName(sourceName);
    return join(this.dir, `${sourceName}.json`);
  }

  async get(sourceName: string): Promise<TouAck | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(sourceName), "utf8");
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return null;
      throw err;
    }
    return JSON.parse(raw) as TouAck;
  }

  async put(ack: TouAck): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.pathFor(ack.sourceName), JSON.stringify(ack), { mode: 0o600 });
  }
}

/**
 * Returns the `SiteDeclaration` covering `origin`, or throws
 * `UndeclaredTouError` (fail-closed, FMECA #4) if the manifest declares no
 * Terms-of-Use basis for that origin. Never falls back to "assume allowed".
 */
export function requireDeclaredTou(manifest: JevitateManifest, origin: string): SiteDeclaration {
  const target = new URL(origin).origin;
  const decl = manifest.sites.find((s) => new URL(s.origin).origin === target);
  if (!decl) {
    throw new UndeclaredTouError(
      `source '${manifest.source}' declares no Terms-of-Use basis for origin '${target}'`,
    );
  }
  return decl;
}

/**
 * The data a `source add` flow shows a human BEFORE recording their ack
 * (spec §8, FMECA #5) — the full `gitUrl` (never truncated/aliased) plus
 * every declared site's `touBasis`, so the human sees exactly what they are
 * acknowledging.
 */
export function surfaceForAck(
  manifest: JevitateManifest,
  gitUrl: string,
): { gitUrl: string; sites: SiteDeclaration[] } {
  return { gitUrl, sites: manifest.sites };
}
