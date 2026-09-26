/**
 * The `jevitate check --suite` item option set (#195), declared ONCE against `jevitate explore`'s
 * own options. Every explore option (by its commander attribute name) is in exactly one of:
 *
 *  - `SUITE_EXPLORE_OPTIONS` — generic options a target (as a default) and a goal/mission item (as
 *    an override) take under the SAME camelCase name; parsed, typed and validated by
 *    `check-suite.ts` from this table, and applied by `check-api.ts` exactly as `explore` applies
 *    the flag;
 *  - `SUITE_DEDICATED_EXPLORE_OPTIONS` — options the suite already had a dedicated field for
 *    (`url`, `goal`, `success`, `routes`, `secretFields`, …);
 *  - `SUITE_EXCLUDED_EXPLORE_OPTIONS` — options that make no sense per item, with the reason.
 *
 * `suite-explore-options.test.ts` builds the real `explore` command and fails when an option is in
 * none of them (a new explore flag must be decided here), or when a table's shape disagrees with
 * the flag's own (a repeatable flag is a list here, a switch a boolean).
 *
 * Secrets: no option here carries a literal secret. `secret` takes `env:<VAR>` references only;
 * `totp` (like `secretFields`) takes `<descriptor>=env:<VAR>` bindings only — both resolved from
 * the environment when the check starts, never written in the suite.
 */

/** What a suite item is run as: a goal item, or a mission item's strategy. */
export type ExploreItemKind = "goal" | "coverage" | "exploratory" | "adversarial" | "feature" | "usability";
export const ALL_KINDS: readonly ExploreItemKind[] = ["goal", "coverage", "exploratory", "adversarial", "feature", "usability"];

export type SuiteOptionShape =
  /** a non-empty string */
  | "string"
  /** an array of non-empty strings (a repeatable flag) */
  | "strings"
  | "boolean"
  /** a positive number */
  | "positive"
  /** a positive integer */
  | "integer"
  /** a non-negative integer */
  | "count"
  /** a number in 0..1 */
  | "ratio"
  /** a file path, resolved against the suite file's directory */
  | "path"
  /** `<name>=<storageState path>` entries, the path resolved against the suite file's directory */
  | "named-paths"
  /** `env:<VAR>` references (never a literal value) */
  | "env-refs"
  /** `<descriptor>=env:<VAR>` bindings (never a literal value) */
  | "env-bindings";

export interface SuiteExploreOption {
  readonly shape: SuiteOptionShape;
  /** The item kinds the option applies to (as on `explore`); an item setting it elsewhere is refused. */
  readonly appliesTo: readonly ExploreItemKind[];
  /** Allowed values, for an enum-like string. */
  readonly oneOf?: readonly string[];
  /** Inclusive range, for an integer. */
  readonly range?: readonly [number, number];
}

const GOAL_UX: readonly ExploreItemKind[] = ["goal", "usability"];
const OVERFLOW: readonly ExploreItemKind[] = ["coverage", "exploratory", "adversarial", "usability"];

export const SUITE_EXPLORE_OPTIONS = {
  // usability review
  show: { shape: "string", appliesTo: ["usability"] },
  minConfidence: { shape: "ratio", appliesTo: ["usability"] },
  maxFindingsPerPage: { shape: "integer", appliesTo: ["usability"], range: [1, 1000] },
  // containment
  scope: { shape: "string", appliesTo: ["coverage", "exploratory"], oneOf: ["app"] },
  // secrets and sessions
  secret: { shape: "env-refs", appliesTo: ["goal", "adversarial", "usability"] },
  totp: { shape: "env-bindings", appliesTo: GOAL_UX },
  fixture: { shape: "path", appliesTo: GOAL_UX },
  actor: { shape: "named-paths", appliesTo: ["goal"] },
  saveStorageState: { shape: "path", appliesTo: ALL_KINDS },
  persona: { shape: "named-paths", appliesTo: ALL_KINDS },
  personas: { shape: "path", appliesTo: ALL_KINDS },
  // pacing and conversation
  stallTimeout: { shape: "positive", appliesTo: ["coverage", "exploratory", "feature"] },
  replyWaitMs: { shape: "integer", appliesTo: GOAL_UX },
  replyCeilingMs: { shape: "integer", appliesTo: GOAL_UX },
  replyMaxChars: { shape: "integer", appliesTo: GOAL_UX, range: [20, 2000] },
  jobWaitMs: { shape: "integer", appliesTo: GOAL_UX },
  // safety, settle, timing (the target config explore builds from its flags)
  deny: { shape: "strings", appliesTo: ALL_KINDS },
  paid: { shape: "strings", appliesTo: ALL_KINDS },
  allowDestructive: { shape: "boolean", appliesTo: ALL_KINDS },
  allowWrites: { shape: "boolean", appliesTo: ALL_KINDS },
  allowWrite: { shape: "strings", appliesTo: ALL_KINDS },
  readRpc: { shape: "strings", appliesTo: ALL_KINDS },
  hangReplayWrites: { shape: "boolean", appliesTo: ALL_KINDS },
  settleIgnore: { shape: "strings", appliesTo: ALL_KINDS },
  longPollMs: { shape: "integer", appliesTo: ALL_KINDS },
  apiPrefix: { shape: "strings", appliesTo: ALL_KINDS },
  ignoreNoProgress: { shape: "strings", appliesTo: ALL_KINDS },
  hangReplays: { shape: "count", appliesTo: ["goal", "adversarial"] },
  // adversarial coverage thresholds
  minControlCoverage: { shape: "ratio", appliesTo: ["adversarial"] },
  requireFormSubmit: { shape: "boolean", appliesTo: ["adversarial"] },
  // backend logs (#142)
  logSource: { shape: "strings", appliesTo: ALL_KINDS },
  allowLogCmd: { shape: "boolean", appliesTo: ALL_KINDS },
  logDefect: { shape: "strings", appliesTo: ALL_KINDS },
  logQuietOk: { shape: "strings", appliesTo: ALL_KINDS },
  logIgnore: { shape: "strings", appliesTo: ALL_KINDS },
  serverLogDrainMs: { shape: "integer", appliesTo: ALL_KINDS },
  // horizontal overflow (#149)
  checkOverflow: { shape: "boolean", appliesTo: OVERFLOW },
  ignoreOverflow: { shape: "strings", appliesTo: OVERFLOW },
  // mission fixtures' shell hooks (#144); the fixtures file itself is the dedicated `fixtures`
  before: { shape: "string", appliesTo: ["goal"] },
  after: { shape: "string", appliesTo: ["goal"] },
  allowShellHooks: { shape: "boolean", appliesTo: ["goal"] },
  hookTimeoutMs: { shape: "integer", appliesTo: ["goal"] },
} as const satisfies Record<string, SuiteExploreOption>;

export type SuiteExploreOptionName = keyof typeof SUITE_EXPLORE_OPTIONS;

interface ShapeValue {
  string: string;
  strings: readonly string[];
  boolean: boolean;
  positive: number;
  integer: number;
  count: number;
  ratio: number;
  path: string;
  "named-paths": readonly string[];
  "env-refs": readonly string[];
  "env-bindings": readonly string[];
}

/** The parsed generic options of a target (defaults) or an item (overrides) — typed from the table. */
export type SuiteExploreOptions = {
  readonly [K in SuiteExploreOptionName]?: ShapeValue[(typeof SUITE_EXPLORE_OPTIONS)[K]["shape"]];
};

/** Where the suite takes an explore option it has a dedicated field for. */
export interface DedicatedOption {
  /** The suite field name. */
  readonly key: string;
  /** Where it may appear. */
  readonly at: readonly ("target" | "journey" | "goal" | "mission" | "verifyFix")[];
}

export const SUITE_DEDICATED_EXPLORE_OPTIONS: Readonly<Record<string, DedicatedOption>> = {
  url: { key: "url", at: ["target", "goal", "mission"] },
  strategy: { key: "strategy", at: ["mission"] },
  goal: { key: "goal", at: ["goal", "mission"] },
  appClass: { key: "appClass", at: ["mission"] },
  success: { key: "success", at: ["goal"] },
  successWhen: { key: "successWhen", at: ["goal"] },
  feature: { key: "feature", at: ["mission"] },
  route: { key: "routes", at: ["mission"] },
  allow: { key: "allow", at: ["target"] },
  secretField: { key: "secretFields", at: ["target", "goal", "mission"] },
  storageState: { key: "storageState", at: ["target", "journey", "goal", "mission", "verifyFix"] },
  fixtures: { key: "fixtures", at: ["target", "goal"] },
  invariants: { key: "invariants", at: ["target"] },
  maxActions: { key: "maxActions", at: ["goal", "mission"] },
  maxDecisions: { key: "maxDecisions", at: ["goal", "mission"] },
  viewport: { key: "viewport", at: ["target", "journey", "goal", "mission"] },
  device: { key: "device", at: ["target", "journey", "goal", "mission"] },
};

export const SUITE_EXCLUDED_EXPLORE_OPTIONS: Readonly<Record<string, string>> = {
  browserExecutable: "a check launches every item's browser the same way: pass --browser-executable to `jevitate check`",
  browserChannel: "a check launches every item's browser the same way: pass --browser-channel to `jevitate check`",
  browserArg: "a check launches every item's browser the same way: pass --browser-arg to `jevitate check`",
  real: "one model gateway per check: the suite's `ai` or `jevitate check --real`",
  fakeAi: "one model gateway per check: the suite's `ai` or `jevitate check --fake-ai`",
  out: "one output directory per check (`jevitate check --out`); item results go to <out>/results",
  json: "one envelope per check (`jevitate check --json` / --json-out)",
  fileIssues: "a check is a CI gate: findings are reported in JUnit/SARIF/report.md, never filed mid-run",
  issueRepo: "a check is a CI gate: findings are reported in JUnit/SARIF/report.md, never filed mid-run",
  jevitateRepo: "a check is a CI gate: findings are reported in JUnit/SARIF/report.md, never filed mid-run",
  repeat: "a check gates each item once by finding identity; track flakes across checks with --baseline",
  minAgreement: "a check gates each item once by finding identity; track flakes across checks with --baseline",
};

/** Suite key of a generic option (the explore attribute name itself). */
export function isSuiteExploreOption(key: string): key is SuiteExploreOptionName {
  return Object.prototype.hasOwnProperty.call(SUITE_EXPLORE_OPTIONS, key);
}

/**
 * The effective options of one item: the target's defaults for its kind, overridden key by key by
 * the item's own (an item value REPLACES the target's, lists included).
 */
export function effectiveExploreOptions(target: SuiteExploreOptions | undefined, item: SuiteExploreOptions | undefined, kind: ExploreItemKind): SuiteExploreOptions {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(target ?? {})) {
    if (isSuiteExploreOption(k) && (SUITE_EXPLORE_OPTIONS[k].appliesTo as readonly ExploreItemKind[]).includes(kind)) out[k] = v;
  }
  for (const [k, v] of Object.entries(item ?? {})) out[k] = v;
  return out as SuiteExploreOptions;
}
