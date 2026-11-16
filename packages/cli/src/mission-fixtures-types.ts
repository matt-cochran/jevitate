import type { AuthSources, RequestAuth } from "./fixture-auth.js";

export interface FixtureHttpStep {
  readonly name?: string;
  readonly method: string;
  /** Absolute, or relative to the mission's start URL. May reference `${setup.<name>}` (not in its origin). */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly body?: string;
  readonly auth?: RequestAuth;
  /** Accepted statuses. Default: any 2xx. */
  readonly expectStatus?: readonly number[];
  /** Output name → `$.json.path` (JSONPath-lite) or `header:<name>`. */
  readonly outputs?: Readonly<Record<string, string>>;
  /** Output names that are credentials: redacted everywhere, never substituted into model-visible text. */
  readonly secretOutputs?: readonly string[];
  readonly timeoutMs?: number;
}

export interface FixtureSpec {
  readonly name?: string;
  readonly setup: readonly FixtureHttpStep[];
  readonly restore: readonly FixtureHttpStep[];
}

/** The operator's own shell hooks (CLI flags; never from a file or a model). */
export interface ShellHooks {
  readonly before?: string;
  readonly after?: string;
  readonly timeoutMs?: number;
}

export class FixtureSpecError extends Error {
  readonly code = "E_FIXTURE_SPEC" as const;
  constructor(message: string) {
    super(message);
    this.name = "FixtureSpecError";
  }
}

/** Setup failed: the run must end `inconclusive` (a configuration error) without touching the app. */
export class FixtureSetupError extends Error {
  readonly code = "E_FIXTURE_SETUP" as const;
  constructor(detail: string) {
    super(`fixture setup failed: ${detail}`);
    this.name = "FixtureSetupError";
  }
}

export interface FixtureBounds {
  readonly allowlist: readonly string[];
  /** What a relative step URL resolves against (the mission's start URL). */
  readonly baseUrl: string;
  /**
   * #560/#561: rewrites every resolved step URL (setup and restore) before the allowlist check and
   * fetch — e.g. map a recorded origin onto the one this run may actually reach.
   */
  readonly rebaseUrl?: (absoluteUrl: string) => string;
}

/** The output names visible to a step being parsed; `setup` is null when a `--before` hook may bind more. */
export interface KnownOutputs {
  readonly setup: Set<string> | null;
  /** Restore outputs bound by EARLIER steps of the same restore pass (#560). */
  readonly restore: Set<string>;
}

/** A setup's bound outputs: values, and which of them are secrets. */
export interface FixtureBindings {
  readonly values: Readonly<Record<string, string>>;
  readonly secretNames: ReadonlySet<string>;
}

export class UnboundSetupRefError extends Error {
  readonly code = "E_FIXTURE_REF" as const;
  constructor(message: string) {
    super(message);
    this.name = "UnboundSetupRefError";
  }
}

/** A `${restore.x}` used outside a restore pass, or one no earlier restore step bound (#560). */
export class UnboundRestoreRefError extends Error {
  readonly code = "E_FIXTURE_REF" as const;
  constructor(message: string) {
    super(message);
    this.name = "UnboundRestoreRefError";
  }
}

/** One step of setup/restore, as recorded in the result (redacted; never headers or bodies). */
export interface FixtureStepLog {
  readonly phase: "setup" | "restore";
  readonly kind: "http" | "shell";
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly method?: string;
  readonly url?: string;
  readonly status?: number;
  readonly exitCode?: number | null;
  readonly detail?: string;
  /** A shell hook's stderr, redacted and clipped (stdout is never persisted). */
  readonly stderr?: string;
}

/** What the result/Recording carries: identity + non-secret outputs; secrets by NAME only. */
export interface FixtureRecord {
  /** Hash of the spec (+ hook commands) and the bound outputs (secret outputs by name only). */
  readonly identity: string;
  /** Hash of the spec (+ hook commands) alone: equal across runs of the same fixture. */
  readonly specHash: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly secretOutputs: readonly string[];
  /** Setup/restore cycles run (1 for the mission + one per replay). */
  readonly cycles: number;
  readonly log: readonly FixtureStepLog[];
}

/** What a mission result persists so `verify-fix`/regression capture restore the SAME state. */
export interface PersistedFixtures {
  readonly identity: string;
  readonly specHash: string;
  readonly spec?: FixtureSpec;
  /** sha256 of each operator hook command — the commands themselves are re-supplied, never replayed from a file. */
  readonly hooks?: { readonly before?: string; readonly after?: string };
  readonly outputs: Readonly<Record<string, string>>;
  readonly secretOutputs: readonly string[];
  /**
   * #243: the fixture identities the steps authenticated as → their storageState PATHS (never the
   * contents), so `verify-fix`/regression capture re-mint as the same identities.
   */
  readonly identities?: Readonly<Record<string, string>>;
}

export interface FixtureRunOptions extends FixtureBounds {
  readonly spec?: FixtureSpec;
  readonly hooks?: ShellHooks;
  /** Required to run `hooks` at all (CLI `--allow-shell-hooks`). */
  readonly allowShellHooks?: boolean;
  readonly auth: AuthSources;
  /** The run's own secrets: redacted from everything a fixture logs. */
  readonly secrets?: readonly string[];
  /** Testing seam. */
  readonly fetchImpl?: typeof fetch;
}

export interface HookResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}
