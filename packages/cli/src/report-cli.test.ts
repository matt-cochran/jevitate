import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { readBaseline, resolveRunRefs, tagBaseline } from "./report-api.js";

/**
 * #139 `jevitate report` and #138 `jevitate diff` / `--baseline` over persisted results on disk:
 * one deduped defect list across modes and runs, each defect with its modes, runs, occurrence
 * counts, evidence and reproduction command — and a diff that matches findings by identity.
 */

let dir: string;
let results: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-report-"));
  results = join(dir, "results");
  mkdirSync(results);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ORIGIN = "https://app.example";

function http503(fp: string, occurrences = 1) {
  return {
    fingerprint: fp,
    related: [fp],
    kind: "http-5xx",
    title: "HTTP 503 from /api/items/:id",
    route: "/settings",
    url: `${ORIGIN}/settings`,
    signals: [{ kind: "http-5xx", detail: "503", url: `${ORIGIN}/api/items/7`, status: 503 }],
    occurrences,
    occurrenceSteps: [2],
    repro: { steps: [{ step: 2, target: 'button "Save"' }], recordingStepIndex: 1 },
  };
}

function writeResult(stem: string, missionOutcome: string, result: Record<string, unknown>): string {
  const path = join(results, `${stem}.result.json`);
  writeFileSync(path, JSON.stringify({ missionOutcome, exitCode: 1, result: { target: { seedUrl: `${ORIGIN}/settings`, allowlist: [ORIGIN] }, ...result } }));
  return path;
}

function seed(): { adv1: string; adv2: string; goal: string } {
  const adv1 = writeResult("adversarial-2026-09-20T10-00-00-000Z", "defects-found", { defects: [http503("fp503", 2)], hangs: [], advisories: [] });
  const adv2 = writeResult("adversarial-2026-09-22T10-00-00-000Z", "defects-found", { defects: [http503("fp503")], hangs: [], advisories: [] });
  const goal = writeResult("explore-2026-09-22T11-00-00-000Z", "exhausted", {
    outcome: "exhausted",
    checks: [{ check: "requestMade:PUT /api/profile", passed: false, detail: "no PUT request matched" }],
    defects: [
      {
        fingerprint: "fpInv",
        related: ["fpInv"],
        kind: "invariant",
        title: 'Invariant "no-uuid" violated on /settings',
        route: "/settings",
        url: `${ORIGIN}/settings`,
        invariant: { id: "no-uuid", action: { op: "click", control: "Save" }, evidence: ["GET /api/items 200"] },
        occurrences: 1,
        repro: { recordingStepIndex: 3 },
      },
    ],
  });
  // A usability report + its sibling Recording (which names the origin); another target's run.
  writeFileSync(
    join(results, "usability-2026-09-22T12-00-00-000Z.json"),
    JSON.stringify({ headline: "1 finding", findings: [{ rubricItemId: "signal-internal-id", route: "/settings", controls: [], screenIds: ["s3"], occurrences: 1, observation: "raw uuid shown" }] }),
  );
  writeFileSync(join(results, "usability-2026-09-22T12-00-00-000Z.recording.json"), JSON.stringify({ version: "1.0.0", site: ORIGIN, pages: [] }));
  writeResult("adversarial-2026-09-22T13-00-00-000Z", "clean", { target: { seedUrl: "https://other.example/", allowlist: [] }, defects: [] });
  // Noise a scan must ignore: a Recording, a transcript.
  writeFileSync(join(results, "adversarial-2026-09-22T10-00-00-000Z.json"), JSON.stringify({ version: "1.0.0", site: ORIGIN, pages: [] }));
  writeFileSync(join(results, "adversarial-2026-09-22T10-00-00-000Z.transcript.json"), "[]");
  return { adv1, adv2, goal };
}

async function cli(args: string[], missionTargetsDir = join(dir, "targets")): Promise<{ out: string; code: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused"), missionTargetsDir });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const code = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = undefined;
  return { out: lines.join(""), code };
}

describe("jevitate report (#139)", () => {
  it("lists one deduped defect per identity across modes and runs, with runs, counts, evidence and the verify-fix command", async () => {
    const { adv2 } = seed();
    const { out, code } = await cli(["report", "--target", ORIGIN, "--dir", results, "--json"]);
    expect(code).toBe(0);
    const env = JSON.parse(out) as { ok: boolean; data: { runs: Array<{ runId: string }>; defects: Array<Record<string, unknown>>; summary: unknown; markdown: string } };
    expect(env.ok).toBe(true);
    expect(env.data.runs.map((r) => r.runId)).toEqual([
      "adversarial-2026-09-20T10-00-00-000Z",
      "adversarial-2026-09-22T10-00-00-000Z",
      "explore-2026-09-22T11-00-00-000Z",
      "usability-2026-09-22T12-00-00-000Z",
    ]); // the other origin's run is not in this target's report
    expect(env.data.summary).toEqual({ defects: 3, advisory: 1, runs: 4 });
    const d503 = env.data.defects.find((d) => d.category === "defect");
    expect(d503).toMatchObject({
      occurrences: 3,
      runCount: 2,
      identity: { signal: "http-5xx", route: "/settings", control: 'button "Save"', request: "503 /api/items/:id" },
      modes: [{ mode: "adversarial", occurrences: 3, runs: [{ occurrences: 2 }, { occurrences: 1 }] }],
      reproduce: `jevitate verify-fix --result ${adv2} --fingerprint fp503`,
    });
    expect((d503?.evidence as Array<Record<string, unknown>>)[0]).toMatchObject({ step: 2, request: `${ORIGIN}/api/items/7` });
    expect(env.data.defects.map((d) => d.category).sort()).toEqual(["defect", "goal-check", "invariant", "ux"]);
    expect(env.data.markdown).toContain("## Defects");
    expect(env.data.markdown).toContain("reproduce: `jevitate verify-fix --result");
  });

  it("prints markdown by default and narrows with --since (a date or a run)", async () => {
    seed();
    const md = await cli(["report", "--target", ORIGIN, "--dir", results]);
    expect(md.out.startsWith(`# Defect report — ${ORIGIN}`)).toBe(true);
    const since = await cli(["report", "--target", ORIGIN, "--dir", results, "--since", "2026-09-22T11:00:00Z", "--json"]);
    expect((JSON.parse(since.out) as { data: { runs: unknown[] } }).data.runs).toHaveLength(2);
    const sinceRun = await cli(["report", "--target", ORIGIN, "--dir", results, "--since", "adversarial-2026-09-22T10-00-00-000Z", "--json"]);
    expect((JSON.parse(sinceRun.out) as { data: { runs: unknown[] } }).data.runs).toHaveLength(3);
  });

  it("resolves --target by a registered mission target's name", async () => {
    seed();
    mkdirSync(join(dir, "targets"));
    writeFileSync(join(dir, "targets", "app.json"), JSON.stringify({ id: "app", name: "App", authorizedOrigin: ORIGIN, baseUrl: `${ORIGIN}/` }));
    const { out } = await cli(["report", "--target", "App", "--dir", results, "--json"]);
    expect((JSON.parse(out) as { data: { runs: unknown[]; target: string } }).data).toMatchObject({ target: ORIGIN });
  });
});

describe("jevitate diff and --baseline (#138)", () => {
  it("diff <runA> <runB> classifies by finding identity", async () => {
    const { adv1, goal } = seed();
    const { out, code } = await cli(["diff", adv1, goal, "--json"]);
    expect(code).toBe(0);
    const env = JSON.parse(out) as { data: { summary: Record<string, number>; entries: Array<{ status: string; defect: { category: string } }> } };
    // The 503 was only ever seen by adversarial runs: the goal run could not have seen it.
    expect(env.data.entries.map((e) => [e.defect.category, e.status]).sort()).toEqual([
      ["defect", "not-rerun"],
      ["goal-check", "new"],
      ["invariant", "new"],
    ]);
    const same = await cli(["diff", "adversarial-2026-09-20T10-00-00-000Z", "adversarial-2026-09-22T10-00-00-000Z", "--dir", results, "--json"]);
    expect((JSON.parse(same.out) as { data: { summary: Record<string, number> } }).data.summary).toMatchObject({ "still-present": 1 });
  });

  it("report --baseline last diffs each mode against the previous run on the same target", async () => {
    seed();
    const { out } = await cli(["report", "--target", ORIGIN, "--dir", results, "--since", "2026-09-22T00:00:00Z", "--baseline", "last", "--json"]);
    const env = JSON.parse(out) as { data: { diff: { summary: Record<string, number> }; baselineRuns: Array<{ runId: string }>; markdown: string } };
    expect(env.data.baselineRuns.map((r) => r.runId)).toEqual(["adversarial-2026-09-20T10-00-00-000Z"]);
    expect(env.data.diff.summary).toMatchObject({ "still-present": 1, new: 3 });
    expect(env.data.markdown).toContain("## Diff against baseline");
  });

  it("baseline tag snapshots runs, and a tag resolves as a run reference", async () => {
    const { adv1, adv2 } = seed();
    const baselines = join(dir, "baselines");
    const runs = resolveRunRefs([adv1, "adversarial-2026-09-22T10-00-00-000Z"], { dirs: [results] });
    expect(runs).toHaveLength(2);
    await tagBaseline({ name: "release-1", runs, dir: baselines });
    // The snapshot survives the result files being pruned.
    rmSync(adv1);
    rmSync(adv2);
    const tag = readBaseline("release-1", baselines);
    expect(tag?.runs.map((r) => r.runId)).toEqual(["adversarial-2026-09-20T10-00-00-000Z", "adversarial-2026-09-22T10-00-00-000Z"]);
    expect(resolveRunRefs(["release-1"], { dirs: [results], baselinesDir: baselines })).toHaveLength(2);
    await expect(tagBaseline({ name: "../evil", runs, dir: baselines })).rejects.toThrow(/invalid baseline tag/);
    expect(readFileSync(join(baselines, "release-1.json"), "utf8")).toContain('"fingerprint": "fp503"');
  });

  it("an unknown run reference is a typed refusal", async () => {
    seed();
    const { out, code } = await cli(["diff", "nope", "adversarial-2026-09-22T10-00-00-000Z", "--dir", results]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: "E_REPORT_INPUT" } });
  });
});
