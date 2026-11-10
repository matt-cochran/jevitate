/**
 * Contract 4 of 0.30.0 (docs/design/0.30.0-evidence-and-trust.md §5): run modes and target trust.
 *
 * The mode is a function of human-written target configuration and nothing else. No argument on any
 * command or MCP tool names it, and a target the configuration does not know runs in automation mode,
 * the stricter one. `trust` is declared in the repo's `.jevitate/environments.json`
 * (`environments[name].trust`, committed and PR-reviewed) and in the operator's
 * `~/.jevitate/targets.json` (`[origin].trust`). When both name an origin the stricter wins
 * (`production` > `unknown` > `harness` > `test`), so a repo file cannot declare test mode for an
 * origin the operator's file calls production. `production: true` is honoured as
 * `trust: "production"`; `synthetic: true` says something about data, not trust, and implies nothing.
 *
 * This module is a leaf (no imports) so both config parsers can use its vocabulary.
 */

export type RunMode = "test" | "automation";

export type TargetTrust =
  /** A declared test environment that can be reset; drafts may run; never waits for a person. */
  | "test"
  /** #802: a UI harness over a mock backend; feasibility only, never a job verdict. */
  | "harness"
  /** `production: true`; refusals as today, `mcpRun` lifts them per origin. */
  | "production"
  /** Nothing declared this origin. */
  | "unknown";

/** The values a file may declare for `trust`. `unknown` is the absence of a declaration, never written. */
export const DECLARABLE_TRUST: readonly Exclude<TargetTrust, "unknown">[] = Object.freeze(["test", "harness", "production"]);

/** Stricter is higher. */
const STRICTNESS: Readonly<Record<TargetTrust, number>> = Object.freeze({ test: 0, harness: 1, unknown: 2, production: 3 });

export function isDeclarableTrust(v: unknown): v is Exclude<TargetTrust, "unknown"> {
  return typeof v === "string" && (DECLARABLE_TRUST as readonly string[]).includes(v);
}

/** The refusal text for a bad `trust` value at `where` (the value is not echoed beyond its JSON form). */
export function trustRefusal(where: string, got: unknown): string {
  return `${where}.trust must be one of ${DECLARABLE_TRUST.map((t) => JSON.stringify(t)).join(", ")} (got ${JSON.stringify(got) ?? String(got)})`;
}

/** The run mode for a target's trust. Takes the trust only: nothing a caller passes can choose the mode. */
export function runModeFor(trust: TargetTrust): RunMode {
  return trust === "test" || trust === "harness" ? "test" : "automation";
}

/** The stricter of two trusts. */
export function stricterTrust(a: TargetTrust, b: TargetTrust): TargetTrust {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/** The part of an `environments.json` entry trust reads (an `EnvironmentDef` fits). */
export interface TrustEnvironment {
  readonly baseUrl: string;
  readonly origins?: Readonly<Record<string, string>>;
  readonly production?: boolean;
  readonly trust?: TargetTrust;
}

/** The part of a `targets.json` entry trust reads (a `TargetConfig` fits): the entry for `origin`. */
export interface TrustTargetConfig {
  readonly trust?: TargetTrust;
}

export interface TargetTrustRequest {
  /** The named environment the run uses, if any. */
  readonly environment?: TrustEnvironment;
  /** The operator's `targets.json` entry for `origin`, if any. */
  readonly targetConfig?: TrustTargetConfig;
  /** The origin the run goes to. */
  readonly origin: string;
}

function originKey(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".")) u.hostname = u.hostname.replace(/\.+$/, "");
    return u.origin;
  } catch {
    return undefined;
  }
}

/**
 * The trust of the target a run goes to. PURE.
 *
 * - The environment's `production: true` counts as `trust: "production"`, and a production
 *   declaration (either way) holds whatever origin the run goes to: it only ever tightens.
 * - The environment's `test` or `harness` loosens only its own origins (`baseUrl` and its named
 *   `origins`, not `allow`): a `--base-url` onto another origin is not what the file vouches for.
 * - Each declaration that applies is a candidate; the stricter wins. None applies: `unknown`.
 */
export function resolveTargetTrust(req: TargetTrustRequest): TargetTrust {
  const declared: TargetTrust[] = [];
  const env = req.environment;
  if (env !== undefined) {
    if (env.production === true) declared.push("production");
    if (env.trust === "production" || env.trust === "unknown") declared.push(env.trust);
    else if (env.trust !== undefined) {
      const wanted = originKey(req.origin);
      const own = [env.baseUrl, ...Object.values(env.origins ?? {})].map(originKey);
      if (wanted !== undefined && own.includes(wanted)) declared.push(env.trust);
    }
  }
  if (req.targetConfig?.trust !== undefined) declared.push(req.targetConfig.trust);
  return declared.length === 0 ? "unknown" : declared.reduce(stricterTrust);
}
