import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findProjectDir, homeDataRoot, sessionFileInProjectRefusal } from "./project-dir.js";

/**
 * #255 — file-path arguments over MCP. The CLI takes any path its operator types; an MCP argument
 * is chosen by a model, so every path an MCP tool accepts is confined at least as strictly as the
 * CLI confines it, and then some:
 *
 * - a non-empty string with no NUL byte;
 * - resolved (relative to the server's working directory) and — following symlinks through the
 *   longest existing prefix — strictly inside one of the allowed roots: the project (the server's
 *   working directory and the repo holding its `.jevitate/`) or the per-user `~/.jevitate/`. A
 *   `..` or symlink escape is refused, never normalised into somewhere else;
 * - a storage state (cookies/tokens) additionally never inside a repo's `.jevitate/`
 *   (`sessionFileInProjectRefusal`, the rule every storage-state writer on the CLI follows) —
 *   read or written.
 *
 * A refusal is a typed `invalid_args` MCP error naming the argument; nothing is opened.
 */

export class McpPathError extends Error {
  readonly error = "invalid_args" as const;
  constructor(message: string) {
    super(message);
    this.name = "McpPathError";
  }
}

/** The roots MCP path arguments may resolve inside (default: the project and `~/.jevitate`). */
export function defaultMcpPathRoots(): string[] {
  const project = findProjectDir();
  const roots = [process.cwd(), ...(project === null ? [] : [dirname(project)]), homeDataRoot()];
  return [...new Set(roots.map((r) => resolve(r)))];
}

/** `p` with its longest existing prefix resolved through symlinks (the rest appended as given). */
function realish(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(head)) {
      try {
        return join(realpathSync(head), ...tail);
      } catch {
        return p;
      }
    }
    const up = dirname(head);
    if (up === head) return p;
    tail.unshift(basename(head));
    head = up;
  }
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface ConfineOptions {
  /** A Playwright storage state (session cookies/tokens): also never under a repo's `.jevitate/`. */
  readonly session?: boolean;
}

/** The confined absolute path for the MCP argument `what`, or throws `McpPathError`. */
export function confineMcpPath(value: unknown, what: string, roots: readonly string[], opts: ConfineOptions = {}): string {
  if (typeof value !== "string" || value.trim() === "") throw new McpPathError(`'${what}' must be a non-empty path string`);
  if (value.includes("\0")) throw new McpPathError(`'${what}' must not contain a NUL byte`);
  const abs = resolve(value);
  const real = realish(abs);
  const realRoots = roots.map((r) => realish(resolve(r)));
  if (!realRoots.some((r) => inside(r, real)) || !roots.some((r) => inside(resolve(r), abs))) {
    throw new McpPathError(
      `'${what}' ${JSON.stringify(value)} resolves outside the paths an MCP tool may use (${roots.join(", ")}): put the file in the project or under ~/.jevitate/`,
    );
  }
  if (opts.session === true) {
    const refusal = sessionFileInProjectRefusal(abs, `'${what}'`);
    if (refusal !== undefined) throw new McpPathError(refusal);
  }
  return abs;
}
