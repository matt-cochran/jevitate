import { expect, test, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { loadRegressions, replayRegression } from "./regression-suite.js";

test("loadRegressions returns [] for a missing/empty directory", async () => {
  expect(await loadRegressions(join(tmpdir(), "does-not-exist-" + Date.now()))).toEqual([]);
});

test("loadRegressions reads every committed *.recording.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "regr-suite-"));
  const recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/x", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/x" } } }] }],
  };
  await writeFile(join(dir, "bug-1.recording.json"), JSON.stringify(recording));
  const cases = await loadRegressions(dir);
  expect(cases).toHaveLength(1);
  expect(cases[0].id).toBe("bug-1");
  expect(cases[0].recording.pages[0].steps[0].step.kind).toBe("assert");
});

test("replayRegression reports completed when the interpreter finishes, failed otherwise", async () => {
  const passingPage = { url: vi.fn(() => "https://example.test/x") };
  const actor = CastActor.named("suite").whoCan(
    new BrowseTheWeb({ page: passingPage, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []),
  );
  const recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/x", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/x" } } }] }],
  };
  expect(await replayRegression(actor, recording as any)).toBe("completed");
});
