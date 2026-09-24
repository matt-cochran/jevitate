export const ALLOWED_TOOLS = [
  "queue_retrieval", "queue_action", "get_command", "list_incoming",
  "get_thread", "approve_action", "cancel_command", "get_site_health",
  "find_capabilities", "run_journey", "ai_generate_text", "queue_exploration",
  "get_mission_result", "verify_fix",
] as const;

export const FORBIDDEN_TOOLS = [
  "browser_click", "browser_fill", "page_evaluate", "run_selector",
  "navigate_url", "get_dom", "get_cookies",
] as const;

export function listToolNames(): string[] {
  return [...ALLOWED_TOOLS];
}
