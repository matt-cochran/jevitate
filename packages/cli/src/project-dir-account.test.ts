import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

    it("a real project between them is still found", () => {
      vi.stubEnv("JEVITATE_TEST_REAL_HOME", account);
      mkdirSync(join(account, "work", ".jevitate"), { recursive: true });
      expect(findProjectDir(elsewhere)).toBe(join(account, "work", ".jevitate"));
      rmSync(join(account, "work", ".jevitate"), { recursive: true, force: true });
    });
  });
});
