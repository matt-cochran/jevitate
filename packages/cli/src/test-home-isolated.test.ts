import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { homeDataRoot, logsRoot } from "./project-dir.js";
import { runIndexPath } from "./run-index.js";

/** `test/global-temp-cleanup.ts`: a test run has a home of its own, and never the person's. */
describe("a test run's home", () => {
  const real = process.env["JEVITATE_TEST_REAL_HOME"];

  it("is not the real one, here or in a process a test spawns", () => {
    expect(real).toBeTruthy();
    expect(homedir()).not.toBe(real);
    expect(homeDataRoot()).toBe(`${homedir()}/.jevitate`);
    const child = execFileSync(process.execPath, ["-p", "require('node:os').homedir()"], { encoding: "utf8" }).trim();
    expect(child).toBe(homedir());
    // What keeps a spawned CLI, in a checkout under the real home, from reading the real `~/.jevitate` as a project.
    const named = execFileSync(process.execPath, ["-p", "process.env.JEVITATE_TEST_REAL_HOME"], { encoding: "utf8" }).trim();
    expect(named).toBe(real);
  });

  it("is removed with the run's temp directory", () => {
    expect(homedir()).toMatch(/\/jvt-run-[^/]+\/home$/);
    expect(existsSync(homedir())).toBe(true);
  });

  it("leaves a real browser to find: the cache path was read before HOME moved", () => {
    expect(process.env["PLAYWRIGHT_BROWSERS_PATH"]).toBeTruthy();
    expect(process.env["PLAYWRIGHT_BROWSERS_PATH"]!.startsWith(homedir())).toBe(false);
  });

  // This checkout has no `.jevitate/`, and it may sit under the real home, whose `.jevitate/` is no project's.
  it("is where the run index and the logs go by default", () => {
    expect(runIndexPath()).toBe(`${homedir()}/.jevitate/run-index.jsonl`);
    expect(logsRoot()).toBe(`${homedir()}/.jevitate/logs`);
  });
});
