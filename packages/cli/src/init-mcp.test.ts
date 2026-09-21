import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_SERVER_NAME,
  jevitateServerConfig,
  mcpServersObject,
  renderPrintConfig,
  resolveMcpTargetPaths,
  mergeMcpJson,
  mergeCodexToml,
  registerMcp,
  type McpHarness,
} from "./init-mcp.js";

// ---- Part 1: canonical config value ----

test("jevitateServerConfig is the stdio { command, args } pair that launches `jevitate mcp`", () => {
  expect(jevitateServerConfig()).toEqual({ command: "jevitate", args: ["mcp"] });
});

test("mcpServersObject nests the server under mcpServers/jevitate", () => {
  expect(mcpServersObject()).toEqual({
    mcpServers: { [MCP_SERVER_NAME]: { command: "jevitate", args: ["mcp"] } },
  });
});

// ---- Part 2: print-config (no writes) ----

test("renderPrintConfig json emits ONLY the bare mcpServers JSON that round-trips", () => {
  const out = renderPrintConfig("json");
  expect(JSON.parse(out)).toEqual(mcpServersObject());
});

test("renderPrintConfig claude prints BOTH the claude mcp add line and the mcpServers JSON", () => {
  const out = renderPrintConfig("claude");
  expect(out).toContain("claude mcp add jevitate -- jevitate mcp");
  expect(out).toContain('"mcpServers"');
  expect(out).toContain("jevitate");
  // references the real Claude Code config locations
  expect(out.toLowerCase()).toMatch(/\.claude\.json|\.mcp\.json/);
});

test("renderPrintConfig cursor prints the mcpServers JSON and the .cursor/mcp.json path", () => {
  const out = renderPrintConfig("cursor");
  expect(out).toContain('"mcpServers"');
  expect(out).toContain(".cursor/mcp.json");
});

test("renderPrintConfig codex prints the TOML table for ~/.codex/config.toml", () => {
  const out = renderPrintConfig("codex");
  expect(out).toContain("[mcp_servers.jevitate]");
  expect(out).toContain('command = "jevitate"');
  expect(out).toContain('args = ["mcp"]');
  expect(out).toContain(".codex/config.toml");
});

test("renderPrintConfig rejects an unknown harness", () => {
  expect(() => renderPrintConfig("emacs" as McpHarness)).toThrow(/harness/i);
});

// ---- Part 3: JSON merge (claude-code + cursor targets) ----

test("mergeMcpJson: absent file => create with a fresh mcpServers/jevitate", () => {
  const r = mergeMcpJson(undefined, {});
  expect(r.action).toBe("create");
  expect(JSON.parse(r.content!)).toEqual(mcpServersObject());
});

test("mergeMcpJson: existing config WITHOUT jevitate keeps other servers and adds ours (update)", () => {
  const existing = JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, unrelated: 1 });
  const r = mergeMcpJson(existing, {});
  expect(r.action).toBe("update");
  const parsed = JSON.parse(r.content!);
  expect(parsed.mcpServers.other).toEqual({ command: "x", args: [] });
  expect(parsed.mcpServers.jevitate).toEqual({ command: "jevitate", args: ["mcp"] });
  expect(parsed.unrelated).toBe(1);
});

test("mergeMcpJson: our exact server already present => unchanged, no content", () => {
  const existing = JSON.stringify(mcpServersObject());
  const r = mergeMcpJson(existing, {});
  expect(r.action).toBe("unchanged");
  expect(r.content).toBeUndefined();
});

test("mergeMcpJson: a DIFFERENT jevitate entry present => skip-conflict, never clobbered", () => {
  const existing = JSON.stringify({ mcpServers: { jevitate: { command: "node", args: ["other.js"] } } });
  const r = mergeMcpJson(existing, {});
  expect(r.action).toBe("skip-conflict");
  expect(r.content).toBeUndefined();
});

test("mergeMcpJson: a DIFFERENT jevitate entry present + force => force-update overwrites", () => {
  const existing = JSON.stringify({ mcpServers: { jevitate: { command: "node", args: ["other.js"] } } });
  const r = mergeMcpJson(existing, { force: true });
  expect(r.action).toBe("force-update");
  expect(JSON.parse(r.content!).mcpServers.jevitate).toEqual({ command: "jevitate", args: ["mcp"] });
});

test("mergeMcpJson: unparseable existing file => skip-unparsable (never corrupts it)", () => {
  const r = mergeMcpJson("{ not valid json ", {});
  expect(r.action).toBe("skip-unparsable");
  expect(r.content).toBeUndefined();
});

// ---- Part 4: Codex TOML merge ----

test("mergeCodexToml: absent file => create with the jevitate table", () => {
  const r = mergeCodexToml(undefined, {});
  expect(r.action).toBe("create");
  expect(r.content).toContain("[mcp_servers.jevitate]");
  expect(r.content).toContain('command = "jevitate"');
});

test("mergeCodexToml: existing config WITHOUT our table appends it, preserving prior bytes", () => {
  const existing = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\nargs = []\n';
  const r = mergeCodexToml(existing, {});
  expect(r.action).toBe("update");
  expect(r.content!.startsWith(existing)).toBe(true);
  expect(r.content).toContain("[mcp_servers.jevitate]");
  expect(r.content).toContain("[mcp_servers.other]");
});

test("mergeCodexToml: our exact table already present => unchanged", () => {
  const first = mergeCodexToml(undefined, {}).content!;
  const r = mergeCodexToml(first, {});
  expect(r.action).toBe("unchanged");
  expect(r.content).toBeUndefined();
});

test("mergeCodexToml: a DIFFERENT jevitate table present => skip-conflict (print, don't rewrite)", () => {
  const existing = '[mcp_servers.jevitate]\ncommand = "node"\nargs = ["custom.js"]\n';
  const r = mergeCodexToml(existing, {});
  expect(r.action).toBe("skip-conflict");
  expect(r.content).toBeUndefined();
});

test("mergeCodexToml: a DIFFERENT jevitate table present + force => force-update replaces just that table", () => {
  const existing = 'model = "gpt-5"\n\n[mcp_servers.jevitate]\ncommand = "node"\nargs = ["custom.js"]\n\n[other]\nx = 1\n';
  const r = mergeCodexToml(existing, { force: true });
  expect(r.action).toBe("force-update");
  expect(r.content).toContain('command = "jevitate"');
  expect(r.content).not.toContain("custom.js");
  // untouched neighbours preserved
  expect(r.content).toContain('model = "gpt-5"');
  expect(r.content).toContain("[other]");
});

// ---- Part 5: registerMcp orchestration (real fs on temp dirs) ----

function envDirs() {
  const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
  const paths = resolveMcpTargetPaths({ homedir: () => home, cwd: () => cwd });
  return { home, cwd, paths };
}

test("resolveMcpTargetPaths composes the three harness config paths", () => {
  const p = resolveMcpTargetPaths({ homedir: () => "/home/u", cwd: () => "/proj" });
  expect(p.claudeMcpJson).toBe(join("/proj", ".mcp.json"));
  expect(p.cursorMcpJson).toBe(join("/proj", ".cursor", "mcp.json"));
  expect(p.codexConfigToml).toBe(join("/home/u", ".codex", "config.toml"));
});

test("registerMcp first run writes .mcp.json, .cursor/mcp.json and ~/.codex/config.toml (all create)", async () => {
  const { paths } = envDirs();
  const report = await registerMcp(["claude-code", "cursor", "codex"], paths, {});
  expect(report.every((r) => r.action === "create")).toBe(true);
  expect(JSON.parse(readFileSync(paths.claudeMcpJson, "utf8"))).toEqual(mcpServersObject());
  expect(JSON.parse(readFileSync(paths.cursorMcpJson, "utf8"))).toEqual(mcpServersObject());
  expect(readFileSync(paths.codexConfigToml, "utf8")).toContain("[mcp_servers.jevitate]");
});

test("registerMcp ignores the generic runtime (MCP config is harness-specific)", async () => {
  const { paths } = envDirs();
  const report = await registerMcp(["generic"], paths, {});
  expect(report).toEqual([]);
  expect(existsSync(paths.claudeMcpJson)).toBe(false);
});

test("registerMcp second identical run is fully idempotent (all unchanged, bytes stable)", async () => {
  const { paths } = envDirs();
  await registerMcp(["claude-code", "cursor", "codex"], paths, {});
  const before = [paths.claudeMcpJson, paths.cursorMcpJson, paths.codexConfigToml].map((p) => readFileSync(p, "utf8"));
  const report = await registerMcp(["claude-code", "cursor", "codex"], paths, {});
  expect(report.every((r) => r.action === "unchanged")).toBe(true);
  const after = [paths.claudeMcpJson, paths.cursorMcpJson, paths.codexConfigToml].map((p) => readFileSync(p, "utf8"));
  expect(after).toEqual(before);
});

test("registerMcp REFUSES to clobber a user's conflicting entry: skip-conflict + a printable instruction", async () => {
  const { paths } = envDirs();
  mkdirSync(join(paths.cursorMcpJson, ".."), { recursive: true });
  const userCursor = JSON.stringify({ mcpServers: { jevitate: { command: "node", args: ["mine.js"] } } }, null, 2);
  await writeFile(paths.cursorMcpJson, userCursor, "utf8");

  const report = await registerMcp(["cursor"], paths, {});
  const entry = report.find((r) => r.target === "cursor")!;
  expect(entry.action).toBe("skip-conflict");
  expect(entry.instruction).toBeTruthy();
  // the user's file is left byte-for-byte intact
  expect(readFileSync(paths.cursorMcpJson, "utf8")).toBe(userCursor);
});

test("registerMcp --force overwrites a conflicting JSON entry", async () => {
  const { paths } = envDirs();
  mkdirSync(join(paths.cursorMcpJson, ".."), { recursive: true });
  await writeFile(paths.cursorMcpJson, JSON.stringify({ mcpServers: { jevitate: { command: "node", args: ["mine.js"] } } }), "utf8");
  const report = await registerMcp(["cursor"], paths, { force: true });
  expect(report.find((r) => r.target === "cursor")!.action).toBe("force-update");
  expect(JSON.parse(readFileSync(paths.cursorMcpJson, "utf8")).mcpServers.jevitate).toEqual({ command: "jevitate", args: ["mcp"] });
});

test("registerMcp dry-run reports actions but writes nothing", async () => {
  const { paths } = envDirs();
  const report = await registerMcp(["claude-code", "codex"], paths, { dryRun: true });
  expect(report.every((r) => r.action === "create")).toBe(true);
  expect(existsSync(paths.claudeMcpJson)).toBe(false);
  expect(existsSync(paths.codexConfigToml)).toBe(false);
});

test("registerMcp surfaces a printable instruction on an unparseable target instead of corrupting it", async () => {
  const { paths } = envDirs();
  await writeFile(paths.claudeMcpJson, "{ broken", "utf8");
  const report = await registerMcp(["claude-code"], paths, {});
  const entry = report.find((r) => r.target === "claude-code")!;
  expect(entry.action).toBe("skip-unparsable");
  expect(entry.instruction).toContain("mcpServers");
  expect(readFileSync(paths.claudeMcpJson, "utf8")).toBe("{ broken");
});
