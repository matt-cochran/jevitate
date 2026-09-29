import type { Command } from "commander";
import { walk, type ArgumentSurface, type CommandSurface, type OptionSurface } from "./cli-surface.js";

/** Escapes a value for a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

function anchor(path: string): string {
  return path.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
}

function defaultCell(json: string): string {
  if (json === "null") return "";
  try {
    const v: unknown = JSON.parse(json);
    return code(typeof v === "string" ? v : JSON.stringify(v));
  } catch {
    return code(json);
  }
}

function usageLine(s: CommandSurface, hasChildren: boolean): string {
  const args = s.arguments.map((a) => {
    const n = a.variadic ? `${a.name}...` : a.name;
    return a.required ? `<${n}>` : `[${n}]`;
  });
  const parts = [`jevitate ${s.path}`, ...(s.options.length > 0 ? ["[options]"] : []), ...(hasChildren ? ["[command]"] : []), ...args];
  return parts.join(" ");
}

function renderArguments(args: readonly ArgumentSurface[]): string[] {
  if (args.length === 0) return [];
  const out = ["**Arguments**", "", "| Argument | Description | Required | Default | Choices |", "| --- | --- | --- | --- | --- |"];
  for (const a of args) {
    out.push(
      `| ${code(a.variadic ? `${a.name}...` : a.name)} | ${cell(a.description)} | ${a.required ? "yes" : "no"} | ${defaultCell(a.defaultValue)} | ${a.choices ? a.choices.map(code).join(", ") : ""} |`,
    );
  }
  return [...out, ""];
}

function renderOptions(opts: readonly OptionSurface[]): string[] {
  if (opts.length === 0) return [];
  const out = ["**Options**", "", "| Flags | Description | Default | Choices | Required | Env |", "| --- | --- | --- | --- | --- | --- |"];
  for (const o of opts) {
    out.push(
      `| ${code(o.flags)} | ${cell(o.description)} | ${defaultCell(o.defaultValue)} | ${o.choices ? o.choices.map(code).join(", ") : ""} | ${o.mandatory ? "yes" : ""} | ${o.envVar ? code(o.envVar) : ""} |`,
    );
  }
  return [...out, ""];
}

/** Renders the full CLI reference markdown from a live commander tree. Deterministic: no versions, dates or absolute paths. */
export function renderCliReference(program: Command): string {
  const surfaces = walk(program, "");
  const root = surfaces[0]!;
  const commands = surfaces.slice(1);
  const hasChildren = (path: string): boolean => commands.some((c) => c.path.startsWith(`${path} `));
  const top = commands.filter((c) => !c.path.includes(" "));

  const lines: string[] = [
    "# CLI reference",
    "",
    "> Generated from the CLI — do not edit by hand; run `pnpm docs:cli`.",
    "",
    root.description,
    "",
    ...renderOptions(root.options),
    "## Commands",
    "",
    ...top.map((c) => `- [${code(c.path)}](#${anchor(c.path)}): ${c.description.split("\n")[0]}`),
    "",
  ];
  for (const c of commands) {
    const depth = Math.min(c.path.split(" ").length + 1, 6);
    lines.push(`${"#".repeat(depth)} ${c.path}`, "");
    lines.push("```", usageLine(c, hasChildren(c.path)), "```", "");
    if (c.description !== "") lines.push(c.description, "");
    if (c.aliases.length > 0) lines.push(`Aliases: ${c.aliases.map(code).join(", ")}`, "");
    lines.push(...renderArguments(c.arguments), ...renderOptions(c.options));
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
