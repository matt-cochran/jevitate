import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { findProjectDir, logsRoot } from "./project-dir.js";

/** A person's account home holding a project, with `HOME` elsewhere: a container with `useradd -d /workspace`. */
const account = mkdtempSync(join(tmpdir(), "jevitate-account-"));

vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), userInfo: () => ({ homedir: account }) }));

afterAll(() => rmSync(account, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe("a project at the account's home, with HOME pointing elsewhere", () => {
  const repo = join(account, "work", "repo");
  mkdirSync(join(account, ".jevitate"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  const elsewhere = { cwd: () => repo, homedir: () => join(account, "elsewhere") };

  it("stays the project: its environments.json, and a production flag in it, are not lost", () => {
    expect(findProjectDir(elsewhere)).toBe(join(account, ".jevitate"));
    expect(logsRoot(elsewhere)).toBe(join(account, ".jevitate", "logs"));
  });

  it("is still not the project when HOME is there: the per-user one never is", () => {
    expect(findProjectDir({ cwd: () => repo, homedir: () => account })).toBeNull();
  });

  describe("under a test run, whose setup names the real home", () => {
    it("the real home's is no project of a checkout under it", () => {
      vi.stubEnv("JEVITATE_TEST_REAL_HOME", account);
      expect(findProjectDir(elsewhere)).toBeNull();
      expect(logsRoot(elsewhere)).toBe(join(account, "elsewhere", ".jevitate", "logs"));
    });

    it("names a home and nothing more: set to the working directory's project root, it hides nothing", () => {
      const project = mkdtempSync(join(tmpdir(), "jevitate-project-"));
      mkdirSync(join(project, ".jevitate"));
      vi.stubEnv("JEVITATE_TEST_REAL_HOME", project);
      expect(findProjectDir({ cwd: () => project, homedir: () => join(account, "elsewhere") })).toBe(join(project, ".jevitate"));
      vi.stubEnv("JEVITATE_TEST_REAL_HOME", `${project}/`);
      expect(findProjectDir({ cwd: () => project, homedir: () => join(account, "elsewhere") })).toBe(join(project, ".jevitate"));
      // A subdirectory of a git checkout whose root it names: that root is the project's too.
      mkdirSync(join(project, ".git", "x"), { recursive: true });
      writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(project, "src"));
      vi.stubEnv("JEVITATE_TEST_REAL_HOME", project);
      expect(findProjectDir({ cwd: () => join(project, "src"), homedir: () => join(account, "elsewhere") })).toBe(join(project, ".jevitate"));
      rmSync(project, { recursive: true, force: true });
    });

    it("excludes that home's own and no other: a project below it is found, and empty means unset", () => {
      vi.stubEnv("JEVITATE_TEST_REAL_HOME", "");
      expect(findProjectDir(elsewhere)).toBe(join(account, ".jevitate"));
    });

    it("a real project between them is still found", () => {
      vi.stubEnv("JEVITATE_TEST_REAL_HOME", account);
      mkdirSync(join(account, "work", ".jevitate"), { recursive: true });
      expect(findProjectDir(elsewhere)).toBe(join(account, "work", ".jevitate"));
      rmSync(join(account, "work", ".jevitate"), { recursive: true, force: true });
    });
  });
});
