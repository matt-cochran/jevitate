import { expect, test } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recording } from "@jevitate/recording";
import type { ReproductionReport } from "./reproduce.js";
import { commitRegression, FlakyNotCommittableError } from "./commit.js";

const rec: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [{ url: "/x", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/x" } } }] }],
};

const reproducibleReport: ReproductionReport = {
  attempts: 3,
  reproducedCount: 3,
  rate: 1,
  label: "reproducible",
  fingerprint: { stepSignature: "assert|/x|assert:urlIncludes:/x" },
  firstFailureAt: 0,
};

const flakyReport: ReproductionReport = { ...reproducibleReport, label: "flaky", rate: 0.5, reproducedCount: 1 };

test("commits a reproducible regression as a Recording + meta sidecar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "regr-"));
  const { recordingPath, metaPath } = await commitRegression(dir, "bug-123", rec, reproducibleReport, "checkout total wrong after coupon");

  const savedRecording = JSON.parse(await readFile(recordingPath, "utf8"));
  expect(savedRecording.pages[0].steps[0].step.kind).toBe("assert");

  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  expect(meta.id).toBe("bug-123");
  expect(meta.reproduction).toEqual({ attempts: 3, reproducedCount: 3, rate: 1 });
  expect(meta.bugSummary).toBe("checkout total wrong after coupon");

  const files = await readdir(dir);
  expect(files.sort()).toEqual(["bug-123.meta.json", "bug-123.recording.json"]);
});

test("refuses to commit a flaky report — writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "regr-"));
  await expect(commitRegression(dir, "bug-flaky", rec, flakyReport)).rejects.toThrow(FlakyNotCommittableError);
  expect(await readdir(dir)).toEqual([]);
});
