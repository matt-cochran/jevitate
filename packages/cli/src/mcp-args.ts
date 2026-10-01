import { McpPathError, confineMcpPath } from "./mcp-paths.js";
import { readUnpackedExtensions, type UnpackedExtension } from "@jevitate/playwright";

/**
 * #255 — strict typed reads of MCP tool arguments. A wrong type is a typed `invalid_args` refusal
 * naming the argument — never coerced, never silently dropped (the CLI's parse errors are exit 64
 * the same way). Absent (`undefined`) is always "not given".
 */
export class McpArgError extends Error {
  readonly error = "invalid_args" as const;
  constructor(message: string) {
    super(message);
    this.name = "McpArgError";
  }
}

export type McpArgs = Readonly<Record<string, unknown>>;

export function optString(args: McpArgs, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) throw new McpArgError(`'${key}' must be a non-empty string`);
  if (v.includes("\0")) throw new McpArgError(`'${key}' must not contain a NUL byte`);
  return v;
}

export function optBool(args: McpArgs, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new McpArgError(`'${key}' must be a boolean`);
  return v;
}

export function optInt(args: McpArgs, key: string, min: number): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new McpArgError(`'${key}' must be an integer >= ${min}`);
  return v;
}

export function optEnum<T extends string>(args: McpArgs, key: string, values: readonly T[]): T | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new McpArgError(`'${key}' must be one of ${values.join(" | ")}`);
  return v as T;
}

export function optStringArray(args: McpArgs, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0 && !x.includes("\0"))) {
    throw new McpArgError(`'${key}' must be an array of non-empty strings`);
  }
  return v as string[];
}

/** `{width, height}` (positive integers) → the CLI's `WxH` form, parsed by the same `--viewport` code. */
export function optViewport(args: McpArgs, key = "viewport"): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  const o = v as { width?: unknown; height?: unknown };
  if (
    v === null ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => k !== "width" && k !== "height") ||
    typeof o.width !== "number" ||
    typeof o.height !== "number" ||
    !Number.isInteger(o.width) ||
    !Number.isInteger(o.height) ||
    o.width <= 0 ||
    o.height <= 0
  ) {
    throw new McpArgError(`'${key}' must be {width, height} (positive integers)`);
  }
  return `${o.width}x${o.height}`;
}

/** A string→string map (`params`), refused when any value is not a string. */
export function optStringMap(args: McpArgs, key: string): Record<string, string> | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string")) {
    throw new McpArgError(`'${key}' must be an object of string values`);
  }
  return v as Record<string, string>;
}

/** A confined path argument (see mcp-paths.ts); `session` for a storage state. */
export function optPath(args: McpArgs, key: string, roots: readonly string[], opts: { session?: boolean } = {}): string | undefined {
  if (args[key] === undefined) return undefined;
  return confineMcpPath(args[key], key, roots, opts);
}

/**
 * `name=<storageState path>` entries (the CLI's repeatable `--actor`/`--fixture-identity`), each
 * path confined as a session.
 */
export function optNamedSessions(args: McpArgs, key: string, roots: readonly string[]): string[] | undefined {
  const list = optStringArray(args, key);
  if (list === undefined) return undefined;
  return list.map((x, i) => {
    const eq = x.indexOf("=");
    if (eq <= 0) throw new McpArgError(`'${key}[${i}]' must be 'name=<storageState path>'`);
    return `${x.slice(0, eq)}=${confineMcpPath(x.slice(eq + 1), `${key}[${i}]`, roots, { session: true })}`;
  });
}

/**
 * #256: `extension` — unpacked extension directories (the CLI's repeatable `--extension <dir>`),
 * each confined like every path argument, then read and checked (a directory with a valid
 * manifest.json) before any browser opens.
 */
export function optExtensions(args: McpArgs, roots: readonly string[], key = "extension"): UnpackedExtension[] | undefined {
  const dirs = optStringArray(args, key);
  if (dirs === undefined || dirs.length === 0) return undefined;
  const confined = dirs.map((d, i) => confineMcpPath(d, `${key}[${i}]`, roots));
  try {
    return readUnpackedExtensions(confined);
  } catch (err) {
    throw new McpArgError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * `recordVideo`: `true` (next to the run's result) or a directory (confined) — the CLI's
 * `--record-video [dir]`.
 */
export function optRecordVideo(args: McpArgs, roots: readonly string[], key = "recordVideo"): boolean | string | undefined {
  const v = args[key];
  if (v === undefined || v === false) return undefined;
  if (v === true) return true;
  if (typeof v === "string") return confineMcpPath(v, key, roots);
  throw new McpArgError(`'${key}' must be true or a directory path`);
}

/**
 * `screenshots`: `true` | `screens` | `steps` | `screens:<dir>` | `steps:<dir>` | `<dir>` — the CLI's
 * `--screenshots [mode|dir]`, with any directory confined.
 */
export function optScreenshots(args: McpArgs, roots: readonly string[], key = "screenshots"): boolean | string | undefined {
  const v = args[key];
  if (v === undefined || v === false) return undefined;
  if (v === true) return true;
  if (typeof v !== "string" || v.trim() === "") throw new McpArgError(`'${key}' must be true, a mode (screens | steps), mode:<dir> or a directory`);
  const t = v.trim();
  if (t === "screens" || t === "steps") return t;
  const m = /^(screens|steps):(.*)$/.exec(t);
  if (m !== null) return `${m[1]}:${confineMcpPath((m[2] ?? "").trim(), key, roots)}`;
  return confineMcpPath(t, key, roots);
}

/** The typed MCP error body for a thrown argument/path refusal, or undefined for anything else. */
export function argErrorBody(err: unknown): { error: "invalid_args"; message: string } | undefined {
  return err instanceof McpArgError || err instanceof McpPathError ? { error: "invalid_args", message: err.message } : undefined;
}
