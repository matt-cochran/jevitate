import { clickTimeoutMs } from "@jevitate/explore";
import { governanceFromEnv, pageUnresponsiveMsFromEnv } from "@jevitate/playwright";

/**
 * Numeric `JEVITATE_*` tuning variables are validated ONCE, when the CLI starts, so a typo is a
 * usage error (exit 64) before any browser opens — never a crash mid-run on the first click, and
 * never a silent fall back to the default.
 *
 * Returns the problems found (empty when every set variable is valid).
 */
export function runtimeEnvProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  // #205: JEVITATE_RESOURCE_GOVERNANCE / JEVITATE_MAX_BROWSERS / JEVITATE_MAX_BROWSER_MEMORY_MB.
  for (const check of [pageUnresponsiveMsFromEnv, clickTimeoutMs, governanceFromEnv]) {
    try {
      check(env);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  return problems;
}
