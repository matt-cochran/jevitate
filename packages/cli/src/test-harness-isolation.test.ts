import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";

describe("test harness — a run's temp files are private to the run", () => {
  it("os.tmpdir() in a worker is the run-private directory the global setup created", () => {
    const runDir = process.env.JEVITATE_TEST_RUN_TMPDIR;
    expect(runDir).toMatch(/jvt-run-/);
    expect(tmpdir()).toBe(runDir);
  });
});
