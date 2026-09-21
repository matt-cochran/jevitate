import { existsSync as realExistsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir as realHomedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ResolvedSkill } from "@jevitate/skills";

export type RuntimeId = "claude-code" | "codex" | "cursor" | "generic";

export interface DetectionDeps {
  existsSync?: (path: string) => boolean;
  homedir?: () => string;
  cwd?: () => string;
}

/**
 * Detects which agent runtimes to install into. Claude Code and Codex are
 * user-global (`~/.claude`, `~/.codex`); Cursor is project-local (`<cwd>/.cursor`);
 * `generic` is always appended (the tool-agnostic fallback). Never returns an
 * empty array (Guardrail 4). Detection is fail-closed toward "don't install
 * where not detected" for the three gated targets — a caller opts a target in
 * explicitly via `--targets` when it isn't auto-detected.
 */
export function detectRuntimes(deps: DetectionDeps = {}): RuntimeId[] {
  const existsSync = deps.existsSync ?? realExistsSync;
  const homedir = deps.homedir ?? realHomedir;
  const cwd = deps.cwd ?? process.cwd;
  const detected: RuntimeId[] = [];
  if (existsSync(join(homedir(), ".claude"))) detected.push("claude-code");
  if (existsSync(join(homedir(), ".codex"))) detected.push("codex");
  if (existsSync(join(cwd(), ".cursor"))) detected.push("cursor");
  detected.push("generic"); // always-on fallback target — see Decision 3 / Guardrail 4
  return detected;
}

export interface InstallTargetPaths {
  claudeSkillsDir: string;
  codexAgentsFile: string;
  cursorRulesDir: string;
  genericAgentsFile: string;
  genericSkillsDir: string;
}

export function resolveInstallTargetPaths(deps: DetectionDeps = {}): InstallTargetPaths {
  const homedir = deps.homedir ?? realHomedir;
  const cwd = deps.cwd ?? process.cwd;
  return {
    claudeSkillsDir: join(homedir(), ".claude", "skills"),
    codexAgentsFile: join(homedir(), ".codex", "AGENTS.md"),
    cursorRulesDir: join(cwd(), ".cursor", "rules"),
    genericAgentsFile: join(cwd(), "AGENTS.md"),
    genericSkillsDir: join(cwd(), ".agent", "skills"),
  };
}

// ---- whole-file install planning (shared idempotency/conflict decision) ----

export type InstallAction = "create" | "update" | "unchanged" | "skip-user-modified" | "force-update";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Decides what to do with one whole-file target. Never writes. A target whose
 * current on-disk hash does not match the hash `init` last recorded (or was
 * never recorded) is treated as user-modified and SKIPPED — a reported,
 * non-error branch, never a silent no-op — unless `force` is set.
 */
export async function planFileInstall(
  targetPath: string,
  newContent: string,
  lastInstalledHash: string | undefined,
  opts: { force?: boolean } = {},
): Promise<InstallAction> {
  let current: string | undefined;
  try {
    current = await readFile(targetPath, "utf8");
  } catch {
    return "create"; // absent (or unreadable) — fail toward creating fresh; a write error surfaces at apply time
  }
  const currentHash = sha256(current);
  const userModified = lastInstalledHash === undefined || currentHash !== lastInstalledHash;
  if (userModified && !opts.force) return "skip-user-modified";
  if (userModified && opts.force) return "force-update";
  return currentHash === sha256(newContent) ? "unchanged" : "update";
}

export async function applyFileInstall(targetPath: string, content: string, action: InstallAction): Promise<void> {
  if (action === "unchanged" || action === "skip-user-modified") return;
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

// ---- marked-block targets (Codex + generic AGENTS.md) ----

export const SKILLS_BLOCK_BEGIN = "<!-- BEGIN JEVITATE SKILLS v1 -->";
export const SKILLS_BLOCK_END = "<!-- END JEVITATE SKILLS v1 -->";

type BlockSkill = Pick<ResolvedSkill, "id" | "name" | "description" | "body">;

export interface RenderBlockOptions {
  mode: "inline" | "reference";
  /** Required for reference mode: where the Claude-Code copies live. */
  claudeSkillsDir?: string;
}

/**
 * Renders the marked block that Codex/generic `AGENTS.md` carry. In `inline`
 * mode each skill's full body is embedded (used when no other on-disk copy
 * exists, avoiding a dangling pointer); in `reference` mode it points at the
 * installed Claude-Code path instead.
 */
export function renderSkillsBlock(skills: BlockSkill[], opts: RenderBlockOptions): string {
  const parts: string[] = [SKILLS_BLOCK_BEGIN, "", "# Jevitate skills", ""];
  for (const s of skills) {
    parts.push(`## ${s.name}`, "", s.description, "");
    if (opts.mode === "reference" && opts.claudeSkillsDir) {
      parts.push(`See ${join(opts.claudeSkillsDir, s.id, "SKILL.md")}`, "");
    } else {
      parts.push(s.body.trimEnd(), "");
    }
  }
  parts.push(SKILLS_BLOCK_END);
  return parts.join("\n");
}

/**
 * Splices `newBlock` (marker-wrapped) into `existing`. If markers are present,
 * only the marked region is replaced; everything before the opening marker and
 * after the closing marker is preserved byte-for-byte. Otherwise the block is
 * appended after a blank-line separator. Idempotent on repeat with the same block.
 */
export function mergeBlock(existing: string, newBlock: string): string {
  const start = existing.indexOf(SKILLS_BLOCK_BEGIN);
  const endMarker = existing.indexOf(SKILLS_BLOCK_END, start === -1 ? 0 : start);
  if (start !== -1 && endMarker !== -1) {
    const before = existing.slice(0, start);
    const after = existing.slice(endMarker + SKILLS_BLOCK_END.length);
    return before + newBlock + after;
  }
  if (existing === "") return newBlock;
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + newBlock;
}

/** sha256 of just the block's inner text (between the markers), or undefined
 *  when no block is present — so user edits OUTSIDE the block never register as
 *  a modification and edits INSIDE it do. */
export function extractBlockHash(content: string): string | undefined {
  const start = content.indexOf(SKILLS_BLOCK_BEGIN);
  if (start === -1) return undefined;
  const endMarker = content.indexOf(SKILLS_BLOCK_END, start);
  if (endMarker === -1) return undefined;
  const inner = content.slice(start + SKILLS_BLOCK_BEGIN.length, endMarker);
  return sha256(inner);
}

async function planBlockInstall(
  targetPath: string,
  newBlock: string,
  lastInstalledHash: string | undefined,
  opts: { force?: boolean } = {},
): Promise<InstallAction> {
  let current: string;
  try {
    current = await readFile(targetPath, "utf8");
  } catch {
    return "create";
  }
  const currentBlockHash = extractBlockHash(current);
  if (currentBlockHash === undefined) return "create"; // file exists but has no block yet — append one
  const userModified = lastInstalledHash === undefined || currentBlockHash !== lastInstalledHash;
  if (userModified && !opts.force) return "skip-user-modified";
  if (userModified && opts.force) return "force-update";
  const newInnerHash = extractBlockHash(newBlock);
  return currentBlockHash === newInnerHash ? "unchanged" : "update";
}

async function applyBlockInstall(targetPath: string, newBlock: string, action: InstallAction): Promise<void> {
  if (action === "unchanged" || action === "skip-user-modified") return;
  let existing = "";
  try {
    existing = await readFile(targetPath, "utf8");
  } catch {
    existing = "";
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, mergeBlock(existing, newBlock), "utf8");
}

// ---- Cursor .mdc rendering (project-scoped rule) ----

/**
 * Renders a Cursor rule (`.mdc`): Cursor's own frontmatter (`description`,
 * `globs`, `alwaysApply`) followed by the skill body. NOTE: Cursor's `.mdc`
 * convention was inferred; the install mechanics (idempotent per-file write)
 * do not depend on the exact frontmatter shape.
 */
function renderCursorRule(skill: BlockSkill): string {
  return `---\ndescription: ${skill.description}\nglobs:\nalwaysApply: false\n---\n\n${skill.body}`;
}

// ---- orchestrator ----

export interface InstallReport {
  target: RuntimeId;
  skillId: string;
  path: string;
  action: InstallAction;
}

type StateMap = Record<string, string>;

async function loadState(statePath: string): Promise<{ state: StateMap; raw: string | undefined }> {
  try {
    const raw = await readFile(statePath, "utf8");
    return { state: JSON.parse(raw) as StateMap, raw };
  } catch {
    return { state: {}, raw: undefined }; // no existing file yet — start fresh (matches realSecureIO().persist's pattern)
  }
}

/** One whole-file unit of work (Claude Code, Cursor, generic .agent/skills). */
interface FileUnit {
  target: RuntimeId;
  skillId: string;
  path: string;
  content: string;
}

/** One marked-block unit of work (Codex, generic AGENTS.md). `skillId` is `"*"`
 *  because a single block covers the whole skill set. */
interface BlockUnit {
  target: RuntimeId;
  path: string;
  block: string;
}

/**
 * Detect/plan/install the six skills into every runtime passed in (the caller
 * decides the runtime set: `detectRuntimes()` ∪ nothing, or a `--targets`
 * override). Idempotent via a small state file keyed by target path. Never
 * overwrites a user-modified file/block without `force`; every skip is reported.
 * State is keyed by absolute path (a superset of the plan's `<target>:<skillId>`
 * key that also disambiguates the generic target's two write locations).
 */
export async function installSkills(
  runtimes: RuntimeId[],
  skills: ResolvedSkill[],
  paths: InstallTargetPaths,
  statePath: string,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<InstallReport[]> {
  const { state, raw: originalStateRaw } = await loadState(statePath);
  const runtimeSet = new Set(runtimes);
  const blockMode: "inline" | "reference" = runtimeSet.has("claude-code") ? "reference" : "inline";

  const fileUnits: FileUnit[] = [];
  const blockUnits: BlockUnit[] = [];

  for (const skill of skills) {
    const source = await readFile(skill.filePath, "utf8");
    if (runtimeSet.has("claude-code")) {
      fileUnits.push({
        target: "claude-code",
        skillId: skill.id,
        path: join(paths.claudeSkillsDir, skill.id, "SKILL.md"),
        content: source,
      });
    }
    if (runtimeSet.has("cursor")) {
      fileUnits.push({
        target: "cursor",
        skillId: skill.id,
        path: join(paths.cursorRulesDir, `jevitate-${skill.id}.mdc`),
        content: renderCursorRule(skill),
      });
    }
    if (runtimeSet.has("generic")) {
      fileUnits.push({
        target: "generic",
        skillId: skill.id,
        path: join(paths.genericSkillsDir, skill.id, "SKILL.md"),
        content: source,
      });
    }
  }

  const block = renderSkillsBlock(skills, { mode: blockMode, claudeSkillsDir: paths.claudeSkillsDir });
  if (runtimeSet.has("codex")) blockUnits.push({ target: "codex", path: paths.codexAgentsFile, block });
  if (runtimeSet.has("generic")) blockUnits.push({ target: "generic", path: paths.genericAgentsFile, block });

  const report: InstallReport[] = [];

  for (const unit of fileUnits) {
    const action = await planFileInstall(unit.path, unit.content, state[unit.path], { force: opts.force });
    if (!opts.dryRun) {
      await applyFileInstall(unit.path, unit.content, action);
      if (action !== "skip-user-modified") state[unit.path] = sha256(unit.content);
    }
    report.push({ target: unit.target, skillId: unit.skillId, path: unit.path, action });
  }

  for (const unit of blockUnits) {
    const action = await planBlockInstall(unit.path, unit.block, state[unit.path], { force: opts.force });
    if (!opts.dryRun) {
      await applyBlockInstall(unit.path, unit.block, action);
      if (action !== "skip-user-modified") {
        const written = await readFile(unit.path, "utf8").catch(() => "");
        const hash = extractBlockHash(written);
        if (hash !== undefined) state[unit.path] = hash;
      }
    }
    report.push({ target: unit.target, skillId: "*", path: unit.path, action });
  }

  // Only touch the state file when it actually changed, so a clean re-run
  // (everything "unchanged") performs zero writes.
  if (!opts.dryRun) {
    const nextStateRaw = JSON.stringify(state, null, 2);
    if (nextStateRaw !== originalStateRaw) {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, nextStateRaw, "utf8");
    }
  }

  return report;
}
