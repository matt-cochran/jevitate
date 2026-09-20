import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL(".", import.meta.url));

const FORBIDDEN: RegExp[] = [
  /\bnode:fs\b/,
  /from ["']fs["']/,
  /\bwriteFile(Sync)?\(/,
  /\bcreateWriteStream\(/,
  /better-sqlite3/,
  /\bnode:sqlite\b/,
  /\blocalStorage\b/,
];

describe("Hard Floor #6 — nothing stored at rest", () => {
  it("no @jevitate/secrets source file touches the filesystem or a database (thin delegation only, per-call fetch)", () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0); // guard against an empty/misconfigured glob silently "passing"
    for (const file of files) {
      const text = readFileSync(join(srcDir, file), "utf8");
      for (const pattern of FORBIDDEN) {
        expect(text, `${file} matched forbidden persistence pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("the runtime vault-autofill code path (@jevitate/runtime's JourneyRunner) also touches neither the filesystem nor a database with the fetched secret", () => {
    // The secret is fetched via SecretManagerPort inside JourneyRunner
    // (packages/runtime), not this package — so Hard Floor #6's "nothing
    // stored at rest" guarantee is only real if that call site is scanned
    // too, not just the manager implementations here.
    const runtimeJourneyRunnerPath = join(srcDir, "..", "..", "runtime", "src", "journey-runner.ts");
    const text = readFileSync(runtimeJourneyRunnerPath, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(text, `journey-runner.ts matched forbidden persistence pattern ${pattern}`).not.toMatch(pattern);
    }
  });
});
