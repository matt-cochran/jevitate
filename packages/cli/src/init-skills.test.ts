import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ResolvedSkill } from "@jevitate/skills";
import {
  detectRuntimes,
  resolveInstallTargetPaths,
  planFileInstall,
  applyFileInstall,
  renderSkillsBlock,
  mergeBlock,
  extractBlockHash,
  installSkills,
  SKILLS_BLOCK_BEGIN,
  SKILLS_BLOCK_END,
} from "./init-skills.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ---- Part 1: detection ----

test("detectRuntimes returns claude-code + generic when only ~/.claude exists", () => {
  const r = detectRuntimes({ existsSync: (p) => p === "/home/u/.claude", homedir: () => "/home/u", cwd: () => "/proj" });
  expect(r).toEqual(["claude-code", "generic"]);
});

test("detectRuntimes returns all four when claude, codex, and project .cursor all exist", () => {
  const present = new Set(["/home/u/.claude", "/home/u/.codex", "/proj/.cursor"]);
  const r = detectRuntimes({ existsSync: (p) => present.has(p), homedir: () => "/home/u", cwd: () => "/proj" });
  expect(r).toEqual(["claude-code", "codex", "cursor", "generic"]);
});

test("detectRuntimes returns generic only when nothing is present — never empty", () => {
  const r = detectRuntimes({ existsSync: () => false, homedir: () => "/home/u", cwd: () => "/proj" });
  expect(r).toEqual(["generic"]);
});

test("resolveInstallTargetPaths composes the five target paths from home + cwd", () => {
  const p = resolveInstallTargetPaths({ homedir: () => "/home/u", cwd: () => "/proj" });
  expect(p.claudeSkillsDir).toBe(join("/home/u", ".claude", "skills"));
  expect(p.codexAgentsFile).toBe(join("/home/u", ".codex", "AGENTS.md"));
  expect(p.cursorRulesDir).toBe(join("/proj", ".cursor", "rules"));
  expect(p.genericAgentsFile).toBe(join("/proj", "AGENTS.md"));
  expect(p.genericSkillsDir).toBe(join("/proj", ".agent", "skills"));
});

// ---- Part 2: whole-file planning ----

function tmpFile(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "planfile-"));
  const p = join(dir, "SKILL.md");
  if (content !== undefined) writeFileSync(p, content, "utf8");
  return p;
}

test("planFileInstall: absent target => create", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "planfile-")), "nope.md");
  expect(await planFileInstall(p, "new", undefined)).toBe("create");
});

test("planFileInstall: hash matches recorded, content differs => update", async () => {
  const p = tmpFile("old");
  expect(await planFileInstall(p, "new", sha256("old"))).toBe("update");
});

test("planFileInstall: hash matches recorded, content identical => unchanged", async () => {
  const p = tmpFile("same");
  expect(await planFileInstall(p, "same", sha256("same"))).toBe("unchanged");
});

test("planFileInstall: current hash != recorded => skip-user-modified", async () => {
  const p = tmpFile("user-edited");
  expect(await planFileInstall(p, "new", sha256("what-we-wrote"))).toBe("skip-user-modified");
});

test("planFileInstall: no recorded hash at all => skip-user-modified (pre-existing, never recorded)", async () => {
  const p = tmpFile("pre-existing");
  expect(await planFileInstall(p, "new", undefined)).toBe("skip-user-modified");
});

test("planFileInstall: skip-user-modified with force => force-update", async () => {
  const p = tmpFile("user-edited");
  expect(await planFileInstall(p, "new", undefined, { force: true })).toBe("force-update");
});

test("applyFileInstall writes for create/update/force-update, and never for unchanged/skip-user-modified", async () => {
  const p = tmpFile("orig");
  await applyFileInstall(p, "written", "update");
  expect(await readFile(p, "utf8")).toBe("written");
  await applyFileInstall(p, "ignored", "unchanged");
  expect(await readFile(p, "utf8")).toBe("written");
  await applyFileInstall(p, "ignored", "skip-user-modified");
  expect(await readFile(p, "utf8")).toBe("written");
});

// ---- Part 3: marked-block string functions ----

const fakeSkills = (): Array<Pick<ResolvedSkill, "id" | "name" | "description" | "body">> => [
  { id: "jevitate-a", name: "jevitate-a", description: "Does A.", body: "Body A." },
  { id: "jevitate-b", name: "jevitate-b", description: "Does B.", body: "Body B." },
];

test("renderSkillsBlock wraps entries in the versioned markers", () => {
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  expect(block.startsWith(SKILLS_BLOCK_BEGIN)).toBe(true);
  expect(block.trimEnd().endsWith(SKILLS_BLOCK_END)).toBe(true);
  expect(block).toContain("jevitate-a");
  expect(block).toContain("Body A.");
});

test("renderSkillsBlock reference mode points at the installed claude path instead of inlining the body", () => {
  const block = renderSkillsBlock(fakeSkills(), { mode: "reference", claudeSkillsDir: "/home/u/.claude/skills" });
  expect(block).toContain(join("/home/u/.claude/skills", "jevitate-a", "SKILL.md"));
  expect(block).not.toContain("Body A.");
});

test("mergeBlock appends to a file with no markers, preserving prior content byte-for-byte", () => {
  const existing = "# My AGENTS\n\nMy own notes.\n";
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const merged = mergeBlock(existing, block);
  expect(merged.startsWith(existing)).toBe(true);
  expect(merged).toContain(SKILLS_BLOCK_BEGIN);
});

test("mergeBlock replaces only the marked region, leaving surrounding user text identical", () => {
  const before = "PRE-USER-CONTENT\n\n";
  const after = "\n\nPOST-USER-CONTENT\n";
  const oldBlock = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const existing = before + oldBlock + after;
  const newBlock = renderSkillsBlock(
    [{ id: "jevitate-c", name: "jevitate-c", description: "Does C.", body: "Body C." }],
    { mode: "inline" },
  );
  const merged = mergeBlock(existing, newBlock);
  expect(merged.startsWith(before)).toBe(true);
  expect(merged.endsWith(after)).toBe(true);
  expect(merged).toContain("jevitate-c");
  expect(merged).not.toContain("jevitate-a");
});

test("mergeBlock is idempotent when run twice with the same block", () => {
  const existing = "user stuff\n";
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const once = mergeBlock(existing, block);
  const twice = mergeBlock(once, block);
  expect(twice).toBe(once);
});

test("extractBlockHash hashes only the inner block text (undefined when no block present)", () => {
  expect(extractBlockHash("no markers here")).toBeUndefined();
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const file = "prefix\n" + block + "\nsuffix";
  const otherFile = "totally different prefix\n" + block + "\nother suffix";
  // Same block, different surrounding text => same inner hash (user edits outside never register).
  expect(extractBlockHash(file)).toBe(extractBlockHash(otherFile));
});

// ---- Part 4: installSkills orchestration ----

function fixtureSkills(): ResolvedSkill[] {
  const dir = mkdtempSync(join(tmpdir(), "skillsrc-"));
  const mk = (id: string, desc: string, body: string) => {
    const d = join(dir, id);
    mkdirSync(d);
    const fp = join(d, "SKILL.md");
    writeFileSync(fp, `---\nname: ${id}\ndescription: ${desc}\n---\n\n${body}\n`, "utf8");
    return { id, name: id, description: desc, filePath: fp, body: `${body}\n` };
  };
  return [mk("jevitate-x", "Does X.", "Body X."), mk("jevitate-y", "Does Y.", "Body Y.")];
}

function envDirs() {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  const statePath = join(mkdtempSync(join(tmpdir(), "state-")), "skills-install-state.json");
  mkdirSync(join(home, ".claude"));
  const paths = resolveInstallTargetPaths({ homedir: () => home, cwd: () => cwd });
  return { home, cwd, statePath, paths };
}

test("first run: claude-code + generic writes every file and AGENTS.md block, all 'create'", async () => {
  const { cwd, statePath, paths } = envDirs();
  const skills = fixtureSkills();
  const report = await installSkills(["claude-code", "generic"], skills, paths, statePath, {});

  for (const s of skills) {
    const claudePath = join(paths.claudeSkillsDir, s.id, "SKILL.md");
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, "utf8")).toBe(readFileSync(s.filePath, "utf8"));
    expect(existsSync(join(paths.genericSkillsDir, s.id, "SKILL.md"))).toBe(true);
  }
  expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
  expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain(SKILLS_BLOCK_BEGIN);
  expect(report.every((r) => r.action === "create")).toBe(true);
});

test("second identical run: everything 'unchanged' and every file (incl. state) is byte-identical", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  const first = await installSkills(["claude-code", "generic"], skills, paths, statePath, {});

  const snapshot = new Map<string, string>();
  for (const r of first) snapshot.set(r.path, readFileSync(r.path, "utf8"));
  snapshot.set(statePath, readFileSync(statePath, "utf8"));

  const report = await installSkills(["claude-code", "generic"], skills, paths, statePath, {});
  expect(report.every((r) => r.action === "unchanged")).toBe(true);
  for (const [p, content] of snapshot) {
    expect(readFileSync(p, "utf8")).toBe(content);
  }
});

test("a hand-edited claude file is reported skip-user-modified and left untouched", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  await installSkills(["claude-code", "generic"], skills, paths, statePath, {});

  const edited = join(paths.claudeSkillsDir, "jevitate-x", "SKILL.md");
  await writeFile(edited, "USER HAND EDIT", "utf8");

  const report = await installSkills(["claude-code", "generic"], skills, paths, statePath, {});
  const entry = report.find((r) => r.target === "claude-code" && r.skillId === "jevitate-x");
  expect(entry!.action).toBe("skip-user-modified");
  expect(readFileSync(edited, "utf8")).toBe("USER HAND EDIT");
  // other pairs are unaffected
  const other = report.find((r) => r.target === "claude-code" && r.skillId === "jevitate-y");
  expect(other!.action).toBe("unchanged");
});

test("--force overwrites a hand-edited file, reported as force-update", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  await installSkills(["claude-code", "generic"], skills, paths, statePath, {});
  const edited = join(paths.claudeSkillsDir, "jevitate-x", "SKILL.md");
  await writeFile(edited, "USER HAND EDIT", "utf8");

  const report = await installSkills(["claude-code", "generic"], skills, paths, statePath, { force: true });
  const entry = report.find((r) => r.target === "claude-code" && r.skillId === "jevitate-x");
  expect(entry!.action).toBe("force-update");
  expect(readFileSync(edited, "utf8")).toBe(readFileSync(skills[0].filePath, "utf8"));
});

test("dry-run reports planned actions but performs no writes and no state file", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  const report = await installSkills(["claude-code", "generic"], skills, paths, statePath, { dryRun: true });
  expect(report.every((r) => r.action === "create")).toBe(true);
  expect(existsSync(join(paths.claudeSkillsDir, "jevitate-x", "SKILL.md"))).toBe(false);
  expect(existsSync(statePath)).toBe(false);
});
