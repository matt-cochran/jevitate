import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Rejects a `name` containing a path separator or `..` segment — mirrors
 * `@jevitate/journey`'s `assertSafeId` — since a source `name` is used to build
 * filesystem paths under the managed sources dir (`~/.jevitate/sources/<name>/`)
 * and trust-store keys.
 */
const SAFE_NAME_RE = /^[^/\\]+$/;

export interface SourceEntry {
  name: string;
  gitUrl: string;
  pinnedCommit: string;
}

export interface JevitateLock {
  version: 1;
  sources: SourceEntry[];
}

const SourceEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((n) => SAFE_NAME_RE.test(n) && !n.includes(".."), {
        message: "source name must not contain '/', '\\', or '..'",
      }),
    gitUrl: z.string().min(1),
    pinnedCommit: z.string().regex(/^[0-9a-f]{7,40}$/, "pinnedCommit must be a hex git commit sha"),
  })
  .strict();

export const JevitateLockSchema: z.ZodType<JevitateLock> = z
  .object({
    version: z.literal(1),
    sources: z.array(SourceEntrySchema),
  })
  .strict();

export function DEFAULT_LOCK_PATH(cwd?: string): string {
  return join(cwd ?? process.cwd(), "jevitate.lock");
}

function isNodeError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Missing lock file ⇒ empty lock (a fresh project has no sources yet).
 * A malformed/unparseable lock file THROWS — never silently degrades to
 * empty, since that would hide a corrupted or tampered team-shared lock
 * (fail-closed, §9.8).
 */
export async function readLock(path: string): Promise<JevitateLock> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNodeError(err, "ENOENT")) {
      return { version: 1, sources: [] };
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  return JevitateLockSchema.parse(parsed);
}

/**
 * Validates before writing (fail-closed — never persist an invalid lock) and
 * sorts `sources` by `name` so the on-disk file has a deterministic order
 * (clean diffs for a team-shared, git-committed lock — §7).
 */
export async function writeLock(path: string, lock: JevitateLock): Promise<void> {
  const validated = JevitateLockSchema.parse(lock);
  const sorted: JevitateLock = {
    version: validated.version,
    sources: [...validated.sources].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  await writeFile(path, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}
