import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";

/**
 * #763 — `journey lint` honours the target's `safety.readRequests`, exactly as `journey review` does.
 * The Journey's only request is a POST the target declares read-only (the issue's reproduction).
 * No browser.
 */

const ORIGIN = "https://example.test";
const READ_ONLY_POST = "/api/v1/tool/crm-companies/query";

function companiesJourney(site = ORIGIN): Journey {
  return {
    metadata: {
      id: "companies",
      name: "Open companies",
      description: "Queries the companies table",
      promoted: false,
      params: [],
      createdAtIso: "2026-11-04T00:00:00Z",
    },
    recording: {
      version: "1.0.0",
      site,
      pages: [
        {
          url: "/companies",
          steps: [
            {
              step: {
                kind: "click",
                target: { testId: "companies" },
                expect: { kind: "textIncludes", target: { role: "heading" }, text: "Companies" },
              },
              delta: {
                verdict: "relevant-change",
                why: "query rendered companies",
                changes: ["Companies heading"],
                requests: [`POST ${READ_ONLY_POST} → 200`],
                overheadMs: 1,
              },
            },
          ],
        },
      ],
    },
  };
}

let root: string;
let journeysDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-763-"));
  journeysDir = join(root, "journeys");
  installClock(new FakeClock({ startMs: Date.parse("2026-11-04T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
});

async function targetsFile(key: string, config: Record<string, unknown>): Promise<string> {
  const file = join(root, key);
  await writeFile(file, JSON.stringify(config));
  return file;
}

async function lint(journey: Journey, targets: string): Promise<readonly string[]> {
  await new FsJourneyStore(journeysDir).put(journey);
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    explore: { targetsConfigPath: targets },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  await program.parseAsync(["journey", "lint", journey.metadata.id, "--dir", journeysDir, "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));
  return parsed.data.findings.map((finding: { rule: string }) => finding.rule);
}

test("#763: lint does not report no-persistence-check for a configured read-only POST", async () => {
  const targets = await targetsFile("read-post.json", { [ORIGIN]: { safety: { readRequests: [READ_ONLY_POST] } } });

  const rules = await lint(companiesJourney(), targets);

  expect(rules).not.toContain("no-persistence-check");
});

test("#763: lint still reports no-persistence-check when the target is not configured", async () => {
  const targets = await targetsFile("other-origin.json", { "https://other.test": { safety: { readRequests: [READ_ONLY_POST] } } });

  const rules = await lint(companiesJourney(), targets);

  expect(rules).toContain("no-persistence-check");
});

test("#763: lint of a Journey with no resolvable origin behaves as before", async () => {
  const targets = await targetsFile("read-post-no-origin.json", { [ORIGIN]: { safety: { readRequests: [READ_ONLY_POST] } } });

  const rules = await lint(companiesJourney("not-a-resolvable-origin"), targets);

  expect(rules).toContain("no-persistence-check");
});
