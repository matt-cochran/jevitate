export const ALLOWED_TOOLS = [
  "queue_retrieval", "queue_action", "get_command", "list_incoming",
  "get_thread", "approve_action", "cancel_command", "get_site_health",
  "find_capabilities", "run_journey", "ai_generate_text", "queue_exploration",
  "get_mission_result", "verify_fix",
  // #255 — MCP ⊇ CLI: one tool (or one action family) per CLI command an agent could run itself.
  // Each mirrors its command exactly (packages/cli/src/mcp-cli-tools.ts); the human-only
  // approve_action / cancel_command above still always refuse.
  "list_journeys", "promote_journey", "annotate_journey", "demo_journey", "publish_journey",
  "create_demo", "approve_demo", "run_exploration", "author_journey", "run_check", "get_report",
  "diff_runs", "baselines", "ledger", "run_load_test", "prune_logs", "run_queued_missions",
  "mission_targets", "profiles", "recordings", "regressions", "site_policy", "sources",
  "ux_review", "validate_invariants", "get_ai_status",
  // #293 — journey-anchored exploration: a Journey's anchors, and a campaign of anchored missions.
  "journey_anchors", "run_campaign",
  // #401 — the assertion-strength lint promote_journey applies; #402 — its mutation proof.
  "lint_journey", "verify_journey",
  // #425 — a sweep: many explore missions over a targets file, one aggregated result.
  "run_sweep",
  // #432 — the read-only review sheet a person reads before promote_journey (bound by its content hash).
  "review_journey",
] as const;

export const FORBIDDEN_TOOLS = [
  "browser_click", "browser_fill", "page_evaluate", "run_selector",
  "navigate_url", "get_dom", "get_cookies",
] as const;

export function listToolNames(): string[] {
  return [...ALLOWED_TOOLS];
}
