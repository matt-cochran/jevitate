import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { PROJECT_GITIGNORE, allResultDirs, findProjectDir, initProjectDir, logDateOf, logsDirFor, projectDataDir, resultDirsFor } from "./project-dir.js";
import { DEFAULT_LOGS_RETENTION, LogsConfigError, loadLogsRetention, pruneLogs } from "./logs-retention.js";
import { buildProgram } from "./program.js";

/**
 * The 0.2.0 layout (surface-wiring audit follow-up): the repo's own `.jevitate/` holds Journeys,
 * regressions, baselines and dated logs; `~/.jevitate` keeps secrets and machine state, and holds
 * Journeys and logs only outside a repo. Logs are pruned: older than 14 days, keeping the newest 50.
 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-layout-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("project data dir", () => {
  it("is the nearest .jevitate walking up — never the per-user ~/.jevitate — else home", () => {
    const home = join(root, "home");
    const repo = join(home, "code", "app");
    mkdirSync(join(home, ".jevitate"), { recursive: true });
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    const deps = { homedir: () => home, cwd: () => join(repo, "src", "deep") };
    expect(findProjectDir(deps)).toBeNull(); // ~/.jevitate above is not a project
    expect(projectDataDir(["journeys"], deps)).toBe(join(home, ".jevitate", "journeys"));
    mkdirSync(join(repo, ".jevitate"));
    expect(findProjectDir(deps)).toBe(join(repo, ".jevitate"));
    expect(projectDataDir(["journeys"], deps)).toBe(join(repo, ".jevitate", "journeys"));
    expect(logsDirFor("2026-09-25T23:59:00.000Z", deps)).toBe(join(repo, ".jevitate", "logs", "2026-09-25"));
  });

  it("a result id maps to its dated logs dir (±1 day), project then home, then the 0.1.0 dirs", () => {
    const home = join(root, "home");
    const repo = join(root, "app");
    mkdirSync(join(repo, ".jevitate"), { recursive: true });
    const deps = { homedir: () => home, cwd: () => repo };
    expect(logDateOf("explore-2026-09-25T01-26-29-787Z")).toBe("2026-09-25");
    expect(resultDirsFor("explore-2026-09-25T01-26-29-787Z", deps)).toEqual([
      join(repo, ".jevitate", "logs", "2026-09-25"),
      join(repo, ".jevitate", "logs", "2026-09-24"),
      join(repo, ".jevitate", "logs", "2026-09-26"),
      join(home, ".jevitate", "logs", "2026-09-25"),
      join(home, ".jevitate", "logs", "2026-09-24"),
      join(home, ".jevitate", "logs", "2026-09-26"),
      join(home, ".jevitate", "recordings"),
      join(home, ".jevitate", "ux-reports"),
    ]);
    mkdirSync(join(repo, ".jevitate", "logs", "2026-09-20"), { recursive: true });
    mkdirSync(join(repo, ".jevitate", "logs", "2026-09-25"), { recursive: true });
    expect(allResultDirs(deps).slice(0, 2)).toEqual([join(repo, ".jevitate", "logs", "2026-09-25"), join(repo, ".jevitate", "logs", "2026-09-20")]);
  });

  it("init creates the repo's .jevitate at the git root with logs/ ignored, never overwriting; outside git it creates nothing", () => {
    const repo = join(root, "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "packages", "web"), { recursive: true });
    const r = initProjectDir(join(repo, "packages", "web"));
    expect(r.dir).toBe(join(repo, ".jevitate"));
    for (const d of ["journeys", "regressions", "baselines", "logs"]) expect(existsSync(join(repo, ".jevitate", d))).toBe(true);
    const ignorePath = join(repo, ".jevitate", ".gitignore");
    const first = readFileSync(ignorePath, "utf8");
    for (const line of PROJECT_GITIGNORE) expect(first.split("\n")).toContain(line);
    // Idempotent: a second run creates nothing and leaves the file byte-for-byte unchanged.
    expect(initProjectDir(repo).created).toEqual([]);
    expect(readFileSync(ignorePath, "utf8")).toBe(first);
    // An existing .gitignore keeps its lines and gains only what it lacks, each exactly once.
    writeFileSync(ignorePath, "custom/\n  logs/  \n/credentials.json\n");
    initProjectDir(repo);
    const merged = readFileSync(ignorePath, "utf8").split("\n");
    expect(merged.slice(0, 3)).toEqual(["custom/", "  logs/  ", "/credentials.json"]);
    for (const line of PROJECT_GITIGNORE) expect(merged.filter((l) => l.trim() === line)).toHaveLength(1);
    const again = readFileSync(ignorePath, "utf8");
    initProjectDir(repo);
    expect(readFileSync(ignorePath, "utf8")).toBe(again);
    const loose = join(root, "loose");
    mkdirSync(loose);
    expect(initProjectDir(loose)).toMatchObject({ dir: null, created: [] });
    expect(existsSync(join(loose, ".jevitate"))).toBe(false);
  });

  it("`jevitate init` reports the project dir it created", async () => {
    const repo = join(root, "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const lines: string[] = [];
    const program = buildProgram({
      profiles: new ProfileManager("/unused"),
      init: { detection: { existsSync: () => false, homedir: () => join(root, "home"), cwd: () => repo }, statePath: join(root, "state.json") },
    });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(["init", "--skip-keys", "--skip-skills", "--skip-mcp", "--json"], { from: "user" });
    expect(JSON.parse(lines.join("")).data.project).toMatchObject({ dir: join(repo, ".jevitate") });
  });
});

describe("log retention", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-09-25T12:00:00Z");
  function run(logs: string, date: string, stem: string, ageDays: number, files = [".json", ".result.json"]): void {
    mkdirSync(join(logs, date), { recursive: true });
    for (const ext of files) {
      const p = join(logs, date, `${stem}${ext}`);
      writeFileSync(p, "{}");
      const t = (NOW - ageDays * DAY) / 1000;
      utimesSync(p, t, t);
    }
  }

  it("deletes whole runs older than the TTL, always keeping the newest N, and drops emptied date dirs", () => {
    const logs = join(root, "logs");
    run(logs, "2026-09-01", "explore-2026-09-01T10-00-00-000Z", 24);
    run(logs, "2026-09-01", "coverage-2026-09-01T11-00-00-000Z", 24);
    run(logs, "2026-09-20", "explore-2026-09-20T10-00-00-000Z", 5);
    const dry = pruneLogs(logs, { ttlDays: 14, keepLatest: 1 }, { nowMs: NOW, dryRun: true });
    expect(dry.removed).toEqual(["2026-09-01/coverage-2026-09-01T11-00-00-000Z", "2026-09-01/explore-2026-09-01T10-00-00-000Z"]);
    expect(existsSync(join(logs, "2026-09-01"))).toBe(true);
    const r = pruneLogs(logs, { ttlDays: 14, keepLatest: 1 }, { nowMs: NOW });
    expect(r.removed).toHaveLength(2);
    expect(r.keptRuns).toBe(1);
    expect(existsSync(join(logs, "2026-09-01"))).toBe(false);
    expect(existsSync(join(logs, "2026-09-20", "explore-2026-09-20T10-00-00-000Z.result.json"))).toBe(true);
  });

  it("a quiet project is never wiped: the newest N survive however old", () => {
    const logs = join(root, "logs");
    run(logs, "2026-06-01", "explore-2026-06-01T10-00-00-000Z", 116);
    run(logs, "2026-06-02", "explore-2026-06-02T10-00-00-000Z", 115);
    expect(pruneLogs(logs, DEFAULT_LOGS_RETENTION, { nowMs: NOW }).removed).toEqual([]);
  });

  it("config: defaults when absent; logs.ttlDays / logs.keepLatest when set; malformed fails closed", () => {
    const cfg = join(root, "config.json");
    expect(loadLogsRetention(cfg)).toEqual({ ttlDays: 14, keepLatest: 50 });
    writeFileSync(cfg, JSON.stringify({ usage: {}, logs: { ttlDays: 30 } }));
    expect(loadLogsRetention(cfg)).toEqual({ ttlDays: 30, keepLatest: 50 });
    writeFileSync(cfg, JSON.stringify({ logs: { keepLatest: -1 } }));
    expect(() => loadLogsRetention(cfg)).toThrow(LogsConfigError);
  });

  it("`jevitate logs prune --dir --dry-run --json` reports without deleting", async () => {
    const logs = join(root, "logs");
    run(logs, "2026-01-01", "explore-2026-01-01T10-00-00-000Z", 267);
    const lines: string[] = [];
    const program = buildProgram({ profiles: new ProfileManager("/unused"), logs: { autoPrune: true, logsRoot: logs, configPath: join(root, "none.json") } });
    program.configureOutput({ writeOut: (s) => lines.push(s) });
    program.exitOverride();
    await program.parseAsync(["logs", "prune", "--dir", logs, "--dry-run", "--json"], { from: "user" });
    // The only run is also the newest: kept (keepLatest 50).
    expect(JSON.parse(lines.join("")).data).toMatchObject({ removed: [], keptRuns: 1, dryRun: true, retention: { ttlDays: 14, keepLatest: 50 } });
  });

  it("auto-prune runs before a command that writes logs, never before one that does not", async () => {
    const logs = join(root, "logs");
    run(logs, "2026-01-01", "explore-2026-01-01T10-00-00-000Z", 267);
    const cfg = join(root, "config.json");
    writeFileSync(cfg, JSON.stringify({ logs: { ttlDays: 14, keepLatest: 0 } }));
    const program = buildProgram({ profiles: new ProfileManager("/unused"), logs: { autoPrune: true, logsRoot: logs, configPath: cfg } });
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    program.exitOverride();
    await program.parseAsync(["journey", "list", "--dir", join(root, "none"), "--json"], { from: "user" });
    expect(existsSync(join(logs, "2026-01-01"))).toBe(true); // `journey list` writes no logs
    await program.parseAsync(["explore", "--json"], { from: "user" }); // refused for its args, after the prune
    expect(existsSync(join(logs, "2026-01-01"))).toBe(false);
  });
});
