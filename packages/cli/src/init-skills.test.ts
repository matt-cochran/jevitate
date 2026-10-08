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
  findSkillsBlock,
  planBlockInstall,
  uninstallSkills,
  SkillsBlockMarkerError,
  SKILLS_BLOCK_BEGIN,
  SKILLS_BLOCK_END,
  SKILLS_BLOCK_BEGIN_RE,
  SKILLS_BLOCK_END_RE,
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

// ---- Part 3b: version-agnostic markers + findSkillsBlock (#431) ----

test("renderSkillsBlock stamps the BEGIN marker with jevitate@<version> when asked", () => {
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline", jevitateVersion: "1.2.3" });
  expect(block.startsWith("<!-- BEGIN JEVITATE SKILLS v1 jevitate@1.2.3 -->")).toBe(true);
});

test("renderSkillsBlock omits the version stamp when jevitateVersion is absent", () => {
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  expect(block.startsWith(SKILLS_BLOCK_BEGIN)).toBe(true);
});

test("SKILLS_BLOCK_BEGIN_RE matches any version plus trailing attributes", () => {
  expect(SKILLS_BLOCK_BEGIN_RE.test("<!-- BEGIN JEVITATE SKILLS v3 jevitate@0.9.0 extra -->")).toBe(true);
});

test("SKILLS_BLOCK_END_RE matches any version", () => {
  expect(SKILLS_BLOCK_END_RE.test("<!-- END JEVITATE SKILLS v7 -->")).toBe(true);
});

test("findSkillsBlock returns none when no markers are present", () => {
  expect(findSkillsBlock("nothing to see here")).toEqual({ kind: "none" });
});

test("findSkillsBlock spans from the BEGIN line start through the END marker end", () => {
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const content = `PREFIX${block}SUFFIX`;
  expect(findSkillsBlock(content)).toEqual({ kind: "block", start: 6, end: 6 + block.length });
});

test("findSkillsBlock reports a malformed BEGIN without END", () => {
  expect(findSkillsBlock("<!-- BEGIN JEVITATE SKILLS v1 -->")).toMatchObject({ kind: "malformed" });
});

test("findSkillsBlock reports a malformed END without BEGIN", () => {
  expect(findSkillsBlock("<!-- END JEVITATE SKILLS v1 -->")).toMatchObject({ kind: "malformed" });
});

test("findSkillsBlock reports two blocks as malformed", () => {
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  expect(findSkillsBlock(`${block}\n${block}`)).toMatchObject({ kind: "malformed" });
});

test("findSkillsBlock reports an END before its BEGIN as malformed", () => {
  expect(findSkillsBlock(`${SKILLS_BLOCK_END}\n${SKILLS_BLOCK_BEGIN}`)).toMatchObject({ kind: "malformed" });
});

test("findSkillsBlock's malformed reason names the problem and the fix", () => {
  const found = findSkillsBlock("<!-- BEGIN JEVITATE SKILLS v1 -->");
  expect(found.kind === "malformed" ? found.reason : "").toMatch(/no matching END marker.*re-run/);
});

test("mergeBlock replaces an unstamped v1 block with a stamped block in place", () => {
  const oldBlock = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const newBlock = renderSkillsBlock(fakeSkills(), { mode: "inline", jevitateVersion: "1.2.3" });
  const existing = `PRE\n\n${oldBlock}\n\nPOST\n`;
  expect(mergeBlock(existing, newBlock)).toBe(`PRE\n\n${newBlock}\n\nPOST\n`);
});

test("mergeBlock replaces a v2 block in place", () => {
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const v2 = block.replace("JEVITATE SKILLS v1", "JEVITATE SKILLS v2");
  const newBlock = renderSkillsBlock(fakeSkills(), { mode: "inline", jevitateVersion: "9.9.9" });
  const existing = `TOP\n\n${v2}\n\nBOTTOM\n`;
  expect(mergeBlock(existing, newBlock)).toBe(`TOP\n\n${newBlock}\n\nBOTTOM\n`);
});

test("mergeBlock never duplicates markers when replacing an existing block", () => {
  const oldBlock = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const newBlock = renderSkillsBlock(fakeSkills(), { mode: "inline", jevitateVersion: "4.0.0" });
  const merged = mergeBlock(`TOP\n\n${oldBlock}\n\nBOTTOM\n`, newBlock);
  expect(merged.match(/<!-- BEGIN JEVITATE SKILLS/g)?.length).toBe(1);
});

test("mergeBlock throws SkillsBlockMarkerError on malformed content", () => {
  expect(() => mergeBlock("<!-- BEGIN JEVITATE SKILLS v1 -->", "block")).toThrow(SkillsBlockMarkerError);
});

test("extractBlockHash ignores the BEGIN-line version stamp", () => {
  const plain = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  const stamped = renderSkillsBlock(fakeSkills(), { mode: "inline", jevitateVersion: "5.0.0" });
  expect(extractBlockHash(stamped)).toBe(extractBlockHash(plain));
});

test("extractBlockHash throws SkillsBlockMarkerError on malformed content", () => {
  expect(() => extractBlockHash("<!-- END JEVITATE SKILLS v1 -->")).toThrow(SkillsBlockMarkerError);
});

// ---- Part 4b: marked-block planning + CLAUDE.md (#431) ----

test("planBlockInstall reports refuse-malformed (never throws) for a BEGIN without END", async () => {
  const p = tmpFile("<!-- BEGIN JEVITATE SKILLS v1 -->\n");
  const block = renderSkillsBlock(fakeSkills(), { mode: "inline" });
  expect(await planBlockInstall(p, block, undefined)).toBe("refuse-malformed");
});

test("installSkills reports refuse-malformed for a BEGIN without END", async () => {
  const { cwd, statePath, paths } = envDirs();
  writeFileSync(join(cwd, "AGENTS.md"), "<!-- BEGIN JEVITATE SKILLS v1 -->\n", "utf8");
  const report = await installSkills(["generic"], fixtureSkills(), paths, statePath, {});
  const entry = report.find((r) => r.target === "generic" && r.skillId === "*");
  expect(entry!.action).toBe("refuse-malformed");
});

test("installSkills leaves a malformed AGENTS.md byte-identical", async () => {
  const { cwd, statePath, paths } = envDirs();
  const malformed = "<!-- BEGIN JEVITATE SKILLS v1 -->\nmy notes\n";
  writeFileSync(join(cwd, "AGENTS.md"), malformed, "utf8");
  await installSkills(["generic"], fixtureSkills(), paths, statePath, {});
  expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(malformed);
});

test("installSkills reports refuse-malformed for an END without BEGIN", async () => {
  const { cwd, statePath, paths } = envDirs();
  writeFileSync(join(cwd, "AGENTS.md"), "<!-- END JEVITATE SKILLS v1 -->\n", "utf8");
  const report = await installSkills(["generic"], fixtureSkills(), paths, statePath, {});
  const entry = report.find((r) => r.target === "generic" && r.skillId === "*");
  expect(entry!.action).toBe("refuse-malformed");
});

test("installSkills reports refuse-malformed for two blocks", async () => {
  const { cwd, statePath, paths } = envDirs();
  const block = renderSkillsBlock(fixtureSkills(), { mode: "inline" });
  writeFileSync(join(cwd, "AGENTS.md"), `${block}\n${block}`, "utf8");
  const report = await installSkills(["generic"], fixtureSkills(), paths, statePath, {});
  const entry = report.find((r) => r.target === "generic" && r.skillId === "*");
  expect(entry!.action).toBe("refuse-malformed");
});

test("installSkills upgrades in place when only the version stamp changed (update, not skip)", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  await installSkills(["generic"], skills, paths, statePath, { jevitateVersion: "1.0.0" });
  const report = await installSkills(["generic"], skills, paths, statePath, { jevitateVersion: "2.0.0" });
  const entry = report.find((r) => r.target === "generic" && r.skillId === "*");
  expect(entry!.action).toBe("update");
});

test("installSkills with claudeMd false never creates CLAUDE.md", async () => {
  const { statePath, paths } = envDirs();
  await installSkills(["claude-code", "generic"], fixtureSkills(), paths, statePath, {});
  expect(existsSync(paths.claudeMdFile)).toBe(false);
});

test("installSkills with claudeMd true places a marked block in CLAUDE.md", async () => {
  const { statePath, paths } = envDirs();
  await installSkills(["claude-code", "generic"], fixtureSkills(), paths, statePath, { claudeMd: true });
  expect(readFileSync(paths.claudeMdFile, "utf8")).toContain(SKILLS_BLOCK_BEGIN);
});

test("resolveInstallTargetPaths adds the project CLAUDE.md path", () => {
  const p = resolveInstallTargetPaths({ homedir: () => "/home/u", cwd: () => "/proj" });
  expect(p.claudeMdFile).toBe(join("/proj", "CLAUDE.md"));
});

// ---- Part 5: uninstallSkills (#431) ----

test("uninstallSkills after install restores AGENTS.md to the user's original text", async () => {
  const { cwd, statePath, paths } = envDirs();
  const agents = join(cwd, "AGENTS.md");
  const original = "# My AGENTS\n\nMy own notes.\n";
  writeFileSync(agents, original, "utf8");
  await installSkills(["generic"], fixtureSkills(), paths, statePath, {});
  await uninstallSkills(["generic"], fixtureSkills(), paths, statePath, {});
  expect(readFileSync(agents, "utf8")).toBe(original);
});

test("uninstallSkills removes installed Claude skill files", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  await installSkills(["claude-code"], skills, paths, statePath, {});
  await uninstallSkills(["claude-code"], skills, paths, statePath, {});
  expect(existsSync(join(paths.claudeSkillsDir, skills[0].id, "SKILL.md"))).toBe(false);
});

test("uninstallSkills skips a user-modified skill file", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  await installSkills(["claude-code"], skills, paths, statePath, {});
  const edited = join(paths.claudeSkillsDir, skills[0].id, "SKILL.md");
  writeFileSync(edited, "USER EDIT", "utf8");
  const report = await uninstallSkills(["claude-code"], skills, paths, statePath, {});
  const entry = report.find((r) => r.target === "claude-code" && r.skillId === skills[0].id);
  expect(entry!.action).toBe("skip-user-modified");
});

test("uninstallSkills --force removes a user-modified skill file", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  await installSkills(["claude-code"], skills, paths, statePath, {});
  const edited = join(paths.claudeSkillsDir, skills[0].id, "SKILL.md");
  writeFileSync(edited, "USER EDIT", "utf8");
  await uninstallSkills(["claude-code"], skills, paths, statePath, { force: true });
  expect(existsSync(edited)).toBe(false);
});

test("uninstallSkills dryRun leaves installed files in place", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  await installSkills(["claude-code"], skills, paths, statePath, {});
  await uninstallSkills(["claude-code"], skills, paths, statePath, { dryRun: true });
  expect(existsSync(join(paths.claudeSkillsDir, skills[0].id, "SKILL.md"))).toBe(true);
});

test("uninstallSkills reports refuse-malformed for a malformed AGENTS.md", async () => {
  const { cwd, statePath, paths } = envDirs();
  writeFileSync(join(cwd, "AGENTS.md"), "<!-- END JEVITATE SKILLS v1 -->\n", "utf8");
  const report = await uninstallSkills(["generic"], fixtureSkills(), paths, statePath, {});
  const entry = report.find((r) => r.target === "generic" && r.skillId === "*");
  expect(entry!.action).toBe("refuse-malformed");
});

test("uninstallSkills with claudeMd removes the CLAUDE.md block and the file", async () => {
  const { statePath, paths } = envDirs();
  const skills = fixtureSkills();
  await installSkills(["claude-code", "generic"], skills, paths, statePath, { claudeMd: true });
  await uninstallSkills(["claude-code", "generic"], skills, paths, statePath, { claudeMd: true });
  expect(existsSync(paths.claudeMdFile)).toBe(false);
});
