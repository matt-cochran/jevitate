import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir as realHomedir } from "node:os";
import { join, dirname } from "node:path";
import type { RuntimeId, DetectionDeps } from "./init-skills.js";

/**
 * Registers the `jevitate mcp` stdio server into each agent harness's own MCP
 * config, idempotently and NEVER destructively. This mirrors `init-skills.ts`'s
 * safety contract: a user's existing config is never clobbered without
 * `--force`, and when a target's on-disk content conflicts or cannot be parsed
 * we PRINT the snippet + instruction rather than risk corrupting it. All fs
 * seams are injected so the logic is unit-testable without touching the machine.
 *
 * The harness conventions were verified (Sep 2026):
 *   - Claude Code: `claude mcp add jevitate -- jevitate mcp`, or an mcpServers
 *     entry in `~/.claude.json` (user) / a project `.mcp.json`. We write the
 *     project-scoped `.mcp.json` (a dedicated, team-shareable MCP file).
 *   - Cursor: `.cursor/mcp.json` (project) / `~/.cursor/mcp.json` (global),
 *     `{ "mcpServers": { ... } }`.
 *   - Codex: `~/.codex/config.toml`, a `[mcp_servers.jevitate]` TOML table.
 */

/** The MCP server key every harness registers us under. */
export const MCP_SERVER_NAME = "jevitate";

/** The canonical stdio launch config: run the `jevitate mcp` subcommand. */
export interface JevitateServerConfig {
  command: string;
  args: string[];
}

export function jevitateServerConfig(): JevitateServerConfig {
  return { command: "jevitate", args: ["mcp"] };
}

/** The `{ mcpServers: { jevitate: {...} } }` object Claude Code / Cursor use. */
export function mcpServersObject(): { mcpServers: Record<string, JevitateServerConfig> } {
  return { mcpServers: { [MCP_SERVER_NAME]: jevitateServerConfig() } };
}

// ---- print-config (safe: only renders a snippet, never writes) ----

export type McpHarness = "claude" | "cursor" | "codex" | "json";

const JSON_SNIPPET = JSON.stringify(mcpServersObject(), null, 2);

const CODEX_TOML_BLOCK = `[mcp_servers.jevitate]\ncommand = "jevitate"\nargs = ["mcp"]`;

/**
 * Renders the exact registration snippet for one harness — the universal escape
 * hatch behind `jevitate mcp --print-config <harness>`. Prints only; writes
 * nothing. `json` is the bare mcpServers object so it can be piped/round-tripped.
 */
export function renderPrintConfig(harness: McpHarness): string {
  switch (harness) {
    case "json":
      return JSON_SNIPPET;
    case "claude":
      return [
        "# Claude Code — option A: register with one command",
        "claude mcp add jevitate -- jevitate mcp",
        "",
        "# Claude Code — option B: add this to ~/.claude.json (user scope)",
        "#                        or a project .mcp.json (project scope):",
        JSON_SNIPPET,
      ].join("\n");
    case "cursor":
      return [
        "# Cursor — add this to .cursor/mcp.json (project) or ~/.cursor/mcp.json (global):",
        JSON_SNIPPET,
      ].join("\n");
    case "codex":
      return ["# Codex — add this to ~/.codex/config.toml:", CODEX_TOML_BLOCK].join("\n");
    default:
      throw new Error(`unknown MCP harness '${harness}' (expected claude | cursor | codex | json)`);
  }
}

// ---- target paths ----

export interface McpTargetPaths {
  claudeMcpJson: string;
  cursorMcpJson: string;
  codexConfigToml: string;
}

export function resolveMcpTargetPaths(deps: DetectionDeps = {}): McpTargetPaths {
  const homedir = deps.homedir ?? realHomedir;
  const cwd = deps.cwd ?? process.cwd;
  return {
    claudeMcpJson: join(cwd(), ".mcp.json"),
    cursorMcpJson: join(cwd(), ".cursor", "mcp.json"),
    codexConfigToml: join(homedir(), ".codex", "config.toml"),
  };
}

// ---- pure merge planners (no fs) ----

export type McpInstallAction =
  | "create"
  | "update"
  | "unchanged"
  | "skip-conflict"
  | "force-update"
  | "skip-unparsable";

export interface MergeResult {
  action: McpInstallAction;
  /** The bytes to write, present ONLY for create/update/force-update. */
  content?: string;
}

function isEquivalentServer(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  if (keys.length !== 2 || keys[0] !== "args" || keys[1] !== "command") return false;
  if (rec.command !== "jevitate") return false;
  return Array.isArray(rec.args) && rec.args.length === 1 && rec.args[0] === "mcp";
}

/**
 * Plans a merge into an `mcpServers` JSON config (Claude Code / Cursor). Other
 * servers and unrelated top-level keys are preserved. A pre-existing, DIFFERENT
 * `jevitate` entry is never overwritten without `force`; an unparseable file is
 * never rewritten at all — both fall back to "print the snippet."
 */
export function mergeMcpJson(existingRaw: string | undefined, opts: { force?: boolean }): MergeResult {
  if (existingRaw === undefined || existingRaw.trim() === "") {
    return { action: "create", content: `${JSON.stringify(mcpServersObject(), null, 2)}\n` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingRaw);
  } catch {
    return { action: "skip-unparsable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { action: "skip-unparsable" };
  }
  const root = parsed as Record<string, unknown>;
  const servers =
    typeof root.mcpServers === "object" && root.mcpServers !== null && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  const existingEntry = servers[MCP_SERVER_NAME];

  if (existingEntry !== undefined) {
    if (isEquivalentServer(existingEntry)) return { action: "unchanged" };
    if (!opts.force) return { action: "skip-conflict" };
    const next = { ...root, mcpServers: { ...servers, [MCP_SERVER_NAME]: jevitateServerConfig() } };
    return { action: "force-update", content: `${JSON.stringify(next, null, 2)}\n` };
  }

  const next = { ...root, mcpServers: { ...servers, [MCP_SERVER_NAME]: jevitateServerConfig() } };
  return { action: "update", content: `${JSON.stringify(next, null, 2)}\n` };
}

const CODEX_HEADER_RE = /^[ \t]*\[mcp_servers\.jevitate\][ \t]*$/m;

/** Slices out the `[mcp_servers.jevitate]` table (header through the line before
 *  the next top-level `[...]` header, or EOF). Returns null when absent. */
function codexTableRegion(raw: string): { start: number; end: number; body: string } | null {
  const headerMatch = CODEX_HEADER_RE.exec(raw);
  if (!headerMatch) return null;
  const start = headerMatch.index;
  const afterHeader = start + headerMatch[0].length;
  const nextHeader = /^[ \t]*\[/m.exec(raw.slice(afterHeader));
  const end = nextHeader ? afterHeader + nextHeader.index : raw.length;
  return { start, end, body: raw.slice(afterHeader, end) };
}

function codexBodyIsOurs(body: string): boolean {
  const command = /^[ \t]*command[ \t]*=[ \t]*"jevitate"[ \t]*$/m.test(body);
  const args = /^[ \t]*args[ \t]*=[ \t]*\[[ \t]*"mcp"[ \t]*\][ \t]*$/m.test(body);
  return command && args;
}

/**
 * Plans a merge into Codex's `~/.codex/config.toml`. When our table is absent we
 * append it (prior bytes preserved). A pre-existing, DIFFERENT `jevitate` table
 * is surfaced for printing unless `force`, in which case ONLY that one table is
 * replaced in place — neighbouring tables/keys are left intact.
 */
export function mergeCodexToml(existingRaw: string | undefined, opts: { force?: boolean }): MergeResult {
  if (existingRaw === undefined || existingRaw.trim() === "") {
    return { action: "create", content: `${CODEX_TOML_BLOCK}\n` };
  }
  const region = codexTableRegion(existingRaw);
  if (region) {
    if (codexBodyIsOurs(region.body)) return { action: "unchanged" };
    if (!opts.force) return { action: "skip-conflict" };
    const before = existingRaw.slice(0, region.start);
    const after = existingRaw.slice(region.end);
    const replaced = `${before}${CODEX_TOML_BLOCK}\n${after.startsWith("\n") ? after.slice(1) : after}`;
    return { action: "force-update", content: replaced };
  }
  const sep = existingRaw.endsWith("\n\n") ? "" : existingRaw.endsWith("\n") ? "\n" : "\n\n";
  return { action: "update", content: `${existingRaw}${sep}${CODEX_TOML_BLOCK}\n` };
}

// ---- orchestrator ----

/** MCP registration applies only to harnesses with a real MCP-config convention. */
type McpRuntime = "claude-code" | "cursor" | "codex";

export interface McpInstallReport {
  target: McpRuntime;
  path: string;
  action: McpInstallAction;
  /** For skip-conflict / skip-unparsable: the snippet + guidance to show the
   *  user, so a refusal is honest and actionable (never a silent no-op). */
  instruction?: string;
}

interface McpUnit {
  target: McpRuntime;
  path: string;
  harness: McpHarness;
  plan: (existing: string | undefined, opts: { force?: boolean }) => MergeResult;
}

/**
 * Registers the MCP server into every applicable runtime in `runtimes`
 * (claude-code, cursor, codex). `generic` has no MCP-config convention and is
 * ignored. Idempotent; never overwrites a user's conflicting/unparseable config
 * without `--force`, attaching a printable instruction when it declines.
 */
export async function registerMcp(
  runtimes: RuntimeId[],
  paths: McpTargetPaths,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<McpInstallReport[]> {
  const runtimeSet = new Set(runtimes);
  const units: McpUnit[] = [];
  if (runtimeSet.has("claude-code")) {
    units.push({ target: "claude-code", path: paths.claudeMcpJson, harness: "claude", plan: mergeMcpJson });
  }
  if (runtimeSet.has("cursor")) {
    units.push({ target: "cursor", path: paths.cursorMcpJson, harness: "cursor", plan: mergeMcpJson });
  }
  if (runtimeSet.has("codex")) {
    units.push({ target: "codex", path: paths.codexConfigToml, harness: "codex", plan: mergeCodexToml });
  }

  const report: McpInstallReport[] = [];
  for (const unit of units) {
    let existing: string | undefined;
    try {
      existing = await readFile(unit.path, "utf8");
    } catch {
      existing = undefined;
    }
    const result = unit.plan(existing, { force: opts.force });

    const entry: McpInstallReport = { target: unit.target, path: unit.path, action: result.action };
    if (result.action === "skip-conflict" || result.action === "skip-unparsable") {
      entry.instruction = renderPrintConfig(unit.harness);
    }
    if (!opts.dryRun && result.content !== undefined) {
      await mkdir(dirname(unit.path), { recursive: true });
      await writeFile(unit.path, result.content, "utf8");
    }
    report.push(entry);
  }
  return report;
}
