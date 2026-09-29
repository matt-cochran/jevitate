import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENVIRONMENTS_FILE, ENVIRONMENTS_SCAFFOLD } from "./project-dir.js";
import type { McpInstallReport } from "./init-mcp.js";

/** What `jevitate init` knows after setup that changes the "try this next" block. */
export interface InitNextStepsInput {
  /** Both AI features (generation + judgment) have their keys configured. */
  readonly keysReady: boolean;
  /** The app URL to put in the commands, when the repo's environments file names a real one. */
  readonly appUrl?: string;
  /** A non-production environment name from `.jevitate/environments.json`, for `demo --env`. */
  readonly env?: string;
  /** The MCP registration report; undefined when `--skip-mcp`. */
  readonly mcp?: readonly McpInstallReport[];
  /** Whether skills were installed (false under `--skip-skills`). */
  readonly skills: boolean;
  readonly dryRun: boolean;
}

const REGISTERED = new Set(["create", "update", "unchanged", "force-update"]);

/**
 * The ≤5 "try this next" lines `jevitate init` prints (and returns as `data.nextSteps`). Every
 * command is a real one with real flags (skills-cli-drift.test.ts checks them against the CLI);
 * placeholders are `<…>` so nothing reads as a value we guessed. Tailored, never silent:
 *  - keys ready → a goal run, an authored Journey and a demo (all need the model gateway);
 *  - keys missing → the key-free adversarial run (`--fake-ai`: misuse is planned in code, the
 *    findings are hard signals), a human-recorded flow, and how to add the keys;
 *  - the agent line says whether the MCP server was registered, declined (conflict), or skipped.
 */
export function initNextSteps(input: InitNextStepsInput): string[] {
  const url = input.appUrl ?? "<app-url>";
  const env = input.env ?? "<env>";
  const lines: string[] = [];
  if (input.keysReady) {
    lines.push(`1. try it:     jevitate explore --url ${url} --goal "<a task a user does>" --success "urlIncludes:<done-path>" --real`);
    lines.push(`2. keep it:    jevitate explore-author-journey --url ${url} --goal "<task>" --success "<check>" --id <id> --name "<name>" --real`);
    lines.push(`3. demo it:    jevitate demo "<aspect>" --env ${env} --success "<check>" --real`);
  } else {
    lines.push(`1. try it:     jevitate explore --strategy adversarial --url ${url} --fake-ai   (no keys: finds 5xx, crashes, hangs)`);
    lines.push(`2. record it:  jevitate record --url ${url}   (you click; Enter saves a replayable Recording)`);
    lines.push("3. add keys:   jevitate ai setup generation && jevitate ai setup judgment   (goals, Journeys, demos)");
  }
  lines.push("4. gate CI:    jevitate check --suite <suite.json>   (JUnit + SARIF; exit 1 = a gating finding)");
  const agent = agentLine(input);
  if (agent !== undefined) lines.push(agent);
  return lines;
}

function agentLine(input: InitNextStepsInput): string | undefined {
  const would = input.dryRun ? "would be " : "";
  if (input.mcp !== undefined && input.mcp.length > 0) {
    const ok = input.mcp.filter((r) => REGISTERED.has(r.action)).map((r) => r.target);
    const declined = input.mcp.filter((r) => !REGISTERED.has(r.action)).map((r) => r.target);
    if (ok.length > 0) {
      return `agents: MCP server ${would}registered for ${ok.join(", ")}${declined.length > 0 ? ` (not ${declined.join(", ")}: see above)` : ""} — restart the agent, then ask in plain words`;
    }
    return `agents: MCP server NOT registered (${declined.join(", ")}: existing config kept) — rerun with --force, or: jevitate mcp --print-config claude`;
  }
  if (input.skills) {
    return "agents: skills installed (CLI) — for MCP tools too: jevitate mcp --print-config claude|cursor|codex|json";
  }
  return undefined;
}

/**
 * Reads `.jevitate/environments.json` for the next-steps block: the first non-production
 * environment's name, and its `baseUrl` only when it is not the untouched scaffold's (so the block
 * never presents the example `http://localhost:3000` as "your app"). Unreadable → nothing: the
 * block keeps its `<app-url>`/`<env>` placeholders.
 */
export function environmentHint(projectDir: string | null): { appUrl?: string; env?: string } {
  if (projectDir === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(projectDir, ENVIRONMENTS_FILE), "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (name.startsWith("$") || entry === null || typeof entry !== "object") continue;
    const e = entry as { baseUrl?: unknown; production?: unknown };
    if (e.production === true) continue;
    const baseUrl = typeof e.baseUrl === "string" ? e.baseUrl : undefined;
    const isScaffold = name === "local" && baseUrl === ENVIRONMENTS_SCAFFOLD.local.baseUrl;
    return { env: name, ...(baseUrl !== undefined && !isScaffold ? { appUrl: baseUrl } : {}) };
  }
  return {};
}
