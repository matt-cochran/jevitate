import { existsSync as realExistsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm, rmdir } from "node:fs/promises";
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
  claudeMdFile: string;
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
    claudeMdFile: join(cwd(), "CLAUDE.md"),
  };
}

// ---- whole-file install planning (shared idempotency/conflict decision) ----

export type InstallAction =
  | "create"
  | "update"
  | "unchanged"
  | "skip-user-modified"
  | "force-update"
  | "refuse-malformed";

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
/** Matches a BEGIN marker of ANY version, plus any trailing attributes (#431). */
export const SKILLS_BLOCK_BEGIN_RE = /<!-- BEGIN JEVITATE SKILLS v\d+[^>]*-->/;
/** Matches an END marker of ANY version (#431). */
export const SKILLS_BLOCK_END_RE = /<!-- END JEVITATE SKILLS v\d+ -->/;

/** Raised when a file's marker pair is malformed (missing, duplicated, or misordered). */
export class SkillsBlockMarkerError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "SkillsBlockMarkerError";
    this.reason = reason;
  }
}

export type SkillsBlockLocation =
  | { kind: "none" }
  | { kind: "block"; start: number; end: number }
  | { kind: "malformed"; reason: string };

/** Byte offsets of a well-formed marker pair (BEGIN start → END end). */
interface BlockSpan {
  beginStart: number;
  beginEnd: number;
  endStart: number;
  endEnd: number;
}

function findAllMarkers(re: RegExp, content: string): RegExpMatchArray[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return [...content.matchAll(new RegExp(re.source, flags))];
}

/** #437: a marked block's BEGIN/END markers (any version) and its name in fix-it messages. */
export interface BlockMarkers {
  readonly begin: RegExp;
  readonly end: RegExp;
  /** e.g. `JEVITATE SKILLS`. */
  readonly label: string;
}

const SKILLS_MARKERS: BlockMarkers = { begin: SKILLS_BLOCK_BEGIN_RE, end: SKILLS_BLOCK_END_RE, label: "JEVITATE SKILLS" };

function locateBlock(
  content: string,
  markers: BlockMarkers = SKILLS_MARKERS,
): { kind: "block"; span: BlockSpan } | { kind: "none" } | { kind: "malformed"; reason: string } {
  const begins = findAllMarkers(markers.begin, content);
  const ends = findAllMarkers(markers.end, content);
  const L = markers.label;
  if (begins.length === 0 && ends.length === 0) return { kind: "none" };
  if (begins.length > 1) {
    return {
      kind: "malformed",
      reason:
        `found more than one BEGIN ${L} marker — keep a single marked block (delete the extra BEGIN lines), then re-run`,
    };
  }
  if (ends.length > 1) {
    return {
      kind: "malformed",
      reason:
        `found more than one END ${L} marker — keep a single marked block (delete the extra END lines), then re-run`,
    };
  }
  if (begins.length === 1 && ends.length === 0) {
    return {
      kind: "malformed",
      reason:
        `the BEGIN ${L} marker has no matching END marker — restore the END line or delete the partial block, then re-run`,
    };
  }
  if (begins.length === 0) {
    return {
      kind: "malformed",
      reason:
        `the END ${L} marker has no matching BEGIN marker — restore the BEGIN line or delete the stray END, then re-run`,
    };
  }
  const begin = begins[0];
  const end = ends[0];
  const beginIndex = begin.index ?? 0;
  const endIndex = end.index ?? 0;
  if (endIndex < beginIndex) {
    return {
      kind: "malformed",
      reason:
        `the END ${L} marker appears before the BEGIN marker — reorder the markers or delete the block, then re-run`,
    };
  }
  return {
    kind: "block",
    span: {
      beginStart: beginIndex,
      beginEnd: beginIndex + begin[0].length,
      endStart: endIndex,
      endEnd: endIndex + end[0].length,
    },
  };
}

/**
 * Locates the Jevitate skills block in `content`, version-agnostically (#431).
 * `none` when no marker is present; `malformed` (with a fix-it reason) when the
 * markers are missing, duplicated, or misordered; otherwise `block` with the
 * BEGIN-line-start..END-marker-end span.
 */
export function findSkillsBlock(content: string): SkillsBlockLocation {
  const found = locateBlock(content);
  if (found.kind === "block") {
    return { kind: "block", start: found.span.beginStart, end: found.span.endEnd };
  }
  return found;
}

type BlockSkill = Pick<ResolvedSkill, "id" | "name" | "description" | "body">;

export interface RenderBlockOptions {
  mode: "inline" | "reference";
  /** Required for reference mode: where the Claude-Code copies live. */
  claudeSkillsDir?: string;
  /** When set, the BEGIN marker carries a `jevitate@<version>` stamp (#431). */
  jevitateVersion?: string;
}

/**
 * Renders the marked block that Codex/generic `AGENTS.md` carry. In `inline`
 * mode each skill's full body is embedded (used when no other on-disk copy
 * exists, avoiding a dangling pointer); in `reference` mode it points at the
 * installed Claude-Code path instead.
 */
export function renderSkillsBlock(skills: BlockSkill[], opts: RenderBlockOptions): string {
  const begin = opts.jevitateVersion
    ? `<!-- BEGIN JEVITATE SKILLS v1 jevitate@${opts.jevitateVersion} -->`
    : SKILLS_BLOCK_BEGIN;
  const parts: string[] = [begin, "", "# Jevitate skills", ""];
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
 * Splices `newBlock` (marker-wrapped) into `existing`. Any existing block (of
 * ANY version) is replaced in place; everything before the opening marker and
 * after the closing marker is preserved byte-for-byte. Otherwise the block is
 * appended after a blank-line separator. Idempotent on repeat with the same
 * block. Throws `SkillsBlockMarkerError` when the target's markers are
 * malformed (#431).
 */
export function mergeBlock(existing: string, newBlock: string): string {
  return mergeMarkedBlock(existing, newBlock, SKILLS_MARKERS);
}

/**
 * #437: `mergeBlock` for any marked block (`BlockMarkers`) — e.g. the CODEOWNERS block of
 * `jevitate init --codeowners`. Same rules: replaced in place, else appended; idempotent; throws
 * `SkillsBlockMarkerError` on malformed markers.
 */
export function mergeMarkedBlock(existing: string, newBlock: string, markers: BlockMarkers): string {
  const found = locateBlock(existing, markers);
  if (found.kind === "malformed") throw new SkillsBlockMarkerError(found.reason);
  if (found.kind === "block") {
    return existing.slice(0, found.span.beginStart) + newBlock + existing.slice(found.span.endEnd);
  }
  if (existing === "") return newBlock;
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + newBlock;
}

/** sha256 of just the block's inner text (between the marker lines) — so the
 *  `jevitate@<version>` stamp in the BEGIN line never counts as a user
 *  modification, while edits INSIDE the block do. `undefined` when no block is
 *  present; throws `SkillsBlockMarkerError` when the markers are malformed. */
export function extractBlockHash(content: string): string | undefined {
  const found = locateBlock(content);
  if (found.kind === "none") return undefined;
  if (found.kind === "malformed") throw new SkillsBlockMarkerError(found.reason);
  return sha256(content.slice(found.span.beginEnd, found.span.endStart));
}

interface BlockPlan {
  action: InstallAction;
  reason?: string;
}

async function planBlockInstallDetailed(
  targetPath: string,
  newBlock: string,
  lastInstalledHash: string | undefined,
  opts: { force?: boolean } = {},
): Promise<BlockPlan> {
  let current: string;
  try {
    current = await readFile(targetPath, "utf8");
  } catch {
    return { action: "create" };
  }
  const found = locateBlock(current);
  if (found.kind === "malformed") return { action: "refuse-malformed", reason: found.reason };
  if (found.kind === "none") return { action: "create" }; // file exists but has no block yet — append one
  const currentBlockHash = sha256(current.slice(found.span.beginEnd, found.span.endStart));
  const userModified = lastInstalledHash === undefined || currentBlockHash !== lastInstalledHash;
  if (userModified && !opts.force) return { action: "skip-user-modified" };
  if (userModified && opts.force) return { action: "force-update" };
  const existingBlock = current.slice(found.span.beginStart, found.span.endEnd);
  return { action: existingBlock === newBlock ? "unchanged" : "update" };
}

/**
 * Decides what to do with one marked-block target. Never writes and never
 * throws: a malformed marker pair is reported as `refuse-malformed` so the
 * skill installer leaves that file untouched and proceeds with the others (#431).
 */
export async function planBlockInstall(
  targetPath: string,
  newBlock: string,
  lastInstalledHash: string | undefined,
  opts: { force?: boolean } = {},
): Promise<InstallAction> {
  return (await planBlockInstallDetailed(targetPath, newBlock, lastInstalledHash, opts)).action;
}

async function applyBlockInstall(targetPath: string, newBlock: string, action: InstallAction): Promise<void> {
  if (action === "unchanged" || action === "skip-user-modified" || action === "refuse-malformed") return;
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
  /** Populated for `refuse-malformed`: the human fix-it reason (#431). */
  reason?: string;
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
  opts: { force?: boolean; dryRun?: boolean; jevitateVersion?: string; claudeMd?: boolean } = {},
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

  const block = renderSkillsBlock(skills, {
    mode: blockMode,
    claudeSkillsDir: paths.claudeSkillsDir,
    jevitateVersion: opts.jevitateVersion,
  });
  if (runtimeSet.has("codex")) blockUnits.push({ target: "codex", path: paths.codexAgentsFile, block });
  if (runtimeSet.has("generic")) blockUnits.push({ target: "generic", path: paths.genericAgentsFile, block });
  // #431: opt-in CLAUDE.md block, only when Claude Code is actually a target.
  if (opts.claudeMd && runtimeSet.has("claude-code")) {
    blockUnits.push({ target: "claude-code", path: paths.claudeMdFile, block });
  }

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
    const plan = await planBlockInstallDetailed(unit.path, unit.block, state[unit.path], { force: opts.force });
    if (!opts.dryRun) {
      await applyBlockInstall(unit.path, unit.block, plan.action);
      if (plan.action !== "skip-user-modified" && plan.action !== "refuse-malformed") {
        const written = await readFile(unit.path, "utf8").catch(() => "");
        const hash = extractBlockHash(written);
        if (hash !== undefined) state[unit.path] = hash;
      }
    }
    report.push({
      target: unit.target,
      skillId: "*",
      path: unit.path,
      action: plan.action,
      ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
    });
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

// ---- uninstall (inverse of installSkills, same units + state) ----

export interface UninstallReport {
  target: RuntimeId;
  skillId: string;
  path: string;
  action: "remove" | "absent" | "skip-user-modified" | "force-remove" | "refuse-malformed";
  /** Populated for `refuse-malformed`: the human fix-it reason (#431). */
  reason?: string;
}

/** One whole-file unit to remove (mirrors installSkills' FileUnit). */
interface FileRemovalUnit {
  target: RuntimeId;
  skillId: string;
  path: string;
  /** The directory installSkills created for the target, removable when empty. */
  rootDir: string;
}

/** One marked-block unit to remove (mirrors installSkills' BlockUnit). */
interface BlockRemovalUnit {
  target: RuntimeId;
  path: string;
}

/** Removes a well-formed block plus ONE adjacent blank-line separator that
 *  mergeBlock appended, leaving every other byte in place (#431). */
function removeSkillsBlock(content: string): string {
  const found = locateBlock(content);
  if (found.kind !== "block") return content;
  let before = content.slice(0, found.span.beginStart);
  const after = content.slice(found.span.endEnd);
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  return before + after;
}

/**
 * Removes everything `installSkills` wrote, with the same never-clobber safety:
 * a whole file or block whose current hash differs from the recorded state is
 * reported `skip-user-modified` (or `force-remove` with `force`) rather than
 * deleted. Malformed markers are reported `refuse-malformed` and left alone.
 * `dryRun` reports the plan and writes nothing. Corresponding state entries are
 * dropped for removed/absent targets.
 */
export async function uninstallSkills(
  runtimes: RuntimeId[],
  skills: ResolvedSkill[],
  paths: InstallTargetPaths,
  statePath: string,
  opts: { force?: boolean; dryRun?: boolean; claudeMd?: boolean } = {},
): Promise<UninstallReport[]> {
  const { state, raw: originalStateRaw } = await loadState(statePath);
  const runtimeSet = new Set(runtimes);

  const fileUnits: FileRemovalUnit[] = [];
  const blockUnits: BlockRemovalUnit[] = [];

  for (const skill of skills) {
    if (runtimeSet.has("claude-code")) {
      fileUnits.push({
        target: "claude-code",
        skillId: skill.id,
        path: join(paths.claudeSkillsDir, skill.id, "SKILL.md"),
        rootDir: paths.claudeSkillsDir,
      });
    }
    if (runtimeSet.has("cursor")) {
      fileUnits.push({
        target: "cursor",
        skillId: skill.id,
        path: join(paths.cursorRulesDir, `jevitate-${skill.id}.mdc`),
        rootDir: paths.cursorRulesDir,
      });
    }
    if (runtimeSet.has("generic")) {
      fileUnits.push({
        target: "generic",
        skillId: skill.id,
        path: join(paths.genericSkillsDir, skill.id, "SKILL.md"),
        rootDir: paths.genericSkillsDir,
      });
    }
  }

  if (runtimeSet.has("codex")) blockUnits.push({ target: "codex", path: paths.codexAgentsFile });
  if (runtimeSet.has("generic")) blockUnits.push({ target: "generic", path: paths.genericAgentsFile });
  if (opts.claudeMd && runtimeSet.has("claude-code")) {
    blockUnits.push({ target: "claude-code", path: paths.claudeMdFile });
  }

  const report: UninstallReport[] = [];

  for (const unit of fileUnits) {
    let current: string | undefined;
    try {
      current = await readFile(unit.path, "utf8");
    } catch {
      current = undefined;
    }
    let action: UninstallReport["action"];
    if (current === undefined) {
      action = "absent";
    } else {
      const recorded = state[unit.path];
      const userModified = recorded === undefined || sha256(current) !== recorded;
      action = userModified ? (opts.force ? "force-remove" : "skip-user-modified") : "remove";
    }
    if (!opts.dryRun) {
      if (action === "remove" || action === "force-remove") {
        await rm(unit.path, { force: true });
        await rmdir(dirname(unit.path)).catch(() => {}); // drop the now-empty <skill> dir
        if (dirname(unit.path) !== unit.rootDir) await rmdir(unit.rootDir).catch(() => {});
        delete state[unit.path];
      } else if (action === "absent") {
        delete state[unit.path];
      }
    }
    report.push({ target: unit.target, skillId: unit.skillId, path: unit.path, action });
  }

  for (const unit of blockUnits) {
    let current: string | undefined;
    try {
      current = await readFile(unit.path, "utf8");
    } catch {
      current = undefined;
    }
    let action: UninstallReport["action"];
    let reason: string | undefined;
    if (current === undefined) {
      action = "absent";
    } else {
      const found = locateBlock(current);
      if (found.kind === "none") {
        action = "absent";
      } else if (found.kind === "malformed") {
        action = "refuse-malformed";
        reason = found.reason;
      } else {
        const innerHash = sha256(current.slice(found.span.beginEnd, found.span.endStart));
        const recorded = state[unit.path];
        const userModified = recorded === undefined || innerHash !== recorded;
        action = userModified ? (opts.force ? "force-remove" : "skip-user-modified") : "remove";
      }
    }
    if (!opts.dryRun && current !== undefined) {
      if (action === "remove" || action === "force-remove") {
        const updated = removeSkillsBlock(current);
        if (updated.trim() === "") await rm(unit.path, { force: true });
        else await writeFile(unit.path, updated, "utf8");
        delete state[unit.path];
      } else if (action === "absent") {
        delete state[unit.path];
      }
    }
    report.push({
      target: unit.target,
      skillId: "*",
      path: unit.path,
      action,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  if (!opts.dryRun) {
    const nextStateRaw = JSON.stringify(state, null, 2);
    if (nextStateRaw !== originalStateRaw) {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, nextStateRaw, "utf8");
    }
  }

  return report;
}
