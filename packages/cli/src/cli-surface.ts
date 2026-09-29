import type { Command, Option, Argument } from "commander";

/** Best-effort placeholder for absolute, environment-dependent paths (home dir, cwd, tmp). */
export function normalizeVolatile(text: string): string {
  return text
    .split(process.cwd()).join("<cwd>")
    .replace(/\/home\/[^/\s"']+/g, "<home>")
    .replace(/\/root(?=[/\s"'])/g, "<home>");
}

export interface OptionSurface {
  readonly flags: string;
  readonly description: string;
  readonly defaultValue: string;
  readonly choices: readonly string[] | null;
  readonly required: boolean;
  readonly mandatory: boolean;
  readonly negate: boolean;
  readonly variadic: boolean;
  readonly envVar: string | null;
}

export interface ArgumentSurface {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly defaultValue: string;
  readonly choices: readonly string[] | null;
}

export interface CommandSurface {
  readonly path: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly arguments: readonly ArgumentSurface[];
  readonly options: readonly OptionSurface[];
}

export function describeOption(o: Option): OptionSurface {
  return {
    flags: o.flags,
    description: normalizeVolatile(o.description),
    defaultValue: normalizeVolatile(JSON.stringify(o.defaultValue ?? null)),
    choices: o.argChoices ?? null,
    required: o.required,
    mandatory: o.mandatory,
    negate: o.negate,
    variadic: o.variadic,
    envVar: o.envVar ?? null,
  };
}

export function describeArgument(a: Argument): ArgumentSurface {
  return {
    name: a.name(),
    description: normalizeVolatile(a.description),
    required: a.required,
    variadic: a.variadic,
    defaultValue: normalizeVolatile(JSON.stringify(a.defaultValue ?? null)),
    choices: a.argChoices ?? null,
  };
}

/** Walks the ENTIRE command tree recursively (subcommands of subcommands included, e.g. `mission target add`). */
export function walk(cmd: Command, path: string): CommandSurface[] {
  const here: CommandSurface = {
    path,
    aliases: [...cmd.aliases()].sort(),
    description: normalizeVolatile(cmd.description()),
    // Positional arguments: order is semantically meaningful (they're positional), never sorted.
    arguments: cmd.registeredArguments.map(describeArgument),
    // Options: sorted so option-registration order (an implementation detail) never causes a diff.
    options: [...cmd.options].map(describeOption).sort((a, b) => a.flags.localeCompare(b.flags)),
  };
  const children = [...cmd.commands]
    .filter((c) => c.name() !== "help") // Commander's auto-added implicit help subcommand: not user surface.
    .sort((a, b) => a.name().localeCompare(b.name()))
    .flatMap((c) => walk(c, path === "" ? c.name() : `${path} ${c.name()}`));
  return [here, ...children];
}
