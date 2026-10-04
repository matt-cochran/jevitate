import { MISSION_EXIT_CODES, type MissionOutcome } from "@jevitate/domain";

/**
 * THE exit-code table for every `jevitate` command (#210) — documented once, in
 * docs/outcomes.md "Exit codes", and linked from everywhere else. Every command sets
 * `process.exitCode` from this table (directly, or through `exitCodeForError` for a refused
 * command), so CI can tell a typo from a defect from a run that proved nothing:
 *
 *  | code | class         | meaning                                                                        |
 *  |------|---------------|--------------------------------------------------------------------------------|
 *  | 0    | ok            | clean · succeeded · check passed · fixed · the command did what it was asked   |
 *  | 1    | defects       | defects found · a gating finding · still reproduces · a success check failed   |
 *  | 2    | inconclusive  | the run/command could not finish its work (inconclusive, crashed, an item      |
 *  |      |               | errored, budget exceeded, an unexpected error) — it proves nothing             |
 *  | 3    | hang          | the app under test hung, and the hang reproduced on replay                     |
 *  | 4    | intermittent  | a signal fired on some but not every replay                                    |
 *  | 64   | usage         | bad flags/arguments or unusable input (unknown id, invalid file, missing keys, |
 *  |      |               | refused target) — nothing ran. `EX_USAGE` from sysexits.h.                     |
 *  | 129/130/143 | killed | SIGHUP (or parent death) / SIGINT / SIGTERM (kill-signal.ts); partial result written |
 *
 * 0–4 are the pre-existing mission codes (`MISSION_EXIT_CODES`, @jevitate/domain) unchanged; the
 * mission outcome → code mapping stays THERE (one place), and this table only names the classes.
 * Usage errors get 64 rather than the next small integer so a future outcome code (5, 6, …) never
 * collides with it.
 */
export const EXIT_CODES = {
  ok: 0,
  defects: 1,
  inconclusive: 2,
  hang: 3,
  intermittent: 4,
  usage: 64,
} as const;

export type ExitClass = keyof typeof EXIT_CODES;

/** A canonical mission outcome's exit code (the domain table; re-exported so commands import one module). */
export function exitCodeForOutcome(outcome: MissionOutcome): number {
  return MISSION_EXIT_CODES[outcome];
}

/**
 * Error codes that mean "the invocation or its input was unusable; nothing ran" → `usage` (64).
 * Matched by suffix/prefix so a new `E_<COMMAND>_ARGS`/`_INPUT`/… code classifies itself.
 */
const USAGE_ERROR_PATTERNS: readonly RegExp[] = [
  /_ARGS$/, // E_EXPLORE_ARGS, E_VERIFY_FIX_ARGS, E_JOURNEY_RUN_ARGS, …
  /_INPUT$/, // E_LEDGER_INPUT, E_REPORT_INPUT, E_VERIFY_FIX_INPUT
  /_ASSERTION$/, // E_EXPLORE_ASSERTION (an unparseable --success)
  /_SPEC$/, // E_FIXTURE_SPEC, E_LOG_SPEC, E_LOG_SOURCE_SPEC
  /_REF$/, // E_FIXTURE_REF
  /_CONFIG$/, // E_TARGET_CONFIG, E_FILING_CONFIG, E_UX_CONFIG, …
  /^E_INVALID_/, // E_INVALID_PARAMS, E_INVALID_RECORDING, …
  /_UNKNOWN(_|$)/, // E_UNKNOWN_JOURNEY, E_SOURCE_UNKNOWN, E_JOURNEY_PUBLISH_UNKNOWN_SOURCE, …
  /^E_UNKNOWN_/,
  /_NOT_FOUND$/, // E_LEDGER_NOT_FOUND, E_REGRESSION_NOT_FOUND
  /_INVARIANTS$/, // E_INVARIANTS, E_EXPLORE_INVARIANTS, E_USABILITY_INVARIANTS (invalid invariant files)
];

const USAGE_ERROR_CODES: ReadonlySet<string> = new Set([
  "E_CHECK_SUITE", // the suite (or its preflight) was refused
  "E_AI_SETUP_REQUIRED", // no keys / no gateway selected
  "E_MISSING_CREDENTIAL",
  "E_UNAUTHORIZED_EXPLORE_TARGET", // the target is outside the allowlist
  "E_EXPLORE_FIXTURE", // --fixture names no fixture
  "E_SELF_HEAL_MODE",
  "E_UX_MIN_CONFIDENCE",
  "E_UX_MAX_FINDINGS_PER_PAGE",
  "E_UX_QUALITY_POLICY",
  "E_UX_NO_APP_CONTEXT",
  "E_JOURNEY_REQUIRES_AUTH",
  "E_ENV_ORIGIN_REFUSED", // #247: a Journey step on an origin the chosen environment does not allow
  "E_PROFILE_UNKNOWN", // `profile status` named a profile that was never created
  "E_REGRESSION_EXISTS", // `regression capture --id` already exists; needs --force
  "E_REGRESSION_HARD_SIGNAL", // `regression capture --fingerprint` names a hard-signal defect; use the ledger instead
  "E_JOURNEY_ANNOTATIONS_STALE", // `journey annotate --approve`: the Journey changed since the draft; re-draft
  "E_DEMO_PRODUCTION_ENV", // #249: `demo` refuses an environment flagged production: true
  "E_DEMO_EXISTS", // #249: `demo` would overwrite an existing Journey / pending demo draft
  "E_HUMAN_APPROVAL_REQUIRED", // #254: `inbox approve`/`cancel` — human-only, in `jevitate ui` (MCP's human_approval_required)
  "E_INBOX_INPUT_PENDING", // #254: `inbox command` would consume a human's unread input; pass --reveal to receive it
  "E_MISSION_QUEUE_REFUSED", // #254: `mission queue` — unknown/unpromoted target, bad shape, over-ceiling budget, invalid invariants
]);

/** True when a refused command's error code is a usage/input error (exit 64). */
export function isUsageErrorCode(code: string): boolean {
  return USAGE_ERROR_CODES.has(code) || USAGE_ERROR_PATTERNS.some((p) => p.test(code));
}

/** A refused command's exit code: 64 for a usage/input error, else 2 (the command could not finish). */
export function exitCodeForError(code: string): number {
  return isUsageErrorCode(code) ? EXIT_CODES.usage : EXIT_CODES.inconclusive;
}

/** The exit code for a `{ok, error?}` envelope that carries no verdict of its own. */
export function exitCodeForEnvelope(envelope: { readonly ok: boolean; readonly error?: { readonly code: string } }): number {
  if (envelope.ok) return EXIT_CODES.ok;
  return exitCodeForError(envelope.error?.code ?? "");
}
