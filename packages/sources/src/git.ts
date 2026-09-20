import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const execFileAsync = promisify(execFile);

/**
 * Injectable git execution port. The real implementation (`execGit`) shells
 * to `git` via `execFile` with an ARGS ARRAY only — never a shell string —
 * so a hostile `gitUrl`/commit/name can never be interpreted by a shell.
 * Tests inject a fake to assert call shape without touching the network.
 */
export type GitExec = (args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;

export const execGit: GitExec = async (args, opts) => {
  const { stdout } = await execFileAsync("git", args, { cwd: opts.cwd });
  return { stdout };
};

/** Rejects a source `name` containing a path separator or `..` segment —
 * mirrors `@jevitate/journey`'s `assertSafeId` / the lockfile's name guard —
 * since `name` is used to build a filesystem path under the managed
 * sources dir. */
function assertSafeName(name: string): void {
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.length === 0) {
    throw new Error(`Invalid source name (path traversal risk): ${name}`);
  }
}

/**
 * Clones/pins/pulls/updates/removes managed git-backed Journey sources under
 * a single `sourcesDir` (one subdirectory per source `name`, §14.1
 * `~/.jevitate/sources/<name>/` by convention — the caller supplies the dir).
 */
export class GitSourceManager {
  constructor(
    private readonly sourcesDir: string,
    private readonly exec: GitExec = execGit,
  ) {}

  resolveDir(name: string): string {
    assertSafeName(name);
    return join(this.sourcesDir, name);
  }

  /** Clones `gitUrl` into `resolveDir(name)` and returns the current HEAD
   * commit — the pin recorded in `jevitate.lock`. */
  async add(name: string, gitUrl: string): Promise<string> {
    const dir = this.resolveDir(name);
    await this.exec(["clone", gitUrl, dir], { cwd: this.sourcesDir });
    const { stdout } = await this.exec(["rev-parse", "HEAD"], { cwd: dir });
    return stdout.trim();
  }

  /** Fetches new refs from the remote but does NOT move the pin — advancing
   * the pin is only ever explicit, via `update()` (§9.9/§7 — no implicit,
   * auto-advancing trust). */
  async pull(name: string): Promise<void> {
    const dir = this.resolveDir(name);
    await this.exec(["fetch"], { cwd: dir });
  }

  /** Checks out an exact pinned commit. Fails closed (propagates) if the
   * commit is absent from the clone — never silently falls back to HEAD or
   * a branch tip. */
  async checkout(name: string, commit: string): Promise<void> {
    const dir = this.resolveDir(name);
    await this.exec(["checkout", commit], { cwd: dir });
  }

  /** The ONLY way a pin advances: fetch, fast-forward, and return the NEW
   * HEAD. Explicit and per-source — never automatic. */
  async update(name: string): Promise<string> {
    const dir = this.resolveDir(name);
    await this.exec(["fetch"], { cwd: dir });
    await this.exec(["merge", "--ff-only", "@{upstream}"], { cwd: dir });
    const { stdout } = await this.exec(["rev-parse", "HEAD"], { cwd: dir });
    return stdout.trim();
  }

  async remove(name: string): Promise<void> {
    const dir = this.resolveDir(name);
    await rm(dir, { recursive: true, force: true });
  }

  /** Escape hatch for the publish flow (Task 13): runs an arbitrary git
   * subcommand against a managed source's clone dir, through the same
   * injected `GitExec` (args-array only — no shell injection). Kept generic
   * rather than adding a bespoke method per git operation the publish flow
   * needs (`checkout -b`, `add`, `commit`, `push`). */
  async run(name: string, args: string[]): Promise<{ stdout: string }> {
    const dir = this.resolveDir(name);
    return this.exec(args, { cwd: dir });
  }
}
