import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintMarker, targetsFor, type IssueDraft, type IssueFilerPort } from "@jevitate/domain";
import {
  FilingConfigError,
  loadFilingFileConfig,
  processIssueDrafts,
  resolveFilingConfig,
} from "./findings-filing.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

const draft: IssueDraft = {
  fingerprint: "abcdef0123456789",
  title: "[jevitate] HTTP 500",
  body: `body\n\n${fingerprintMarker("abcdef0123456789")}`,
  labels: [],
  attribution: "system-under-test",
  targets: targetsFor("system-under-test"),
};

describe("filing config — per target, flags win, off by default", () => {
  it("resolves the SUT repo by the run's origin; jevitate defaults to matt-cochran/jevitate", () => {
    const file = { enabled: true, targets: { "http://localhost:3000": { repo: "acme/app" } } };
    expect(resolveFilingConfig(file, {}, "http://localhost:3000")).toEqual({
      enabled: true,
      jevitateRepo: "matt-cochran/jevitate",
      targetRepo: "acme/app",
    });
    expect(resolveFilingConfig(file, {}, "http://other.test")).toEqual({ enabled: true, jevitateRepo: "matt-cochran/jevitate" });
    expect(resolveFilingConfig({}, {}, "http://x.test").enabled).toBe(false);
    expect(resolveFilingConfig(file, { fileIssues: false, issueRepo: "me/x" }, "http://x.test")).toMatchObject({
      enabled: false,
      targetRepo: "me/x",
    });
    expect(() => resolveFilingConfig({}, { issueRepo: "not a repo" }, "http://x.test")).toThrow(FilingConfigError);
  });

  it("a missing config file is 'no config'; a malformed one fails closed", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-filing-"));
    expect(loadFilingFileConfig(join(dir, "none.json"))).toEqual({});
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ enabled: "yes" }));
    expect(() => loadFilingFileConfig(bad)).toThrow(FilingConfigError);
    const ok = join(dir, "ok.json");
    await writeFile(ok, JSON.stringify({ enabled: true, targets: { "https://a.test": { repo: "o/a" } } }));
    expect(loadFilingFileConfig(ok)).toEqual({ enabled: true, targets: { "https://a.test": { repo: "o/a" } } });
  });
});

describe("processIssueDrafts — drafts always, filing only when enabled", () => {
  it("disabled: writes the draft next to the Recording and never creates a filer", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-filing-"));
    let made = 0;
    const out = await processIssueDrafts(
      join(dir, "adversarial-x.json"),
      [draft],
      { enabled: false, jevitateRepo: "o/j", targetRepo: "o/app" },
      () => {
        made += 1;
        throw new Error("must not be created");
      },
      "2026-09-23T00:00:00.000Z",
    );
    expect(made).toBe(0);
    expect(out.drafts[0]?.path).toBe(join(dir, "adversarial-x.issues", "abcdef0123456789.md"));
    expect(await readFile(join(dir, "adversarial-x.issues", "abcdef0123456789.md"), "utf8")).toContain("# [jevitate] HTTP 500");
    expect(out.filing).toEqual([
      { fingerprint: "abcdef0123456789", outcomes: [{ target: "system-under-test", status: "draft-only", reason: "filing is disabled" }] },
    ]);
  });

  it("enabled: files through the (fake) filer", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-filing-"));
    const created: string[] = [];
    const fake: IssueFilerPort = {
      findOpenByMarker: async () => null,
      create: async (repo) => {
        created.push(repo);
        return { number: 1, url: "u" };
      },
      comment: async (_r, n) => ({ number: n, url: "u" }),
    };
    const out = await processIssueDrafts(join(dir, "a.json"), [draft], { enabled: true, jevitateRepo: "o/j", targetRepo: "o/app" }, () => fake, "t");
    expect(created).toEqual(["o/app"]);
    expect(out.filing[0]?.outcomes[0]).toMatchObject({ status: "filed", action: "created" });
  });
});
