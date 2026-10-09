import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { currentRunMetadata, stampRunMetadata, withRunMetadata } from "./run-metadata.js";
import { recordRun } from "./run-index.js";
import { diffRunRefs, resolveRunRefs, tagBaseline } from "./report-api.js";
import { writeMissionResult } from "./mission-journal.js";
import { CLI_TOOL_SPECS, buildCliArgv } from "./mcp-cli-tools.js";

/**
 * #426: `--tag key=value` on every command that produces a run result — stored in `result.tags`, the
 * envelope and the run index, filterable in `report`/`diff` (AND) — plus the structured target.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-tags-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused"), missionTargetsDir: join(dir, "targets") });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const code = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), code };
}

describe("run metadata scope and stamping", () => {
  it("stamps tags and the structured target; the result's own values win", () => {
    const r = stampRunMetadata(
      { strategy: "adversarial", target: { seedUrl: "http://a/x", allowlist: ["http://a"] }, tags: { own: "1" } },
      { tags: { feature: "checkout", own: "scope" }, persona: "admin" },
    );
    expect(r).toEqual({
      strategy: "adversarial",
      target: { seedUrl: "http://a/x", allowlist: ["http://a"], startUrl: "http://a/x", persona: "admin", strategy: "adversarial" },
      tags: { feature: "checkout", own: "1" },
    });
    expect(stampRunMetadata("text", { tags: { a: "1" } })).toBe("text");
    // No tags: no `tags` key at all.
    expect(stampRunMetadata({ x: 1 }, { tags: {} })).toEqual({ x: 1 });
  });

  it("stampRunMetadata sets target.id from the scope's targetId", () => {
    const r = stampRunMetadata({ target: { startUrl: "/profile" } }, { tags: {}, targetId: "checkout" });
    expect((r as { target: { id?: string } }).target.id).toBe("checkout");
  });

  it("nested scopes merge (inner tags win, the persona is kept) and concurrent scopes stay apart", async () => {
    await withRunMetadata({ tags: { a: "1", b: "1" }, persona: "admin" }, async () => {
      await withRunMetadata({ tags: { b: "2" } }, async () => {
        expect(currentRunMetadata()).toEqual({ tags: { a: "1", b: "2" }, persona: "admin" });
      });
    });
    const seen = await Promise.all(
      ["x", "y"].map((v) =>
        withRunMetadata({ tags: { t: v } }, async () => {
          await new Promise((r) => setImmediate(r));
          return currentRunMetadata()?.tags.t;
        }),
      ),
    );
    expect(seen).toEqual(["x", "y"]);
    expect(currentRunMetadata()).toBeUndefined();
  });

  it("a persisted result carries the scope's tags, and so does its run-index line", () => {
    const index = join(dir, "run-index.jsonl");
    const rec = join(dir, "adversarial-2026-10-01T00-00-00-000Z.json");
    try {
      // The persisted file: tags + the structured target.
      const path = withRunMetadata({ tags: { feature: "checkout" } }, () =>
        writeMissionResult(rec, "clean", 0, { strategy: "adversarial", missionOutcome: "clean", exitCode: 0, target: { seedUrl: "http://a/", allowlist: [] } }),
      );
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as { result: { tags: unknown; target: Record<string, unknown> } };
      expect(onDisk.result.tags).toEqual({ feature: "checkout" });
      expect(onDisk.result.target).toMatchObject({ startUrl: "http://a/", strategy: "adversarial" });
      // The index line (recordRun with an explicit index file).
      recordRun(path, { indexPath: index, env: {}, cwd: () => dir, tags: { feature: "checkout" } });
      const line = JSON.parse(readFileSync(index, "utf8").trim()) as { path: string; tags: unknown };
      expect(line).toMatchObject({ path, tags: { feature: "checkout" } });
    } finally {
      process.exitCode = undefined;
    }
  });
});

describe("--tag on the run commands", () => {
  it.each([
    ["explore", ["explore", "--url", "http://127.0.0.1:1/"]],
    ["journey run", ["journey", "run", "x"]],
    ["check", ["check", "--suite", "missing.json"]],
    ["load run", ["load", "run", "x"]],
    ["verify-fix", ["verify-fix", "--result", "x", "--fingerprint", "0123456789abcdef"]],
    ["regression run", ["regression", "run", "x"]],
    ["demo", ["demo", "x"]],
    ["mission run", ["mission", "run"]],
    ["source run", ["source", "run", "a", "b"]],
    ["campaign run", ["campaign", "run", "x.json"]],
  ])("%s refuses a malformed or duplicate tag before anything runs (E_TAG_ARGS, exit 64)", async (_name, argv) => {
    for (const bad of [["--tag", "no-equals"], ["--tag", "a=1", "--tag", "a=2"], ["--tag", "bad key=1"]]) {
      const { out, code } = await cli([...argv, ...bad, "--json"]);
      expect(code).toBe(64);
      expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: "E_TAG_ARGS" } });
    }
  });

  it("MCP run tools take a tags object, passed as --tag", () => {
    const spec = CLI_TOOL_SPECS.find((t) => t.name === "run_exploration")!;
    const argv = buildCliArgv(spec, { url: "http://127.0.0.1:1/", tags: { feature: "checkout", release: "0.8.0" } }, [process.cwd()]);
    expect(argv).toEqual(expect.arrayContaining(["--tag=feature=checkout", "--tag=release=0.8.0"]));
  });
});

const ORIGIN = "https://app.example";
function writeResult(results: string, stem: string, tags: Record<string, string> | undefined, fp: string): string {
  const path = join(results, `${stem}.result.json`);
  writeFileSync(
    path,
    JSON.stringify({
      missionOutcome: "defects-found",
      exitCode: 1,
      result: {
        strategy: "adversarial",
        target: { seedUrl: `${ORIGIN}/`, allowlist: [ORIGIN] },
        ...(tags === undefined ? {} : { tags }),
        defects: [{ fingerprint: fp, related: [fp], kind: "http-5xx", title: `HTTP 500 ${fp}`, route: "/", url: `${ORIGIN}/`, signals: [], occurrences: 1 }],
        hangs: [],
      },
    }),
  );
  return path;
}

describe("report / diff --tag (AND)", () => {
  it("report keeps only runs carrying every tag; an unmatched tag is refused (exit 64)", async () => {
    const results = join(dir, "results");
    mkdirSync(results);
    writeResult(results, "adversarial-2026-10-01T10-00-00-000Z", { feature: "checkout", release: "0.8.0" }, "aaaaaaaaaaaaaaaa");
    writeResult(results, "adversarial-2026-10-01T11-00-00-000Z", { feature: "search", release: "0.8.0" }, "bbbbbbbbbbbbbbbb");
    writeResult(results, "adversarial-2026-10-01T12-00-00-000Z", undefined, "cccccccccccccccc");
    const one = await cli(["report", "--dir", results, "--tag", "feature=checkout", "--tag", "release=0.8.0", "--json"]);
    expect(one.code).toBe(0);
    const env = JSON.parse(one.out) as { data: { runs: Array<{ runId: string; tags: unknown }>; tags: unknown } };
    expect(env.data.runs).toEqual([expect.objectContaining({ runId: "adversarial-2026-10-01T10-00-00-000Z", tags: { feature: "checkout", release: "0.8.0" } })]);
    expect(env.data.tags).toEqual({ feature: "checkout", release: "0.8.0" });
    const both = await cli(["report", "--dir", results, "--tag", "release=0.8.0", "--json"]);
    expect((JSON.parse(both.out) as { data: { runs: unknown[] } }).data.runs).toHaveLength(2);
    const none = await cli(["report", "--dir", results, "--tag", "feature=nope", "--json"]);
    expect(none.code).toBe(64);
    expect(JSON.parse(none.out)).toMatchObject({ ok: false, error: { code: "E_REPORT_INPUT" } });
    const bad = await cli(["report", "--dir", results, "--tag", "x", "--json"]);
    expect(JSON.parse(bad.out)).toMatchObject({ ok: false, error: { code: "E_TAG_ARGS" } });
  });

  it("diff narrows both sides (baseline tags of many features) to the tagged runs", async () => {
    const results = join(dir, "results");
    const baselines = join(dir, "baselines");
    mkdirSync(results);
    const a1 = writeResult(results, "adversarial-2026-10-01T10-00-00-000Z", { feature: "checkout" }, "aaaaaaaaaaaaaaaa");
    const a2 = writeResult(results, "adversarial-2026-10-01T10-30-00-000Z", { feature: "search" }, "bbbbbbbbbbbbbbbb");
    const b1 = writeResult(results, "adversarial-2026-10-02T10-00-00-000Z", { feature: "checkout" }, "aaaaaaaaaaaaaaaa");
    const b2 = writeResult(results, "adversarial-2026-10-02T10-30-00-000Z", { feature: "search" }, "dddddddddddddddd");
    const ctx = { dirs: [results], baselinesDir: baselines };
    await tagBaseline({ name: "before", runs: resolveRunRefs([a1, a2], ctx), dir: baselines });
    await tagBaseline({ name: "after", runs: resolveRunRefs([b1, b2], ctx), dir: baselines });
    const all = diffRunRefs("before", "after", ctx);
    expect(all.diff.summary.new).toBeGreaterThan(0);
    const checkout = diffRunRefs("before", "after", { ...ctx, tags: { feature: "checkout" } });
    expect(checkout.baseline).toHaveLength(1);
    expect(checkout.current).toHaveLength(1);
    expect(checkout.diff.summary).toMatchObject({ new: 0, resolved: 0 });
    expect(() => diffRunRefs("before", "after", { ...ctx, tags: { feature: "nope" } })).toThrow(/matches no run/);
  });
});
