import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves a default runtime-data path under `~/.jevitate/<segments>`
 * (product = Jevitate). Greenfield: there is no legacy `~/.doit` location.
 * `homedir` is injectable so this is unit-testable without touching
 * `os.homedir()`. Duplicated (not imported) from `@jevitate/cli`'s identical
 * helper — this package must not depend on the CLI package, and the logic is
 * small enough that duplication beats a new shared package for it.
 */
export function resolveDataDir(
  segments: string[],
  deps: { homedir?: () => string } = {},
): string {
  const homedir = deps.homedir ?? osHomedir;
  return join(homedir(), ".jevitate", ...segments);
}
