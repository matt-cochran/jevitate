import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { findProjectDir, logsRoot } from "./project-dir.js";

const account = mkdtempSync(join(tmpdir(), "jevitate-account-"));

vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), userInfo: () => ({ homedir: account }) }));

afterAll(() => rmSync(account, { recursive: true, force: true }));

describe("the account's own ~/.jevitate, with HOME pointing elsewhere", () => {
  const repo = join(account, "work", "repo");
  mkdirSync(join(account, ".jevitate"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  const elsewhere = { cwd: () => repo, homedir: () => join(account, "elsewhere") };

  it("is no project of a repo under it: data goes to the HOME in force", () => {
    expect(findProjectDir(elsewhere)).toBeNull();
    expect(logsRoot(elsewhere)).toBe(join(account, "elsewhere", ".jevitate", "logs"));
  });

  it("a real project between them is still found", () => {
    mkdirSync(join(account, "work", ".jevitate"));
    expect(findProjectDir(elsewhere)).toBe(join(account, "work", ".jevitate"));
  });
});
