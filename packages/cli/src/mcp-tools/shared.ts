import { ALL_CREDENTIAL_KEYS, type CredentialStore } from "@jevitate/ai-core";
import { join } from "node:path";
import { RunTagError, JOURNEY_RUN_OUTCOMES, journeyExitCode, validateRunTags, type JourneyRunOutcome } from "@jevitate/domain";
import { optInt } from "../mcp-args.js";
import { type GovernanceFlags } from "../resource-preflight.js";
import type { McpApiDeps, McpTool, McpToolResult } from "../mcp-api.js";

/** The dependencies a tool group closes over (built once by `buildMcpTools`). */
export interface McpToolCtx {
  readonly deps: McpApiDeps;
  readonly pathRoots: readonly string[];
  readonly credentialStore: CredentialStore;
  readonly runJourney: NonNullable<McpApiDeps["runJourney"]>;
  readonly verifyFixImpl: NonNullable<McpApiDeps["verifyFix"]>;
}

/** One group's tool descriptors, keyed by tool name (the name is added by `buildMcpTools`). */
export type McpToolGroup = Record<string, Omit<McpTool, "name">>;


/** #205: a native tool's `maxBrowsers` / `maxBrowserMemory` (MiB) arguments, typed like the CLI flags. */
export function governanceArgs(args: Record<string, unknown>): GovernanceFlags {
  const maxBrowsers = optInt(args, "maxBrowsers", 1);
  const maxBrowserMemory = optInt(args, "maxBrowserMemory", 1);
  return { ...(maxBrowsers === undefined ? {} : { maxBrowsers }), ...(maxBrowserMemory === undefined ? {} : { maxBrowserMemory }) };
}

/** #453: a Journey run result with the CLI's exit code for its outcome (anything else unchanged). */
export function withJourneyExitCode(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const outcome = (result as { outcome?: unknown }).outcome;
  if (typeof outcome !== "string" || !(JOURNEY_RUN_OUTCOMES as readonly string[]).includes(outcome)) return result;
  return { ...result, exitCode: journeyExitCode(outcome as JourneyRunOutcome) };
}

export function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function errorResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: true };
}

/** Strips any known credential VALUE from a diagnostic string so a provider
 *  SDK error (which can echo request internals verbatim) never surfaces a key
 *  through the MCP result. The message returned to the caller is generic and
 *  key-free; this is belt-and-braces on top of the gateway's outbound guard. */
/** #217: a persisted goal result's own ending (`result.goalOutcome`), when present. */
export function goalOutcomeOf(file: object): unknown {
  const result = (file as { result?: unknown }).result;
  return result !== null && typeof result === "object" && "goalOutcome" in result ? (result as { goalOutcome: unknown }).goalOutcome : undefined;
}

/** #423: a persisted result's `defectOutcome.status` (`none`/`defects`), when present. */
export function defectStatusOf(file: object): unknown {
  const outcome = resultField(file, "defectOutcome");
  return outcome !== null && typeof outcome === "object" && "status" in outcome ? (outcome as { status: unknown }).status : undefined;
}

/** One field of a persisted result's `result` object, else undefined. */
export function resultField(file: object, key: string): unknown {
  const result = (file as { result?: unknown }).result;
  return result !== null && typeof result === "object" && key in result ? (result as Record<string, unknown>)[key] : undefined;
}

/** A model-backed option was asked for without usable gateways/keys (typed `setup_required`). */
export class SetupRequired extends Error {}

export function redactCredentials(message: string, store: CredentialStore): string {
  let out = message;
  for (const key of ALL_CREDENTIAL_KEYS) {
    const value = store.read(key);
    if (value) out = out.split(value).join("***REDACTED***");
  }
  return out;
}

  /** #426: the run tools' `tags` object — validated like `--tag` (an invalid one is invalid_args, never dropped). */
export const tagsArg = (args: Record<string, unknown>): { tags: Record<string, string> } | { error: Record<string, unknown> } => {
  if (args.tags === undefined) return { tags: {} };
  try {
    return { tags: validateRunTags(args.tags, "tags") };
  } catch (err) {
    if (!(err instanceof RunTagError)) throw err;
    return { error: { error: "invalid_args", code: err.code, message: err.message } };
  }
};
