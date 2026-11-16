import { argErrorBody, McpArgError, optRecordVideo, optScreenshots, optViewport, type McpArgs } from "./mcp-args.js";
import { confineMcpPath, McpPathError } from "./mcp-paths.js";
import { join, resolve as resolvePath } from "node:path";
import { homeDataRoot } from "./project-dir.js";
import type { McpCliRunner } from "./mcp-cli-runner.js";
import { policyLoosenings, policyLoosenRefusalBody, RunGuardRefusedError, runGuardRefusalBody, targetPromoteRefusalBody } from "./mcp-run-guard.js";
import { RunModeRefusedError, runModeRefusalBody } from "./journey-run-mode-gate.js";
import { heldOutcomeOf } from "./journey-hold.js";
import { ProofHoldRefusedError, proofHoldRefusalBody } from "./journey-run-hooks.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SitePolicySchema, type SitePolicy } from "@jevitate/domain";
import { withSitePolicyRepository } from "./cli-shared.js";
import { sitePolicyKey } from "./site-gate-cli.js";
import { secretParamRefusalBody, secretParamsCarried } from "./secret-params.js";
import type { CliCommandSpec, CliParam, CliToolSpec } from "./mcp-cli-tool-params.js";

/**
 * #255 — MCP ⊇ CLI. Every CLI command an agent could run as `jevitate … --json` is reachable over
 * MCP (MCP is a convenience and an optimization for LLMs, not a separate product surface). The
 * tools here MIRROR a CLI command: their typed arguments map one-to-one onto that command's flags
 * and positional arguments, and the handler runs the command in process (mcp-cli-runner.ts) and
 * returns its JSON envelope and exit code. The CLI does every check it always does — so the two
 * surfaces validate, confine, redact and exit identically — and MCP adds its own strictness on top:
 *
 * - arguments are typed and closed: an unknown argument or a wrong type is `invalid_args`, never
 *   ignored or coerced;
 * - every path argument is confined (mcp-paths.ts): inside the project or `~/.jevitate/`, and a
 *   storage state never under a repo's `.jevitate/`;
 * - the argv is built by code, never parsed from caller text: options are passed as
 *   `--flag=value` and positionals after `--`, so no argument value can become a flag;
 * - flags that are the OPERATOR's call are not MCP arguments at all (`omitted`, each with its
 *   reason, checked against the real commander tree by mcp-cli-parity.test.ts): shell hooks, the
 *   browser binary/switches, which environment variable a secret is read from, `cmd:` log sources,
 *   store directories.
 *
 * Long-running commands follow the existing MCP pattern: a single browser run on one Journey,
 * finding or suite (run_journey, verify_fix, and here annotate/demo/check/regressions/load/…)
 * runs DIRECTLY and returns its verdict; open-ended exploration against a promoted target is
 * queue + poll (queue_exploration → run_queued_missions/`mission run` → get_mission_result). A
 * direct exploration (`explore`) is `run_exploration`, bounded by its own budget flags.
 *
 * The result: `{exitCode, data}` (the envelope's data). Exit 0/1/3/4 are answers (1 = defects /
 * still reproduces, 3 = hang, 4 = intermittent) and come back as a normal result; exit 2 (the run
 * proved nothing) and every refusal come back as an MCP error result — never a pass. A refusal is
 * `{error: "invalid_args" (exit 64) | "refused", code: "E_…", message, exitCode}`.
 */

export { OMIT } from "./mcp-cli-tool-params.js";
/** @public: the kind of a CliParam, kept on this surface for a reader of CliParam. */
export type { CliParamKind } from "./mcp-cli-tool-params.js";
export type { CliCommandSpec, CliParam, CliToolSpec } from "./mcp-cli-tool-params.js";
export { CLI_TOOL_SPECS } from "./mcp-cli-tool-specs.js";

// ── Schema + argv ─────────────────────────────────────────────────────────────────────────────
function paramSchema(p: CliParam): Record<string, unknown> {
  switch (p.kind) {
    case "string":
      return p.enum === undefined ? { type: "string" } : { type: "string", enum: [...p.enum] };
    case "integer":
      return { type: "integer", minimum: 0 };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "string[]":
    case "path[]":
    case "named-sessions":
    case "bound-paths":
      return { type: "array", items: { type: "string" } };
    case "params":
      return { type: "object", additionalProperties: { type: "string" } };
    case "path":
    case "session":
    case "project-path":
      return { type: "string" };
    case "optional-path":
    case "optional-session":
    case "screenshots":
      return { type: ["boolean", "string"] };
    case "viewport":
      return { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } }, required: ["width", "height"] };
  }
}

/** The MCP inputSchema for a CLI-backed tool (a family adds the `action` discriminator). */
export function cliToolInputSchema(spec: CliToolSpec): { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false } {
  const commands = spec.command !== undefined ? [spec.command] : Object.values(spec.actions ?? {});
  const properties: Record<string, unknown> = {};
  for (const c of commands) for (const [name, p] of Object.entries(c.params)) properties[name] = paramSchema(p);
  if (spec.actions !== undefined) properties.action = { type: "string", enum: Object.keys(spec.actions) };
  const required =
    spec.actions !== undefined
      ? ["action"]
      : Object.entries(spec.command!.params)
          .filter(([, p]) => p.required === true)
          .map(([k]) => k);
  return { type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false };
}

/** The command an invocation selects (validating `action` for a family). */
export function commandFor(spec: CliToolSpec, args: McpArgs): CliCommandSpec {
  if (spec.command !== undefined) return spec.command;
  const actions = spec.actions ?? {};
  const action = args.action;
  if (typeof action !== "string" || actions[action] === undefined) throw new McpArgError(`'action' must be one of ${Object.keys(actions).join(" | ")}`);
  return actions[action];
}

const asText = (v: unknown, key: string): string => {
  if (typeof v !== "string" || v.length === 0) throw new McpArgError(`'${key}' must be a non-empty string`);
  if (v.includes("\0")) throw new McpArgError(`'${key}' must not contain a NUL byte`);
  return v;
};

const asStrings = (v: unknown, key: string): string[] => {
  if (!Array.isArray(v)) throw new McpArgError(`'${key}' must be an array of strings`);
  return v.map((x, i) => asText(x, `${key}[${i}]`));
};

/** The values one argument contributes (before flag formatting). */
function values(name: string, p: CliParam, v: unknown, roots: readonly string[]): string[] | boolean {
  switch (p.kind) {
    case "string": {
      const t = asText(v, name);
      if (p.enum !== undefined && !p.enum.includes(t)) throw new McpArgError(`'${name}' must be one of ${p.enum.join(" | ")}`);
      return [t];
    }
    case "integer":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new McpArgError(`'${name}' must be a non-negative integer`);
      return [String(v)];
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) throw new McpArgError(`'${name}' must be a number`);
      return [String(v)];
    case "boolean":
      if (typeof v !== "boolean") throw new McpArgError(`'${name}' must be a boolean`);
      return v;
    case "string[]":
      return asStrings(v, name);
    case "path":
      return [confineMcpPath(v, name, roots)];
    case "project-path": {
      // #464: project output (an exported bundle) is written inside the project, never under ~/.jevitate/.
      const home = resolvePath(homeDataRoot());
      const projectRoots = roots.filter((r) => resolvePath(r) !== home);
      if (projectRoots.length === 0) throw new McpPathError(`'${name}' needs a project: this server has no project root to write into`);
      return [confineMcpPath(v, name, projectRoots)];
    }
    case "session":
      return [confineMcpPath(v, name, roots, { session: true })];
    case "path[]":
      return asStrings(v, name).map((x, i) => confineMcpPath(x, `${name}[${i}]`, roots));
    case "named-sessions":
      return asStrings(v, name).map((x, i) => {
        const eq = x.indexOf("=");
        if (eq <= 0) throw new McpArgError(`'${name}[${i}]' must be 'name=<storageState path>'`);
        return `${x.slice(0, eq)}=${confineMcpPath(x.slice(eq + 1), `${name}[${i}]`, roots, { session: true })}`;
      });
    case "bound-paths":
      return asStrings(v, name).map((x, i) => {
        const eq = x.lastIndexOf("=");
        if (eq <= 0) throw new McpArgError(`'${name}[${i}]' must be '<descriptor>=<file path>'`);
        return `${x.slice(0, eq)}=${confineMcpPath(x.slice(eq + 1), `${name}[${i}]`, roots)}`;
      });
    case "params": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new McpArgError(`'${name}' must be an object of string values`);
      return Object.entries(v as Record<string, unknown>).map(([k, x]) => {
        if (k.length === 0 || k.includes("=")) throw new McpArgError(`'${name}' keys must be non-empty and contain no '='`);
        return `${k}=${asText(x, `${name}.${k}`)}`;
      });
    }
    case "optional-path": {
      const r = optRecordVideo({ [name]: v }, roots, name);
      return typeof r === "string" ? [r] : r === true;
    }
    case "optional-session":
      if (v === false) return false;
      if (v === true) return true;
      return [confineMcpPath(v, name, roots, { session: true })];
    case "screenshots": {
      const r = optScreenshots({ [name]: v }, roots, name);
      return typeof r === "string" ? [r] : r === true;
    }
    case "viewport":
      return [optViewport({ [name]: v }, name)!];
  }
}

/**
 * The argv for one invocation: `<path…> --flag=value… --json -- <positionals…>`. Options use the
 * `=` form and positionals follow `--`, so no value can ever be read as a flag.
 */
export function buildCliArgv(spec: CliToolSpec, args: McpArgs, roots: readonly string[]): string[] {
  const command = commandFor(spec, args);
  const known = new Set([...Object.keys(command.params), ...(spec.actions === undefined ? [] : ["action"])]);
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new McpArgError(`unknown argument(s) for ${spec.name}${spec.actions === undefined ? "" : ` ${String(args.action)}`}: ${unknown.join(", ")} (allowed: ${[...known].join(", ") || "none"})`);
  }
  const flags: string[] = [];
  const positionals: string[] = [];
  for (const [name, p] of Object.entries(command.params)) {
    const v = args[name];
    if (v === undefined) {
      if (p.required === true) throw new McpArgError(`'${name}' is required`);
      continue;
    }
    const out = values(name, p, v, roots);
    if (p.positional === true) {
      if (typeof out === "boolean") throw new McpArgError(`'${name}' must be a value`);
      positionals.push(...out);
      continue;
    }
    const flag = p.flag!;
    if (typeof out === "boolean") {
      // `--no-x` flags are exposed as `x: false`; everything else as `x: true`.
      const negated = flag.startsWith("--no-");
      if (out === !negated) flags.push(flag);
      continue;
    }
    for (const value of out) flags.push(`${flag}=${value}`);
  }
  // `--json` whenever the command has it (every one but `recording promote`, which prints JSON anyway).
  return [...command.path.split(" "), ...flags, ...(command.omitted["--json"] === undefined ? [] : ["--json"]), "--", ...positionals];
}

/**
 * 0.30.0 §5.4 (#799), the ratchet: what an MCP call may not do that the CLI command it mirrors may.
 * - `mission_targets promote` refuses (`E_TARGET_PROMOTE_OVER_MCP`): promoting a target is a CLI act.
 * - `site_policy set` sets only a policy at least as strict as the effective one on every axis
 *   (`E_POLICY_LOOSEN_OVER_MCP`). The file is read once, here: the command is handed a private copy of
 *   exactly what was judged, so the file cannot change between the check and the write.
 * Returns a refusal body, or the argv to run (possibly with the copy's path), and a cleanup.
 */
async function mcpRatchet(
  spec: CliToolSpec,
  args: McpArgs,
  argv: string[],
  deps: { readonly sitePolicyDbPath?: string | undefined },
): Promise<{ readonly refusal: Record<string, unknown> } | { readonly argv: string[]; readonly cleanup: () => void }> {
  const none = { argv, cleanup: () => undefined };
  if (spec.name === "mission_targets" && args.action === "promote") return { refusal: targetPromoteRefusalBody(typeof args.id === "string" ? args.id : "<id>") };
  if (spec.name !== "site_policy" || args.action !== "set") return none;
  const fileFlag = argv.find((a) => a.startsWith("--file="));
  const site = typeof args.site === "string" ? args.site : undefined;
  if (fileFlag === undefined || site === undefined) return none;
  let proposed: SitePolicy;
  let raw: string;
  try {
    raw = readFileSync(fileFlag.slice("--file=".length), "utf8");
    proposed = SitePolicySchema.parse(JSON.parse(raw));
  } catch {
    // Unreadable or invalid: the command refuses it on its own (E_INVALID_POLICY), and nothing is set.
    return none;
  }
  if (deps.sitePolicyDbPath === undefined) {
    return { refusal: { error: "refused", outcome: "refused", code: "E_POLICY_LOOSEN_OVER_MCP", message: "site_policy set over MCP compares the policy with the effective one, and this server was not given the policy database, so nothing was set", retryable: false, exitCode: 2 } };
  }
  const account = typeof args.account === "string" ? args.account : "primary";
  const key = sitePolicyKey(site);
  const effective = await withSitePolicyRepository(deps.sitePolicyDbPath, (repository) => repository.get(key, account));
  const axes = policyLoosenings(effective, proposed);
  if (axes.length > 0) return { refusal: policyLoosenRefusalBody(key, axes) };
  const dir = mkdtempSync(join(tmpdir(), "jev-mcp-policy-"));
  const copy = join(dir, "policy.json");
  writeFileSync(copy, raw, { encoding: "utf8", mode: 0o600 });
  return { argv: argv.map((a) => (a === fileFlag ? `--file=${copy}` : a)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface CliToolOutcome {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
}

/** The last `{v, ok}` envelope line the command printed. */
function lastEnvelope(stdout: string): { ok: boolean; data?: unknown; error?: { code?: string; message?: string } } | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (typeof o.ok === "boolean" && "v" in o) return o as { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
    } catch {
      // not an envelope line
    }
  }
  return undefined;
}

/**
 * Runs one CLI-backed tool call: argv from the typed arguments, the CLI in process, its envelope back.
 * `redact` strips credential values from the output text (belt-and-braces over the CLI's own redaction).
 */
export async function runCliTool(spec: CliToolSpec, args: McpArgs, deps: { runCli?: McpCliRunner; roots: readonly string[]; redact: (text: string) => string; journeysDir: string; sitePolicyDbPath?: string }): Promise<CliToolOutcome> {
  let argv: string[];
  try {
    argv = buildCliArgv(spec, args, deps.roots);
  } catch (err) {
    const body = argErrorBody(err);
    if (body === undefined) throw err;
    return { isError: true, body };
  }
  const paramJourneys = commandFor(spec, args).paramJourneys;
  if (paramJourneys !== undefined) {
    const carried = await secretParamsCarried(deps.journeysDir, paramJourneys(args), args["params"]);
    if (carried.length > 0) return { isError: true, body: secretParamRefusalBody(carried) };
  }
  const ratchet = await mcpRatchet(spec, args, argv, deps);
  if ("refusal" in ratchet) return { isError: true, body: ratchet.refusal };
  if (deps.runCli === undefined) {
    ratchet.cleanup();
    return { isError: true, body: { error: "not_configured", message: `${spec.name} runs \`jevitate ${commandFor(spec, args).path}\` in process, which this server was not given` } };
  }
  const runCli = deps.runCli;
  let ran: Awaited<ReturnType<McpCliRunner>>;
  try {
    ran = await (spec.answersWhileBusy?.(args) === true ? runCli(ratchet.argv, { unqueued: true }) : runCli(ratchet.argv));
  } finally {
    ratchet.cleanup();
  }
  const { stdout: raw, exitCode, refusal } = ran;
  const stdout = deps.redact(raw);
  let envelope = lastEnvelope(stdout);
  // #789: a refused replay is the answer, whatever the command made of it. What the command did report before it stays beside it.
  // 0.30.0 §5: so is a run the run mode refused.
  const refusedBody = refusal instanceof RunGuardRefusedError ? runGuardRefusalBody(refusal) : refusal instanceof RunModeRefusedError ? runModeRefusalBody(refusal) : undefined;
  // 0.30.0 §5.4: a proof that reached a step only a person can do ends inconclusive; nothing was held.
  if (refusal instanceof ProofHoldRefusedError) {
    return { isError: true, body: { ...proofHoldRefusalBody(refusal), ...(envelope?.data === undefined || envelope.data === null ? {} : { partial: envelope.data }) } };
  }
  // 0.30.0 §5.3: a run held at a step only a person can do; it proves nothing yet (`jevitate inbox resume <holdId>`).
  const held = heldOutcomeOf(refusal);
  if (held !== undefined) {
    return { isError: true, body: { ...held, retryable: false, exitCode: 2, ...(envelope?.data === undefined || envelope.data === null ? {} : { partial: envelope.data }) } };
  }
  if (refusedBody !== undefined) {
    return { isError: true, body: { ...refusedBody, ...(envelope?.data === undefined || envelope.data === null ? {} : { partial: envelope.data }) } };
  }
  if (envelope === undefined && exitCode === 0) {
    // A command without --json (`recording promote`) prints its result as plain JSON.
    try {
      envelope = { ok: true, data: JSON.parse(stdout) as unknown };
    } catch {
      envelope = undefined;
    }
  }
  if (envelope === undefined) return { isError: true, body: { error: "internal", message: "the command printed no JSON envelope", exitCode } };
  if (!envelope.ok) {
    return { isError: true, body: { error: exitCode === 64 ? "invalid_args" : "refused", code: envelope.error?.code ?? "E_UNKNOWN", message: envelope.error?.message ?? "refused", exitCode, ...(envelope.data === undefined ? {} : { data: envelope.data }) } };
  }
  // 0/1/3/4 are answers; 2 (proved nothing) is never a pass.
  return { isError: exitCode === 2 || exitCode >= 64, body: { exitCode, data: envelope.data ?? null } };
}
