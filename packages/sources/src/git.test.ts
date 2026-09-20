import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitSourceManager, execGit, type GitExec } from "./git.js";

const execFileAsync = promisify(execFile);

describe("GitSourceManager (fake GitExec)", () => {
  const calls: string[][] = [];
  const fake: GitExec = async (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return { stdout: "b".repeat(40) + "\n" };
    if (args[0] === "checkout" && args[1] === "missing-commit") {
      throw new Error("fatal: reference is not a tree: missing-commit");
    }
    return { stdout: "" };
  };

  it("add clones then pins to HEAD (rev-parse), args are an array (no shell injection)", async () => {
    calls.length = 0;
    const m = new GitSourceManager(mkdtempSync(join(tmpdir(), "src-")), fake);
    const pin = await m.add("gmail", "https://github.com/x/jevitate-gmail");
    expect(pin).toBe("b".repeat(40));
    expect(calls.some((a) => a[0] === "clone")).toBe(true);
    // The url must be passed as its OWN array element, never concatenated
    // into a shell string — that's what makes shell injection impossible.
    const cloneCall = calls.find((a) => a[0] === "clone")!;
    expect(cloneCall).toContain("https://github.com/x/jevitate-gmail");
  });

  it("rejects a path-traversal source name", () => {
    const m = new GitSourceManager("/tmp/x", fake);
    expect(() => m.resolveDir("../evil")).toThrow();
  });

  it("checkout of a missing commit rejects (fake throws → propagate, no swallow)", async () => {
    const m = new GitSourceManager(mkdtempSync(join(tmpdir(), "src-")), fake);
    await expect(m.checkout("gmail", "missing-commit")).rejects.toThrow();
  });

  it("pull only fetches — never moves the pin (no merge/checkout call)", async () => {
    calls.length = 0;
    const m = new GitSourceManager(mkdtempSync(join(tmpdir(), "src-")), fake);
    await m.pull("gmail");
    expect(calls.some((a) => a[0] === "fetch")).toBe(true);
    expect(calls.some((a) => a[0] === "merge" || a[0] === "checkout")).toBe(false);
  });
});

describe("execGit (real git, no network — local bare repo integration)", () => {
  it("clones a local bare repo and add() returns the pinned HEAD commit", async () => {
    const work = mkdtempSync(join(tmpdir(), "gitwork-"));
    const bareRepo = join(work, "origin.git");
    await execFileAsync("git", ["init", "--bare", bareRepo]);

    const seed = join(work, "seed");
    await execFileAsync("git", ["clone", bareRepo, seed]);
    await execFileAsync("git", ["-C", seed, "checkout", "-b", "main"]);
    await execFileAsync("git", ["-C", seed, "config", "user.email", "t@example.com"]);
    await execFileAsync("git", ["-C", seed, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", seed, "commit", "--allow-empty", "-m", "seed"]);
    await execFileAsync("git", ["-C", seed, "push", "origin", "HEAD:main"]);
    // The bare repo's HEAD symref may still default to `master` (which was
    // never created) — point it at `main` so a plain clone checks out a
    // commit rather than landing on an unborn branch.
    await execFileAsync("git", ["--git-dir", bareRepo, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const { stdout: headOut } = await execFileAsync("git", ["-C", seed, "rev-parse", "HEAD"]);
    const expectedHead = headOut.trim();

    const sourcesDir = mkdtempSync(join(tmpdir(), "sources-"));
    const mgr = new GitSourceManager(sourcesDir, execGit);
    const pin = await mgr.add("myrepo", bareRepo);

    expect(pin).toBe(expectedHead);
    expect(existsSync(join(sourcesDir, "myrepo"))).toBe(true);
  }, 30_000);
});
