import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot, initProjectDir } from "./project-dir.js";

/**
 * A git root is only a root when `.git` is a real repository marker: a worktree/submodule file, or
 * a directory with a `HEAD`. An empty `.git` (e.g. a sandbox placeholder under /tmp) is not one.
 */
let root: string;
beforeEach(() => {
  // /var/tmp has no ancestor `.git`; a stray `/tmp/.git` from a concurrent sandbox cannot leak in.
  root = mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : tmpdir(), "jev-git-root-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const withHead = (gitDir: string): void => {
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
};

describe("findGitRoot", () => {
  it("does not treat an empty .git directory as a git root", () => {
    const repo = join(root, "empty");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(findGitRoot(repo)).toBeNull();
  });

  it("treats a .git directory containing HEAD as a git root", () => {
    const repo = join(root, "with-head");
    withHead(join(repo, ".git"));
    expect(findGitRoot(repo)).toBe(repo);
  });

  it("treats a .git file as a git root", () => {
    const repo = join(root, "worktree");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    expect(findGitRoot(repo)).toBe(repo);
  });

  it("walks past an empty .git with no real repository above it", () => {
    const repo = join(root, "placeholder");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBeNull();
  });

  it("initProjectDir reports dir null under a parent whose only .git is empty", () => {
    const repo = join(root, "placeholder");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const nested = join(repo, "packages", "web");
    mkdirSync(nested, { recursive: true });
    expect(initProjectDir(nested).dir).toBeNull();
  });

  it("initProjectDir creates no .jevitate under a parent whose only .git is empty", () => {
    const repo = join(root, "placeholder");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const nested = join(repo, "packages", "web");
    mkdirSync(nested, { recursive: true });
    initProjectDir(nested);
    expect(existsSync(join(repo, ".jevitate"))).toBe(false);
  });
});
