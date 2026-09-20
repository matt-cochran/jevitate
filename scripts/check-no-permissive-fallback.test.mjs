import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-no-permissive-fallback.mjs", import.meta.url));

function runScript(root) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, root], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "no-fallback-fixture-"));
  for (const [relPath, contents] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

describe("check-no-permissive-fallback.mjs", () => {
  it("exits non-zero and names the file when a catch block returns a fake success", () => {
    const dir = makeFixture({
      "pkg-a/src/bad.ts": `
        export function doThing() {
          try {
            risky();
          } catch (e) {
            return { outcome: "ok", output: null };
          }
        }
      `,
    });
    try {
      const result = runScript(dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(join(dir, "pkg-a/src/bad.ts"));
      expect(result.stderr).toMatch(/outcome: "ok"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when a policy/secret read is defaulted to success", () => {
    const dir = makeFixture({
      "pkg-a/src/bad2.ts": `
        export function decide(policy) {
          const result = policy.secretMode ?? { outcome: "ok" };
          return result;
        }
      `,
    });
    try {
      const result = runScript(dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(join(dir, "pkg-a/src/bad2.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when run_journey/runJourney accepts inline steps", () => {
    const dir = makeFixture({
      "pkg-a/src/bad3.ts": `
        export function runJourney(id, opts) {
          return execute({ steps: opts.steps });
        }
      `,
    });
    try {
      const result = runScript(dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(join(dir, "pkg-a/src/bad3.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 on a clean fixture with a genuine success return (not a permissive fallback)", () => {
    const dir = makeFixture({
      "pkg-a/src/good.ts": `
        export function doThing() {
          try {
            const output = risky();
            return { outcome: "ok", output };
          } catch (e) {
            throw e;
          }
        }
      `,
      "pkg-a/src/good.test.ts": `
        // excluded: .test.ts files are not scanned, even with bad shapes.
        it("x", () => { try {} catch (e) { return { outcome: "ok" }; } });
      `,
    });
    try {
      const result = runScript(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/0 hits/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 with zero false positives on the real repo tree", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const result = runScript(join(repoRoot, "packages"));
    expect(result.status).toBe(0);
  });
});
