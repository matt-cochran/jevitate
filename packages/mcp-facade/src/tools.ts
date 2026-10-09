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
  // #433 — the read-only catalog sheets (personas, jobs) and coverage. Approving a persona or a job
  // is a person's act on the CLI: approve_persona / approve_job are FORBIDDEN below.
  "review_persona", "review_job", "catalog_status",
  // #435 — the read-only, advisory catalog analysis (conflicts, duplicates, gaps; GtWR set characteristics).
  "analyze_catalog",
  // 0.10 (d-surface-0, reviewed once up front; each mirrors its CLI command — packages/cli/src/mcp-cli-tools.ts):
  // #465 — draft 1-3 job outcomes as provenance ai_draft for the team to review. Never approves
  // (approve_job stays FORBIDDEN).
  "draft_job_outcomes",
  // #470 — read-only, advisory locator health (check's opt-in gate is run_check maxBrittleSteps).
  "locator_health",
  // #464 — export the Journeeze catalog bundle (writes only inside the project; never uploads or approves),
  // and publish it. publish_to_journeeze takes NO key argument: jevitate resolves the upload key itself
  // (secret store / CI env) and never returns it. Connecting (entering the key) is CLI only: connect_journeeze is FORBIDDEN.
  "export_catalog_bundle", "publish_to_journeeze",
] as const;

export const FORBIDDEN_TOOLS = [
  "browser_click", "browser_fill", "page_evaluate", "run_selector",
  "navigate_url", "get_dom", "get_cookies",
  // #433: catalog sign-off is human-only (`jevitate persona|job approve` on the CLI).
  "approve_persona", "approve_job",
  // #464: entering a Journeeze upload key is a person's act at their terminal (`jevitate connect journeeze`):
  // a key never passes through a model or an MCP argument.
  "connect_journeeze",
] as const;

export function listToolNames(): string[] {
  return [...ALLOWED_TOOLS];
}
