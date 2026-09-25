import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, appendFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "@jevitate/explore";
import { openServerLogRuntime } from "./log-correlation.js";
import { parseLogDefectSpec, parseLogIgnoreSpec } from "./log-lines.js";
import type { LogSourceSpec } from "./log-sources.js";

/**
 * #169 item 3 — direct (non-served) coverage of `ServerLogRuntime`: `--log-ignore` excludes
 * known-noise lines from correlation and the defect oracle while still counting toward a source's
 * `linesRead` (it still proves the source was tailed), and a `server-log` defect's STORED `route`
 * is templated the same way the fingerprint already was internally.
 *
 * Uses a real `file:` source (tailed from its current end, #142) rather than a served browser
 * mission — cheaper than `server-log-e2e.test.ts` for logic that has nothing to do with the page.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const entry = (url: string): TranscriptEntry => ({
  step: 1,
  op: "click",
  target: 'button "Go"',
  confidence: null,
  chosenBy: "strategy",
  actOk: true,
  url,
  signature: "s1",
  controlCount: 1,
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function openTailedFile(): Promise<{ file: string; spec: LogSourceSpec }> {
  dir = await mkdtemp(join(tmpdir(), "jevitate-log-correlation-"));
  const file = join(dir, "app.log");
  await writeFile(file, ""); // exists before the source opens, so `opened: true` is immediate
  return { file, spec: { kind: "file", path: file, raw: `file:${file}` } };
}

describe("--log-ignore (#169 item 3)", () => {
  it(
    "excludes a matched line from the defect oracle and byLevel/topMessages, but still counts it in linesRead",
    async () => {
      const { file, spec } = await openTailedFile();
      const rt = openServerLogRuntime({
        sources: [spec],
        logDefect: [parseLogDefectSpec("error")],
        logIgnore: [parseLogIgnoreSpec("noisy")],
        secrets: [],
        drainMs: 700,
      });
      expect(rt).toBeDefined();
      await sleep(300); // let the poller confirm the file is open before writing

      const e = entry("http://x.test/api/orgs/123?token=secret");
      rt?.onTranscriptEntry(e, [e]);
      await appendFile(file, "ERROR duplicate key value violates unique constraint\n");
      await appendFile(file, "ERROR noisy background retry tick\n"); // matches --log-ignore
      await appendFile(file, "ERROR duplicate key value violates unique constraint\n");

      const result = await rt!.finish([e]);

      expect(result.summary.sources[0]?.linesRead).toBe(3); // every physical line still counted
      expect(result.summary.ignoredLines).toBe(1);
      expect(result.summary.byLevel.error).toBe(2); // the ignored line is excluded here
      expect(result.summary.topMessages.some((m) => m.message.includes("noisy"))).toBe(false);
      expect(result.defects).toHaveLength(1);
      expect(result.defects[0]?.occurrences).toBe(2);
      expect(result.defects[0]?.message).not.toContain("noisy");
    },
    15_000,
  );

  it(
    "also accepts a /regex/ form",
    async () => {
      const { file, spec } = await openTailedFile();
      const rt = openServerLogRuntime({
        sources: [spec],
        logDefect: [parseLogDefectSpec("error")],
        logIgnore: [parseLogIgnoreSpec("/retry tick$/")],
        secrets: [],
        drainMs: 700,
      });
      await sleep(300);

      const e = entry("http://x.test/jobs");
      rt?.onTranscriptEntry(e, [e]);
      await appendFile(file, "ERROR scheduler retry tick\n");
      await appendFile(file, "ERROR unrelated failure\n");

      const result = await rt!.finish([e]);
      expect(result.summary.ignoredLines).toBe(1);
      expect(result.defects).toHaveLength(1);
      expect(result.defects[0]?.message).toContain("unrelated failure");
    },
    15_000,
  );
});

describe("server-log defect route templating (#169 item 3)", () => {
  it("the STORED defect.route is templated (host/query dropped, numeric id segment -> :id), same as the fingerprint", async () => {
    const { file, spec } = await openTailedFile();
    const rt = openServerLogRuntime({
      sources: [spec],
      logDefect: [parseLogDefectSpec("error")],
      secrets: [],
      drainMs: 700,
    });
    await sleep(300);

    const e = entry("http://x.test/api/orgs/123?token=secret");
    rt?.onTranscriptEntry(e, [e]);
    await appendFile(file, "ERROR duplicate key value violates unique constraint\n");

    const result = await rt!.finish([e]);
    expect(result.defects).toHaveLength(1);
    expect(result.defects[0]?.route).toBe("/api/orgs/:id");
    expect(result.defects[0]?.title).toContain("/api/orgs/:id");
    expect(result.defects[0]?.title).not.toContain("token=secret");
    expect(result.defects[0]?.title).not.toContain("x.test");
  });
});
