import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { normalizeVolatile, walk, type CommandSurface } from "./cli-surface.js";

/**
 * #231 guard (run BEFORE any file split): a full, deterministic snapshot of the entire `jevitate`
 * CLI surface — every command, subcommand, alias, argument and option, walked recursively off the
 * live `Command` tree `buildProgram` returns. `program.ts` (and its `explore-api.ts` / `check-api.ts`
 * / etc. neighbors named in issue #231) is about to be split into per-command-group modules; this
 * test holds the OUTPUT of that tree constant across the split. A move that drops a flag, changes a
 * default, renames an option, or silently loses a subcommand shows up as a snapshot diff — nothing
 * about the split itself is allowed to touch `cli-surface.snapshot.txt`. An INTENTIONAL surface
 * change (a new flag, a changed default, a renamed command) updates the committed snapshot in the
 * same commit as the change, with the reason in that commit's message — never silently regenerated.
 *
 * Only genuinely volatile, environment-dependent values are normalized to placeholders (the version
 * string, which embeds a git commit/build timestamp); everything else — including every default
 * value and every absolute-path-shaped string actually found in help text — is captured verbatim, on
 * the theory that a real regression is more likely to hide in a "surely this is just noise" value
 * than in a flag name.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function renderSurface(surfaces: readonly CommandSurface[]): string {
  const lines: string[] = [];
  for (const s of surfaces) {
    lines.push(`# ${s.path === "" ? "(root)" : s.path}`);
    if (s.aliases.length > 0) lines.push(`  aliases: ${s.aliases.join(", ")}`);
    lines.push(`  description: ${s.description}`);
    if (s.arguments.length > 0) {
      lines.push("  arguments:");
      for (const a of s.arguments) {
        lines.push(
          `    - name=${a.name} required=${a.required} variadic=${a.variadic} default=${a.defaultValue}` +
            (a.choices !== null ? ` choices=${JSON.stringify(a.choices)}` : "") +
            (a.description !== "" ? ` description=${a.description}` : ""),
        );
      }
    }
    if (s.options.length > 0) {
      lines.push("  options:");
      for (const o of s.options) {
        lines.push(
          `    - flags=${o.flags} required=${o.required} mandatory=${o.mandatory} negate=${o.negate}` +
            ` variadic=${o.variadic} default=${o.defaultValue}` +
            (o.choices !== null ? ` choices=${JSON.stringify(o.choices)}` : "") +
            (o.envVar !== null ? ` env=${o.envVar}` : "") +
            ` description=${o.description}`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function testProgram(): Command {
  return buildProgram({ profiles: new ProfileManager("/unused-in-cli-surface-snapshot") });
}

describe("CLI surface snapshot (#231 guard — must survive the program.ts split unchanged)", () => {
  it("every command, subcommand, alias, argument and option matches the committed snapshot", async () => {
    const program = testProgram();
    // Sanity floor: this must never silently walk zero commands (a build failure disguised as an empty tree).
    const surfaces = walk(program, "");
    expect(surfaces.length).toBeGreaterThan(40);

    const text = renderSurface(surfaces);
    await expect(text).toMatchFileSnapshot(join(CLI_ROOT, "src", "__snapshots__", "cli-surface.snapshot.txt"));
  });

  it("root --help and every top-level command's --help produce non-empty text (a vanished command regression)", () => {
    const program = testProgram();
    const rootHelp = normalizeVolatile(program.helpInformation());
    expect(rootHelp.trim().length).toBeGreaterThan(0);
    expect(rootHelp).toContain("jevitate");

    const topLevel = program.commands.filter((c) => c.name() !== "help");
    expect(topLevel.length).toBeGreaterThan(5);
    for (const cmd of topLevel) {
      const help = normalizeVolatile(cmd.helpInformation());
      expect(help.trim().length, `--help for "${cmd.name()}" must be non-empty`).toBeGreaterThan(0);
      expect(help, `--help for "${cmd.name()}" should include its own name`).toContain(cmd.name());
    }
  });
});
