import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves a default runtime-data path under the user's home directory,
 * preferring the current product convention (`~/.jevitate/<segments>`) but
 * falling back to the PRE-RENAME location (`~/.doit/<segments>`) when that
 * old path already exists and the new one does not — so a pre-existing
 * user's local trust/ack records aren't orphaned by the `@doit/*` ->
 * `@jevitate/*` product rename. There is no migration: the old path is
 * simply used in place until the caller (or the user) moves it.
 *
 * Resolution order, per call:
 *   1. `~/.jevitate/<segments>` if it exists.
 *   2. `~/.doit/<segments>` if IT exists (and the new one does not).
 *   3. `~/.jevitate/<segments>` otherwise (the default for a fresh install).
 *
 * `deps` is injectable so this is unit-testable without touching the real
 * filesystem or `os.homedir()`. Duplicated (not imported) from
 * `@jevitate/cli`'s identical helper — this package must not depend on the
 * CLI package, and the logic is small enough that duplication beats a new
 * shared package for it.
 */
export function resolveDataDir(
  segments: string[],
  deps: { exists?: (path: string) => boolean; homedir?: () => string } = {},
): string {
  const exists = deps.exists ?? existsSync;
  const homedir = deps.homedir ?? osHomedir;
  const home = homedir();
  const newPath = join(home, ".jevitate", ...segments);
  const oldPath = join(home, ".doit", ...segments);
  if (exists(newPath)) return newPath;
  if (exists(oldPath)) return oldPath;
  return newPath;
}
