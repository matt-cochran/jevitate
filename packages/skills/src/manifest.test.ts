import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "./manifest.js";

test("loadManifest() returns exactly the seven shipped skills, including jevitate-ux-review", () => {
  const skills = loadManifest();
  expect(skills).toHaveLength(7);
  const ids = new Set(skills.map((s) => s.id));
  expect(ids).toEqual(
    new Set([
      "jevitate-explore",
      "jevitate-load-test",
      "jevitate-mission-scope",
      "jevitate-record",
      "jevitate-run-journey",
      "jevitate-sources",
      "jevitate-ux-review",
    ]),
  );
});

test("every entry's id equals its directory name and starts with jevitate-", () => {
  for (const s of loadManifest()) {
    expect(s.id).toMatch(/^jevitate-/);
  }
});

test("every entry's frontmatter name equals its id", () => {
  for (const s of loadManifest()) {
    expect(s.name).toBe(s.id);
  }
});

test("every entry has a non-empty, sanely-bounded description", () => {
  for (const s of loadManifest()) {
    expect(s.description.length).toBeGreaterThan(0);
    expect(s.description.length).toBeLessThanOrEqual(500);
  }
});

test("a malformed SKILL.md (missing description) throws, naming the offending path", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-fixture-"));
  const skillDir = join(dir, "jevitate-broken");
  mkdirSync(skillDir);
  const filePath = join(skillDir, "SKILL.md");
  writeFileSync(filePath, "---\nname: jevitate-broken\n---\nBody.", "utf8");
  expect(() => loadManifest(dir)).toThrow(filePath);
});

test("the jevitate-mission-scope body maps to existing Journeys via journey find and journey run", () => {
  const scope = loadManifest().find((s) => s.id === "jevitate-mission-scope");
  expect(scope).toBeDefined();
  expect(scope!.body).toContain("journey find");
  expect(scope!.body).toContain("journey run");
});
