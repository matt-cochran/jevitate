import { describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { buildProgram } from "./program.js";
import { walk } from "./cli-surface.js";

/**
 * #254 parity guard: every capability exposed over MCP is also available from the CLI. Each
 * `ALLOWED_TOOLS` entry maps to the CLI command path that exposes it (approve/cancel map to their
 * documented human-only refusals — `inbox approve`/`inbox cancel` refuse exactly as MCP does), and
 * every mapped path must exist in the real commander tree. A new MCP tool without a CLI mapping —
 * or a mapped command that was removed — fails here.
 */
const MCP_TO_CLI: Readonly<Record<(typeof ALLOWED_TOOLS)[number], string>> = {
  list_incoming: "inbox list",
  get_thread: "inbox show",
  get_command: "inbox command",
  queue_retrieval: "inbox queue-retrieval",
  queue_action: "inbox queue-action",
  get_site_health: "inbox health",
  approve_action: "inbox approve", // human-only: always refused (E_HUMAN_APPROVAL_REQUIRED) — approve in `jevitate ui`
  cancel_command: "inbox cancel", // human-only: always refused (E_HUMAN_APPROVAL_REQUIRED) — cancel in `jevitate ui`
  find_capabilities: "journey find",
  run_journey: "journey run",
  ai_generate_text: "ai generate",
  queue_exploration: "mission queue",
  get_mission_result: "mission result",
  verify_fix: "verify-fix",
};

describe("#254: every MCP tool has a CLI command", () => {
  const paths = new Set(walk(buildProgram({ profiles: new ProfileManager("/unused-in-parity") }), "").map((s) => s.path));

  it("maps every ALLOWED_TOOLS entry (and nothing else)", () => {
    const mapped = Object.keys(MCP_TO_CLI).sort();
    expect(mapped, "a new MCP tool needs a CLI command and an entry here").toEqual([...ALLOWED_TOOLS].sort());
  });

  it.each(Object.entries(MCP_TO_CLI))("%s → jevitate %s exists", (_tool, path) => {
    expect(paths.has(path), `jevitate ${path} is not a registered command`).toBe(true);
  });
});
