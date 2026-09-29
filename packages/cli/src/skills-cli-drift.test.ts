import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { loadManifest } from "@jevitate/skills";
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "@jevitate/mcp-facade";
import { buildProgram } from "./program.js";
import { initNextSteps } from "./init-next-steps.js";

/**
 * The agent skills `jevitate init` installs (and init's own next-steps block) teach exact
 * commands. This keeps them honest against the real command tree: every `jevitate <cmd…>` a skill
 * shows must resolve to a command, every `--flag` next to it must be one of that command's
 * options, and every MCP tool it names must be served. A renamed flag or command fails here
 * instead of teaching an agent something the CLI refuses.
 */
const program = buildProgram({ profiles: new ProfileManager("/unused-in-skills-drift") });

function sub(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/** Resolves `jevitate a b c …` to the deepest matching command (commander's default subcommand included). */
function resolve(tokens: string[]): { cmd: Command; path: string } | { error: string } {
  let cmd: Command = program;
  const path: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("-") || cmd.commands.length === 0) break;
    const next = sub(cmd, t);
    if (next === undefined) break;
    cmd = next;
    path.push(t);
  }
  if (cmd === program) return { error: `unknown command "${tokens[0] ?? ""}"` };
  const defaultName = (cmd as unknown as { _defaultCommandName?: string })._defaultCommandName;
  if (cmd.commands.length > 0 && defaultName !== undefined) {
    const d = sub(cmd, defaultName);
    if (d !== undefined) return { cmd: d, path: `${path.join(" ")} (${defaultName})` };
  }
  const family = tokens[path.length] === "..." || tokens[path.length] === "…";
  if (cmd.commands.length > 0 && family) return { cmd, path: path.join(" ") };
  if (cmd.commands.length > 0) return { error: `"jevitate ${path.join(" ")}" needs a subcommand` };
  return { cmd, path: path.join(" ") };
}

/** Every command-line-ish snippet: inline code spans (may wrap lines) and fenced-block lines. */
function snippets(md: string): string[] {
  const out: string[] = [];
  const withoutFences = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, block: string) => {
    for (const line of block.split("\n")) out.push(line);
    return "";
  });
  for (const m of withoutFences.matchAll(/`([^`]+)`/g)) out.push(m[1].replace(/\s+/g, " "));
  return out.map((s) => s.trim()).filter((s) => /^jevitate\s/.test(s));
}

function problemsIn(text: string): string[] {
  const problems: string[] = [];
  for (const snippet of snippets(text)) {
    const tokens = snippet.replace(/^jevitate\s+/, "").split(/\s+/);
    const r = resolve(tokens);
    if ("error" in r) {
      problems.push(`${r.error}: ${snippet}`);
      continue;
    }
    const known = new Set(["--help", "-h", ...r.cmd.options.flatMap((o) => [o.long, o.short].filter((f): f is string => f !== undefined))]);
    for (const m of snippet.matchAll(/(?:^|[\s[(|])(--[a-z][a-z0-9-]*)/g)) {
      if (!known.has(m[1])) problems.push(`"${m[1]}" is not an option of \`jevitate ${r.path}\`: ${snippet}`);
    }
  }
  return problems;
}

// MCP error kinds (`{error: "invalid_args" | "refused"}`) are snake_case too, but not tools.
const NOT_TOOLS = new Set(["invalid_args"]);
const TOOLS = new Set<string>([...ALLOWED_TOOLS, ...FORBIDDEN_TOOLS]);

describe("agent skills match the CLI and the MCP tool list", () => {
  for (const skill of loadManifest()) {
    it(`${skill.id}: every jevitate command and flag it shows exists`, () => {
      expect(problemsIn(skill.body)).toEqual([]);
    });

    it(`${skill.id}: every MCP tool it names is served (or explicitly forbidden)`, () => {
      const named = [...`${skill.description}\n${skill.body}`.matchAll(/`([a-z]+(?:_[a-z]+)+)(?:\(|`)/g)].map((m) => m[1]);
      expect(named.filter((t) => !TOOLS.has(t) && !NOT_TOOLS.has(t))).toEqual([]);
    });
  }

  it("README's Quick start shows only real commands and flags", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "README.md"), "utf8");
    const quick = readme.slice(readme.indexOf("## Quick start"), readme.indexOf("## See it work"));
    // Joined continuation lines (`\` + newline) so a wrapped command is checked whole.
    const text = quick.replace(/\\\n\s*/g, " ");
    expect(snippets(text).length).toBeGreaterThanOrEqual(8);
    expect(problemsIn(text)).toEqual([]);
  });

  it("the checker itself catches an unknown command, a missing subcommand and an unknown flag", () => {
    expect(problemsIn("`jevitate journey run x --nope`")).toHaveLength(1);
    expect(problemsIn("`jevitate nope --json`")).toHaveLength(1);
    expect(problemsIn("`jevitate journey --json`")).toHaveLength(1);
    expect(problemsIn("```\njevitate demo \"x\" --env local --success s --real\n```")).toEqual([]);
  });

  it("init's next-steps block only shows real commands and flags", () => {
    const all = [true, false].flatMap((keysReady) => initNextSteps({ keysReady, skills: true, dryRun: false }));
    const commands = all
      .filter((l) => l.includes("jevitate "))
      .map((l) => l.slice(l.indexOf("jevitate ")).split(/\s{3}\(/)[0].split(" — ")[0])
      .flatMap((c) => c.split(" && "));
    const asCode = commands.map((c) => `\`${c.trim()}\``).join("\n");
    expect(snippets(asCode).length).toBeGreaterThanOrEqual(6);
    expect(problemsIn(asCode)).toEqual([]);
  });
});
