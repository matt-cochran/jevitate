import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot, findProjectDir, initProjectDir } from "./project-dir.js";
import { journeyFixtureBaseDir } from "./journey-api.js";

/**
 * A git root is only a root when `.git` is a real repository marker: a worktree/submodule file, or
 * a directory with a `HEAD`. An empty `.git` (e.g. a sandbox placeholder under /tmp) is not one.
 */
let root: string;
beforeEach(() => {
  // tmpdir() is this run's own dir; the walks stop there, so a stray `/tmp/.git` or `/tmp/.jevitate` cannot leak in.
  root = mkdtempSync(join(tmpdir(), "jev-git-root-"));
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

/**
 * The 0.30.0 gate flake: a stray `/tmp/.jevitate` (left by a jevitate older than 0.29.0, which took the
 * Codex sandbox's empty `/tmp/.git` for a repo and made its project there) sat above every fixture, so
 * "no project here" tests found it. Each case below builds that machine state inside its own temp root
 * and points the run ceiling just below it, the way `test/global-temp-cleanup.ts` does for real.
 */
describe("a test run's temp dir is the ceiling of the project and git-root walks", () => {
  const saved = process.env.JEVITATE_TEST_RUN_TMPDIR;
  let run: string;
  beforeEach(() => {
    run = join(root, "run");
    mkdirSync(run);
    process.env.JEVITATE_TEST_RUN_TMPDIR = run;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.JEVITATE_TEST_RUN_TMPDIR;
    else process.env.JEVITATE_TEST_RUN_TMPDIR = saved;
  });

  it("an empty .git above a temp project is no repo, and the project below it is still found", () => {
    mkdirSync(join(root, ".git"));
    const project = join(run, "app");
    mkdirSync(join(project, ".jevitate"), { recursive: true });
    const nested = join(project, "src");
    mkdirSync(nested);
    expect(findGitRoot(nested)).toBeNull();
    expect(findProjectDir({ cwd: () => nested, homedir: () => join(run, "home") })).toBe(join(project, ".jevitate"));
    expect(journeyFixtureBaseDir({ cwd: () => nested, homedir: () => join(run, "home") })).toBe(project);
  });

  it("a stray .jevitate above the run dir is not a fixture's project", () => {
    mkdirSync(join(root, ".jevitate"));
    mkdirSync(join(root, ".git"));
    const fixture = join(run, "jev-noproj-x");
    mkdirSync(fixture);
    expect(findProjectDir({ cwd: () => fixture, homedir: () => fixture })).toBeNull();
    expect(journeyFixtureBaseDir({ cwd: () => fixture, homedir: () => fixture })).toBeUndefined();
  });

  it("a real repo above the run dir (TMPDIR inside a checkout) is not a fixture's repo", () => {
    withHead(join(root, ".git"));
    const fixture = join(run, "f");
    mkdirSync(fixture);
    expect(findGitRoot(fixture)).toBeNull();
  });

  it("still honours a real repo inside the run dir: a .git file (worktree) and a .git dir with HEAD", () => {
    const wt = join(run, "wt");
    mkdirSync(join(wt, "a"), { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    expect(findGitRoot(join(wt, "a"))).toBe(wt);
    const repo = join(run, "repo");
    withHead(join(repo, ".git"));
    mkdirSync(join(repo, "a"));
    expect(findGitRoot(join(repo, "a"))).toBe(repo);
  });

  it("does not stop a walk that starts outside the run dir", () => {
    const outside = join(root, "elsewhere");
    withHead(join(outside, ".git"));
    mkdirSync(join(outside, "a"));
    expect(findGitRoot(join(outside, "a"))).toBe(outside);
  });
});
