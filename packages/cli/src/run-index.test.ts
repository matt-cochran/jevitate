import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexedRunsFor, projectKey, recordRun, type RunIndexDeps } from "./run-index.js";
import { buildReport } from "./report-api.js";

/**
 * #213: a bare `report` reads THIS project's runs — its own `.jevitate/logs` plus the runs the run
 * index recorded for it (an `--out` dir included) — never every app's `~/.jevitate/logs`.
 */
let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-run-index-"));
  home = join(dir, "home");
  mkdirSync(home);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ORIGIN = "https://app.example";
const OTHER = "https://other.example";

function repo(name: string): string {
  const r = join(dir, name);
  mkdirSync(join(r, ".git"), { recursive: true });
  return r;
}

function writeResult(path: string, origin: string, fp: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      missionOutcome: "defects-found",
      exitCode: 1,
      result: {
        strategy: "adversarial",
        target: { seedUrl: `${origin}/settings`, allowlist: [origin] },
        defects: [{ fingerprint: fp, kind: "http-5xx", title: "HTTP 503", route: "/settings", occurrences: 1 }],
      },
    }),
  );
  return path;
}

const depsIn = (cwd: string): RunIndexDeps => ({ cwd: () => cwd, homedir: () => home, env: {} });

describe("run index (#213)", () => {
  it("records each result under the project that wrote it (git root), and lists only that project's", () => {
    const a = repo("app-a");
    const b = repo("app-b");
    mkdirSync(join(a, "src"));
    const ra = writeResult(join(dir, "out-a", "adversarial-2026-09-22T10-00-00-000Z.result.json"), ORIGIN, "aaaa000000000001");
    const rb = writeResult(join(home, ".jevitate", "logs", "2026-09-22", "adversarial-2026-09-22T11-00-00-000Z.result.json"), OTHER, "bbbb000000000001");
    recordRun(ra, depsIn(join(a, "src")));
    recordRun(rb, depsIn(b));
    expect(projectKey(depsIn(join(a, "src")))).toBe(a);
    expect(indexedRunsFor(depsIn(a))).toEqual([ra]);
    expect(indexedRunsFor(depsIn(b))).toEqual([rb]);
    // Off: nothing recorded.
    recordRun(ra, { ...depsIn(b), env: { JEVITATE_RUN_INDEX: "off" } });
    expect(indexedRunsFor(depsIn(b))).toEqual([rb]);
  });

  it("a bare report reads the current project's runs (an --out dir included), not another app's ~/.jevitate/logs", async () => {
    const a = repo("app-a");
    const b = repo("app-b");
    const ra = writeResult(join(dir, "out-a", "adversarial-2026-09-22T10-00-00-000Z.result.json"), ORIGIN, "aaaa000000000001");
    const rb = writeResult(join(home, ".jevitate", "logs", "2026-09-22", "adversarial-2026-09-22T11-00-00-000Z.result.json"), OTHER, "bbbb000000000001");
    recordRun(ra, depsIn(a));
    recordRun(rb, depsIn(b));
    const report = await buildReport({ missionTargetsDir: join(dir, "targets"), index: depsIn(a) });
    expect(report.runs.map((r) => r.path)).toEqual([ra]);
    expect(report.summary.runs).toBe(1);
  });

  it("an unknown --target is refused with the known targets listed", async () => {
    const a = repo("app-a");
    const ra = writeResult(join(dir, "out-a", "adversarial-2026-09-22T10-00-00-000Z.result.json"), ORIGIN, "aaaa000000000001");
    recordRun(ra, depsIn(a));
    await expect(buildReport({ missionTargetsDir: join(dir, "targets"), target: "nosuch", index: depsIn(a) })).rejects.toThrow(
      `--target "nosuch" matches no recorded run; known targets: ${ORIGIN}`,
    );
  });
});
