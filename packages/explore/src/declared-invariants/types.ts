import type { Page } from "playwright";
import type { EvalValue, ObservedValue } from "@jevitate/recording";

/**
 * A value as it appears in a finding: the observed scalar, that it could not be read, or — for a
 * `[*]` list (#147) — only its size (a leaked list is never re-leaked item by item).
 */
export type InvariantValue = ObservedValue | { readonly unreadable: true } | { readonly items: number };

export interface InvariantAction {
  /** The op acted (`click`, `type`, …); null for a check with no action (a seed load). */
  readonly op: string | null;
  /** The acted control's accessible name (null when target-free). */
  readonly control: string | null;
  /** The page URL the action was taken on. */
  readonly url: string;
  /**
   * The mission's own real step index for this action (the mission's transcript/recording step
   * count), when the caller tracks one — e.g. `transcript.nextStep` (adversarial), the transcript
   * entry's own `step` (goal-based), or the replayed recording step index (verify-fix). Evidence
   * cites THIS step, never the monitor's internal action tally (#212 item 4): the monitor only
   * hears about a subset of steps (the ones its `when` gates apply to), so its own count runs well
   * behind the mission's real step index and mislabels evidence ("step 13" for what the mission
   * itself recorded as step 30). Falls back to the internal tally when a caller omits it.
   */
  readonly step?: number;
}

/** #147: which actors a cross-actor violation is between, and the captured resource it is about. */
export interface CrossActorEvidence {
  /** The actor that created/touched the resource (the primary). */
  readonly owner: string;
  /** The actor that could see it (or was not denied it). */
  readonly observer: string;
  /** The capture the check was gated on, and its value (clipped, redacted when it matches a secret). */
  readonly capture: string;
  readonly resource: string;
}

export interface InvariantViolation {
  readonly id: string;
  readonly kind: "require" | "never" | "always" | "deniedAs";
  /** The expression (require), or the never/always check, as declared. */
  readonly expression: string;
  /** Before/after of every observable the expression reads (redacted, truncated). */
  readonly values: Record<string, { readonly before: InvariantValue; readonly after: InvariantValue }>;
  /** The triggering action (null for a `never` seen with no action). */
  readonly action: { readonly op: string | null; readonly control: string | null } | null;
  readonly route: string;
  /** Redacted URL the violation is attributed to. */
  readonly url: string;
  /** One line: which invariant, and the values that broke it. */
  readonly reason: string;
  /** `invariantFingerprint(url, reason, id)`: id + route. */
  readonly fingerprint: string;
  /** Redacted probe/network evidence (method, URL, status — never a body). */
  readonly evidence: string[];
  /** For a `settle` invariant: how long it was re-checked before the window closed (ms). */
  readonly settledForMs?: number;
  /** #147: set for a cross-actor violation. */
  readonly crossActor?: CrossActorEvidence;
  /**
   * #195: a `never.response` violation's matching requests (redacted URL, never a body), each with
   * the step it happened in (0: the page load before any action; n: during/after the n-th action).
   */
  readonly responses?: readonly NeverResponseHit[];
}

/** #195: one app response a `never.response` invariant matched, on the mission's own traffic. */
export interface NeverResponseHit {
  readonly method: string;
  /** The full response URL (query included), redacted. */
  readonly url: string;
  readonly status: number;
  /** 0 = the page load before any action; n = the n-th action. */
  readonly step: number;
}

/** Per-invariant tally over a run: an invariant that was never decided proved nothing. */
export interface InvariantReport {
  readonly id: string;
  /** Times it applied (its `when` matched). */
  readonly checked: number;
  readonly held: number;
  readonly violated: number;
  /** Times an observable it reads could not be read — neither a pass nor a violation. */
  readonly unknown: number;
  /** #147: a cross-actor invariant's observer (it runs once, after its capture binds). */
  readonly observer?: string;
  /** #147: why a cross-actor invariant was never decided (never ran, session lost, unreadable). */
  readonly undecided?: string;
}

/**
 * #147 — the observer actors' own pages, each in a FRESH browser context seeded only from that
 * actor's storageState. Opened on first use. Never handed to a model.
 */
export interface ObserverSessions {
  /** The observer's page; throws when its session cannot be opened. */
  page(actor: string): Promise<Page>;
  /**
   * #173 — an observer's storageState `localStorage[key]` for `origin`, read straight from its
   * storageState FILE: no navigation, no live page needed (cheaper, and the token is never logged).
   * Preferred over the observer's live page for `authFrom.localStorage`, whose page a probe-only
   * observer never opens (it is opened lazily and a bare probe never navigates it). Optional: when
   * absent, the live page is read instead (works only once that page has loaded the origin).
   */
  localStorage?(actor: string, key: string, origin: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface InvariantMonitorOptions {
  /** Authorized origins: probes and network reads never leave them. */
  readonly allowlist: readonly string[];
  /** What relative probe paths resolve against (the mission's start URL). */
  readonly baseUrl: string;
  /** Registered secrets: redacted out of every value and evidence line. */
  readonly secrets?: readonly string[];
  /**
   * Resolved `authFrom.secret` refs (#135): `env:VAR` → its value, resolved by the CLI dispatch
   * (this module never reads `process.env`). A probe whose `authFrom.secret` ref is not in here
   * cannot authenticate and reads `unknown` — never silently probed without it.
   */
  readonly authTokens?: ReadonlyMap<string, string>;
  /** Sleep seam for `settle` polling (default `page.waitForTimeout`). */
  readonly sleep?: (page: Page, ms: number) => Promise<void>;
  /** Clock seam (ms). Default `Date.now`. */
  readonly now?: () => number;
  /** #147: the observer actors' sessions; without them a cross-actor invariant is undecided. */
  readonly observers?: ObserverSessions;
  /** #147: the primary actor's name (the owner in a cross-actor finding). Default `"primary"`. */
  readonly primaryActor?: string;
}

export interface AfterOptions {
  /** Evaluate only this invariant id (verify-fix). */
  readonly only?: string;
  /** Ignore `when` (verify-fix re-checks the invariant the original run already found applicable). */
  readonly force?: boolean;
  /**
   * Re-arm: this after-snapshot doubles as the NEXT action's before-snapshot (a loop that observes
   * once per step — the goal mission). Keeps probes to one read per action.
   */
  readonly rearm?: boolean;
  /**
   * Judges an EARLIER action of a sequence that did not wait for it to settle (a submit left
   * pending while the next step ran), once the sequence settled: only its `require`/`always`
   * invariants (no `never`, no cross-actor), the armed before-snapshot is kept for the sequence's
   * own final action, and the action is not counted again.
   */
  readonly earlier?: boolean;
  /**
   * Input values as they were before the run's own later steps changed them (`inputValues`): used in
   * place of the settled read, so a field edited after the submit is judged as it was submitted.
   */
  readonly inputsAsOf?: HeldInputs;
}

/** `dom` observables that read an input's `value`, by name (`InvariantMonitor.inputValues`). */
export type HeldInputs = ReadonlyMap<string, { readonly value: EvalValue; readonly evidence?: string }>;

export interface AfterResult {
  readonly violations: InvariantViolation[];
  /** Invariants that applied but could not be decided (an observable was unreadable). */
  readonly unknown: string[];
  /** Invariants that applied and held. */
  readonly held: string[];
}
