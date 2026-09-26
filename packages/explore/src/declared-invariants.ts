import type { Locator, Page, Response } from "playwright";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import {
  DEFAULT_IN_VIEWPORT_MIN,
  attrOf,
  boxesOf,
  checkAssertion,
  descriptorToTarget,
  evaluateVisual,
  installFlashRecorder,
  intersectionRatio,
  isVisualAssertion,
  styleChannel,
  stylesOf,
} from "@jevitate/interpreter";
import { descriptorToLocator } from "@jevitate/recorder";
import {
  UNKNOWN,
  captureRefs,
  evaluateInvariantExpression,
  expressionObservables,
  globRegex,
  invariantGate,
  invariantObserver,
  jsonPathHasEach,
  matchesPattern,
  matchesResponseStatus,
  parseInvariantExpression,
  parseJsonPath,
  patternRegex,
  probeUrl,
  readJsonPath,
  readJsonPathList,
  resolveHttpUrl,
  substituteCaptureRefs,
  walkExpression,
  type CaptureSpec,
  type CaptureWhen,
  type DeclaredInvariant,
  type DomObservable,
  type EvalValue,
  type ExprNode,
  type InvariantSpec,
  type JsonPathSegment,
  type NeverResponse,
  type ObservableSpec,
  type ProbeAuthFrom,
  type ProbeObservable,
  type ObservedList,
  type ObservedValue,
  type Recording,
} from "@jevitate/recording";
import { isAuthorizedExploreTarget } from "./authorized-targets.js";
import { redactText, redactUrl } from "./redact.js";
import { invariantFingerprint, normalizeRoute } from "./adversarial/defect-fingerprint.js";

/**
 * The browser side of app-declared invariants (#86): snapshots the spec's named observables around
 * an action and evaluates its invariants MECHANICALLY — never a model, never `eval` (guardrail #4:
 * a violation is concluded by independent code, like a console error or a 5xx).
 *
 * One monitor per mission run. The mission calls `before(actor)` right before an action and
 * `after(actor, action)` once the page has settled after it; `after` returns the violations. A
 * violation is a HARD defect; an invariant whose observables could not be read is `unknown` —
 * counted in `report()`, never a violation and never a pass.
 *
 * Multi-actor (#147): `capture`s bind a resource id/URL from the PRIMARY's run (its responses, its
 * page, its URL after an action). An invariant gated on `when.after: "capture.<name>"` runs ONCE,
 * right after that capture binds, from an OBSERVER actor's own page (`ObserverSessions`, a fresh
 * browser context per actor — cookies are never copied between actors): `probe`s with `as:` use
 * that context's request client; `deniedAs` navigates it to the resource and only OBSERVES the
 * document status, the app's own responses and the page text. Observers are never driven by a
 * model and never click or type. A gated invariant that never ran (nothing captured, the observer's
 * session was lost) is UNDECIDED — `report()` says why — never a pass.
 *
 * Read-only by construction:
 *  - `dom` reads text/value/count of the first match of a target on the current page;
 *  - `network` reads a JSON path in the last response (to an authorized origin) whose URL matches;
 *  - `probe` is a GET or HEAD of an authorized origin through the mission browser context's own
 *    request client (its own cookies — no new credential path), no redirects followed, bounded
 *    body, re-checked against the allowlist at request time (the dispatch already refused any
 *    other origin). Only the extracted scalar survives, redacted; never the body.
 */

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
}

export interface AfterResult {
  readonly violations: InvariantViolation[];
  /** Invariants that applied but could not be decided (an observable was unreadable). */
  readonly unknown: string[];
  /** Invariants that applied and held. */
  readonly held: string[];
}

interface Snapshot {
  readonly values: Map<string, EvalValue>;
  readonly evidence: Map<string, string>;
}

interface CompiledInvariant {
  readonly decl: DeclaredInvariant;
  readonly ast: ExprNode | null;
  /** Observables whose AFTER value is read (bare, `after()`, `delta()`). */
  readonly afterNames: string[];
  /** Observables whose BEFORE value is read (`before()`, `delta()`). */
  readonly beforeNames: string[];
  /** #147: the capture this cross-actor invariant is gated on (null: checked around actions). */
  readonly gate: string | null;
  /** #147: the observer actor it checks from. */
  readonly observer: string | null;
}

/** A capture's bound value (raw: it is substituted and compared, never shown unredacted). */
interface BoundCapture {
  readonly value: string;
  readonly evidence: string;
}

const DOM_TIMEOUT_MS = 1_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_VALUE_CHARS = 120;
const DEFAULT_SETTLE_POLL_MS = 1_000;
const PENDING_BODY_WAIT_MS = 2_000;
const OBSERVER_NAV_TIMEOUT_MS = 15_000;
const OBSERVER_IDLE_MS = 5_000;
const MAX_APP_EVIDENCE = 5;
/** #195: matching responses kept per `never.response` invariant between two checks (the rest are counted). */
const MAX_RESPONSE_HITS = 20;
/** An observer bounced here lost its session: "undecided", never "denied" (#147, cf. #82). */
const LOGIN_PATH_RE = /(^|\/)(log-?in|sign-?in|signin|auth|sso)(\/|$)/i;
/** gRPC status codes → the Connect code names (#73/#110: gRPC-web reports errors in a header). */
const GRPC_CODES: Readonly<Record<string, string>> = {
  "1": "canceled",
  "2": "unknown",
  "3": "invalid_argument",
  "4": "deadline_exceeded",
  "5": "not_found",
  "6": "already_exists",
  "7": "permission_denied",
  "8": "resource_exhausted",
  "9": "failed_precondition",
  "10": "aborted",
  "11": "out_of_range",
  "12": "unimplemented",
  "13": "internal",
  "14": "unavailable",
  "15": "data_loss",
  "16": "unauthenticated",
};

function namesUsing(ast: ExprNode, fns: ReadonlyArray<"before" | "after" | "delta">): string[] {
  const out = new Set<string>();
  walkExpression(ast, (n) => {
    if (n.t === "obs" && fns.includes(n.fn)) out.add(n.name);
  });
  return [...out];
}

function matchesActionWhen(w: CaptureWhen, action: InvariantAction | null): boolean {
  if (action === null || action.op === null) return false;
  if (w.op !== undefined && !w.op.includes(action.op)) return false;
  if (w.control !== undefined && (action.control === null || !matchesPattern(w.control.name, action.control, true))) return false;
  if (w.route !== undefined && !globRegex(w.route).test(pathnameOf(action.url))) return false;
  return true;
}

/** The Connect/gRPC error code of a response, if it carries one (header, or a Connect JSON error body). */
async function connectCodeOf(response: Response): Promise<string | null> {
  const headers = response.headers();
  const grpc = headers["grpc-status"];
  if (grpc !== undefined) return GRPC_CODES[grpc.trim()] ?? null;
  if (response.status() < 400 || !(headers["content-type"] ?? "").includes("json")) return null;
  const buf = await response.body().catch(() => null);
  if (buf === null || buf.length > MAX_BODY_BYTES) return null;
  try {
    const body: unknown = JSON.parse(buf.toString("utf8"));
    const code = body !== null && typeof body === "object" && "code" in body ? (body as { code: unknown }).code : null;
    return typeof code === "string" && /^[a-z_]+$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** A Unicode minus (U+2212) or a dash (U+2012–U+2015), normalized to ASCII `-` when read as a sign. */
const MINUS_LIKE_RE = /[−‒–—―]/g;
/**
 * A number token: an optional leading sign (ASCII `-` or a Unicode minus/dash) followed by digits
 * (with `,` thousands separators) and an optional decimal. The sign is consumed only when it is
 * `(?<!\d)` — NOT glued to a preceding digit — and `(?=\d)` — glued to the FOLLOWING digit, no space.
 * That keeps a range's dash a separator, never a sign: `"30–90"` (dash touches the `0` before it) and
 * `"3 – 7"` (a space before the `7`) both read as two plain numbers, while `"−40"` (dash at the very
 * start, glued to the `4`) reads as one negative number (#156).
 */
const NUMBER_TOKEN_RE = /(?:(?<!\d)[−‒–—―-](?=\d))?\d[\d,]*(?:\.\d+)?/g;

/**
 * Every number in a text, left to right (`"≈ 30–90 credits"` → `[30, 90]`; `"−40 credits"` → `[-40]`;
 * `"1,234.5"` → `[1234.5]`) — #156's parser behind `DomObservable.number`.
 */
export function parseNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_TOKEN_RE)) {
    const n = Number(m[0].replace(MINUS_LIKE_RE, "-").replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** The first number in a text (`number: true`); null when there is none. */
export function parseFirstNumber(text: string): number | null {
  return parseNumbers(text)[0] ?? null;
}

function pageOf(actor: Actor): Page {
  return actor.ability(BrowseTheWebToken).session.page;
}

function matchesUrlGlob(glob: string, url: string): boolean {
  const re = globRegex(glob);
  if (glob.startsWith("/")) {
    try {
      const u = new URL(url);
      return re.test(`${u.pathname}${u.search}`) || re.test(u.pathname);
    } catch {
      return false;
    }
  }
  return re.test(url);
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

export class InvariantMonitor {
  readonly #spec: InvariantSpec;
  readonly #opts: InvariantMonitorOptions;
  readonly #invariants: CompiledInvariant[];
  readonly #jsonPaths = new Map<string, JsonPathSegment[]>();
  readonly #attached = new WeakSet<Page>();
  readonly #pendingBodies = new Set<Promise<void>>();
  /** The latest value per `network` observable (and its redacted evidence). */
  readonly #network = new Map<string, { value: ObservedValue; evidence: string }>();
  /** The latest list per `[*]` `network` observable (#147). */
  readonly #networkLists = new Map<string, { value: ObservedValue[]; evidence: string }>();
  readonly #tally = new Map<string, { checked: number; held: number; violated: number; unknown: number }>();
  /** Every auth token this monitor has read (#135): scrubbed from evidence/values the instant it's read. */
  readonly #authSecrets: string[] = [];
  /** #147: bound captures (first value wins) and the JSON paths of `network` captures. */
  readonly #captures = new Map<string, BoundCapture>();
  readonly #captureJsonPaths = new Map<string, JsonPathSegment[]>();
  /** #147: cross-actor invariants that already ran (each runs once per run), and why one is undecided. */
  readonly #ran = new Set<string>();
  readonly #armedUrl = new Set<string>();
  readonly #undecided = new Map<string, string>();
  #before: Snapshot | null = null;
  /** #195: `never.response` invariants, and the matching responses seen since each was last checked. */
  readonly #responseNevers: ReadonlyArray<{ readonly id: string; readonly spec: NeverResponse }>;
  readonly #responseHits = new Map<string, { hits: Array<Omit<NeverResponseHit, "step">>; total: number }>();
  /** #195: real actions checked so far (a response's step) and how the current one reads in evidence. */
  #actions = 0;
  #stepLabel = "page load";

  constructor(spec: InvariantSpec, opts: InvariantMonitorOptions) {
    this.#spec = spec;
    this.#opts = opts;
    // Capture names are read from the bound captures, never snapshotted as observables.
    const observable = (n: string): boolean => spec.observe?.[n] !== undefined;
    this.#invariants = spec.invariants.map((decl) => {
      const ast = decl.require === undefined ? null : parseInvariantExpression(decl.require);
      return {
        decl,
        ast,
        afterNames: ast === null ? [] : namesUsing(ast, ["after", "delta"]).filter(observable),
        beforeNames: ast === null ? [] : namesUsing(ast, ["before", "delta"]).filter(observable),
        gate: invariantGate(decl),
        observer: invariantObserver(spec, decl),
      };
    });
    for (const [name, o] of Object.entries(spec.observe ?? {})) {
      const path = "network" in o ? o.network.json : "probe" in o ? o.probe.json : undefined;
      if (path !== undefined) this.#jsonPaths.set(name, parseJsonPath(path));
    }
    for (const [name, c] of Object.entries(spec.capture ?? {})) {
      if ("network" in c) this.#captureJsonPaths.set(name, parseJsonPath(c.network.json));
    }
    for (const inv of spec.invariants) this.#tally.set(inv.id, { checked: 0, held: 0, violated: 0, unknown: 0 });
    this.#responseNevers = spec.invariants.flatMap((inv) =>
      inv.never !== undefined && "response" in inv.never ? [{ id: inv.id, spec: inv.never.response }] : [],
    );
  }

  /** The spec this monitor evaluates (persisted with a result so verify-fix re-checks the same one). */
  get spec(): InvariantSpec {
    return this.#spec;
  }

  /** Every invariant's tally so far (#147: a cross-actor one also names its observer, and why it is undecided). */
  report(): InvariantReport[] {
    return this.#invariants.map((c) => {
      const tally = this.#tally.get(c.decl.id) ?? { checked: 0, held: 0, violated: 0, unknown: 0 };
      if (c.gate === null) return { id: c.decl.id, ...tally };
      const decided = tally.held + tally.violated > 0;
      const why = decided
        ? undefined
        : tally.checked === 0
          ? `never ran: capture ${c.gate} was never bound from the primary's run`
          : (this.#undecided.get(c.decl.id) ?? "an observable could not be read");
      return { id: c.decl.id, ...tally, ...(c.observer === null ? {} : { observer: c.observer }), ...(why === undefined ? {} : { undecided: why }) };
    });
  }

  /** #147: the cross-actor invariants that were never decided (`id` → why) — none of them may read as a pass. */
  undecidedCrossActor(): Array<{ readonly id: string; readonly reason: string }> {
    return this.report().flatMap((r) => (r.undecided === undefined ? [] : [{ id: r.id, reason: r.undecided }]));
  }

  /**
   * Reads ONE named observable, mechanically — the same `dom`/`network`/`probe` machinery `before`/
   * `after` use (#135 auth, redaction, allowlist re-checked at request time). For a caller that needs
   * a single value outside the before/after cycle (#150's `BudgetMonitor`: a baseline, a post-settle
   * re-read, a guard's estimate). `unreadable` is true when the value could not be read (or is not
   * numeric) — the caller decides what that means for its own purpose.
   */
  async readObservable(page: Page, name: string): Promise<{ value: ObservedValue | null; unreadable: boolean; evidence?: string }> {
    this.attach(page);
    const o = this.#spec.observe?.[name];
    if (o === undefined) return { value: null, unreadable: true };
    const read = await this.#read(page, name, o).catch(() => ({ value: UNKNOWN as EvalValue, evidence: undefined }));
    // A list-valued observable (#147/#148) is never a valid scalar here — a caller like #150's
    // `BudgetMonitor` needs a number, and a list is neither readable as one nor a violation to guess at.
    if (read.value === UNKNOWN || isList(read.value)) {
      return { value: null, unreadable: true, ...(read.evidence === undefined ? {} : { evidence: read.evidence }) };
    }
    return { value: read.value, unreadable: false, ...(read.evidence === undefined ? {} : { evidence: read.evidence }) };
  }

  /**
   * Starts listening for `network` observables on a page. Idempotent; `before`/`after` call it, but a
   * mission should call it BEFORE its first navigation so the seed load's responses are seen.
   */
  attach(page: Page): void {
    if (this.#attached.has(page)) return;
    this.#attached.add(page);
    // A transient-state (`flashed`, #148) always/never check needs the flash recorder before the
    // actions it watches. Protocol messages are ordered, so it is installed before the next navigation.
    const assertions = this.#spec.invariants.flatMap((d) => [
      ...(d.always === undefined ? [] : [d.always]),
      ...(d.never !== undefined && "assertion" in d.never ? [d.never.assertion] : []),
    ]);
    if (assertions.some((a) => a.kind === "flashed")) void installFlashRecorder(page).catch(() => undefined);
    // #195: `never.response` watches the mission's OWN traffic — this (primary) page's responses, from
    // an authorized origin only. Only method, URL and status are kept: never a body.
    if (this.#responseNevers.length > 0) {
      page.on("response", (response: Response) => {
        const url = response.url();
        if (!isAuthorizedExploreTarget(url, this.#opts.allowlist)) return;
        const method = response.request().method().toUpperCase();
        const status = response.status();
        for (const n of this.#responseNevers) {
          if (!matchesUrlGlob(n.spec.url, url) || !matchesResponseStatus(n.spec.status, status)) continue;
          if (n.spec.method !== undefined && n.spec.method.toUpperCase() !== method) continue;
          const seen = this.#responseHits.get(n.id) ?? { hits: [], total: 0 };
          this.#responseHits.set(n.id, seen);
          seen.total += 1;
          if (seen.hits.length < MAX_RESPONSE_HITS) seen.hits.push({ method, url: this.#redact(redactUrl(url)), status });
        }
      });
    }
    const network = Object.entries(this.#spec.observe ?? {}).filter(
      (e): e is [string, { network: NonNullable<Extract<ObservableSpec, { network: unknown }>["network"]> }] => "network" in e[1],
    );
    const captures = Object.entries(this.#spec.capture ?? {}).filter(
      (e): e is [string, Extract<CaptureSpec, { network: unknown }>] => "network" in e[1],
    );
    if (network.length === 0 && captures.length === 0) return;
    page.on("response", (response: Response) => {
      const url = response.url();
      if (!isAuthorizedExploreTarget(url, this.#opts.allowlist)) return;
      const method = response.request().method().toUpperCase();
      const hits = network.filter(([, o]) => matchesUrlGlob(o.network.url, url) && (o.network.method === undefined || o.network.method.toUpperCase() === method));
      const captureHits = captures.filter(
        ([name, c]) =>
          !this.#captures.has(name) && matchesUrlGlob(c.network.url, url) && (c.network.method === undefined || c.network.method.toUpperCase() === method),
      );
      if (hits.length === 0 && captureHits.length === 0) return;
      const read = response
        .body()
        .then((buf) => {
          if (buf.length > MAX_BODY_BYTES) return;
          const body: unknown = JSON.parse(buf.toString("utf8"));
          const evidence = `${method} ${redactUrl(url)} → ${response.status()}`;
          for (const [name] of hits) {
            const path = this.#jsonPaths.get(name) ?? [];
            if (jsonPathHasEach(path)) {
              const list = readJsonPathList(body, path);
              if (list !== undefined) this.#networkLists.set(name, { value: list.map((v) => this.#clip(v)), evidence });
              continue;
            }
            const v = readJsonPath(body, path);
            if (v === undefined) continue;
            this.#network.set(name, { value: this.#clip(v), evidence });
          }
          // #147: a capture binds ONCE, from a successful response (a failed create has no resource).
          if (response.status() >= 200 && response.status() < 300) {
            for (const [name] of captureHits) {
              const v = readJsonPath(body, this.#captureJsonPaths.get(name) ?? []);
              if (v === undefined || v === null || this.#captures.has(name)) continue;
              this.#captures.set(name, { value: String(v), evidence: `capture ${name} from ${evidence}` });
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.#pendingBodies.delete(read);
        });
      this.#pendingBodies.add(read);
    });
  }

  /** Snapshots the observables an action's invariants compare against (call right before acting). */
  async before(actor: Actor): Promise<void> {
    const page = pageOf(actor);
    this.attach(page);
    const names = new Set(this.#invariants.filter((c) => c.gate === null).flatMap((c) => c.beforeNames));
    this.#before = await this.#snapshot(page, names);
  }

  /**
   * Snapshots again after the action settled and evaluates every invariant that applies to it
   * (`when`), plus every `never`. A violated `settle` invariant is re-checked until it holds or its
   * window closes; only then is it a violation. Never throws: an observable that cannot be read is
   * `unknown`.
   */
  async after(actor: Actor, action: InvariantAction | null, opts: AfterOptions = {}): Promise<AfterResult> {
    const page = pageOf(actor);
    this.attach(page);
    const before = this.#before ?? { values: new Map<string, EvalValue>(), evidence: new Map<string, string>() };
    this.#before = null;
    const applicable = this.#invariants.filter(
      (c) => c.gate === null && (opts.only === undefined || c.decl.id === opts.only) && (opts.force === true || this.#applies(c.decl, action)),
    );
    const afterNames = new Set(applicable.flatMap((c) => c.afterNames));
    const beforeNames = new Set(this.#invariants.filter((c) => c.gate === null).flatMap((c) => c.beforeNames));
    if (opts.rearm === true) for (const n of beforeNames) afterNames.add(n);
    const after = await this.#snapshot(page, afterNames);
    let polled = false;
    const violations: InvariantViolation[] = [];
    const unknown: string[] = [];
    const held: string[] = [];
    const pageUrl = safeUrl(page);
    // #195: the responses a `never.response` drains now happened during this action (or the page load).
    if (action !== null && action.op !== null) {
      this.#actions += 1;
      this.#stepLabel = action.control === null ? action.op : `${action.op} ${JSON.stringify(this.#redact(action.control))}`;
    } else if (this.#actions > 0) this.#stepLabel = "no action";
    for (const c of applicable) {
      const tally = this.#tally.get(c.decl.id) ?? { checked: 0, held: 0, violated: 0, unknown: 0 };
      this.#tally.set(c.decl.id, tally);
      tally.checked += 1;
      const verdict = await this.#evaluate(c, page, actor, action, before, after, pageUrl);
      // #151: settle only ever polls on a decided violation (below), so "unknown" never went
      // through the loop — the before-snapshot next action rearms from is still fresh for it.
      if (c.decl.settle !== undefined && verdict !== "held" && verdict !== "unknown") polled = true;
      if (verdict === "held") {
        tally.held += 1;
        held.push(c.decl.id);
      } else if (verdict === "unknown") {
        tally.unknown += 1;
        unknown.push(c.decl.id);
      } else {
        tally.violated += 1;
        violations.push(verdict);
      }
    }
    // A settle window may have run for a while: then the page moved on, so snapshot it afresh.
    if (opts.rearm === true) this.#before = polled ? await this.#snapshot(page, beforeNames) : after;
    // #147: bind what this action produced, then run every cross-actor check whose capture is now bound.
    const cross = await this.#crossActor(actor, action, opts);
    return { violations: [...violations, ...cross.violations], unknown: [...unknown, ...cross.unknown], held: [...held, ...cross.held] };
  }

  /**
   * #147 — binds the captures available with no action (responses already seen, `dom` captures with
   * no `after`) and runs every cross-actor check that became due. Call once when the run ends, so a
   * resource created by the last action is still checked. Never throws.
   */
  async settleCrossActor(actor: Actor): Promise<AfterResult> {
    return this.#crossActor(actor, null, {});
  }

  /** The bound captures' names (#147) — values are never exposed unredacted. */
  boundCaptures(): string[] {
    return [...this.#captures.keys()];
  }

  async #crossActor(actor: Actor, action: InvariantAction | null, opts: AfterOptions): Promise<AfterResult> {
    const gated = this.#invariants.filter((c) => c.gate !== null && (opts.only === undefined || c.decl.id === opts.only));
    const out: AfterResult = { violations: [], unknown: [], held: [] };
    if (gated.length === 0) return out;
    const page = pageOf(actor);
    await this.#bindCaptures(page, action).catch(() => undefined);
    for (const c of gated) {
      const gate = c.gate as string;
      // Rate limit: once per run, right after the capture binds — verify-fix (`force`) re-checks it.
      if (opts.force !== true && (this.#ran.has(c.decl.id) || !this.#captures.has(gate))) continue;
      this.#ran.add(c.decl.id);
      const tally = this.#tally.get(c.decl.id) ?? { checked: 0, held: 0, violated: 0, unknown: 0 };
      this.#tally.set(c.decl.id, tally);
      tally.checked += 1;
      const verdict = await this.#evaluateGated(c, page, action).catch((e: unknown) => ({ undecided: `check failed: ${firstLine(e)}` }));
      if (verdict === "held") {
        tally.held += 1;
        out.held.push(c.decl.id);
      } else if ("undecided" in verdict) {
        tally.unknown += 1;
        this.#undecided.set(c.decl.id, this.#redact(verdict.undecided));
        out.unknown.push(c.decl.id);
      } else {
        tally.violated += 1;
        out.violations.push(verdict);
      }
    }
    return out;
  }

  async #bindCaptures(page: Page, action: InvariantAction | null): Promise<void> {
    const entries = Object.entries(this.#spec.capture ?? {}).filter(([name]) => !this.#captures.has(name));
    if (entries.length === 0) return;
    if (this.#pendingBodies.size > 0) {
      await Promise.race([Promise.allSettled([...this.#pendingBodies]), page.waitForTimeout(PENDING_BODY_WAIT_MS).catch(() => undefined)]);
    }
    for (const [name, c] of entries) {
      if (this.#captures.has(name)) continue;
      if ("url" in c) {
        // Armed by the matching action; bound once the primary's page is on the capture's route (an
        // action that opens the resource asynchronously lands there a snapshot later).
        if (matchesActionWhen(c.url.after, action)) this.#armedUrl.add(name);
        if (!this.#armedUrl.has(name)) continue;
        const url = safeUrl(page);
        if (url === "" || !isAuthorizedExploreTarget(url, this.#opts.allowlist)) continue;
        if (c.url.route !== undefined && !globRegex(c.url.route).test(pathnameOf(url))) continue;
        this.#captures.set(name, { value: url, evidence: `capture ${name} from the primary's URL ${redactUrl(url)}` });
      } else if ("dom" in c) {
        if (c.dom.after !== undefined && !matchesActionWhen(c.dom.after, action)) continue;
        const first = page.locator(c.dom.selector).first();
        if ((await page.locator(c.dom.selector).count().catch(() => 0)) === 0) continue;
        const read = c.dom.read ?? "text";
        const raw = read.startsWith("attr:")
          ? await first.getAttribute(read.slice("attr:".length), { timeout: DOM_TIMEOUT_MS })
          : read === "value"
            ? await first.inputValue({ timeout: DOM_TIMEOUT_MS })
            : await first.innerText({ timeout: DOM_TIMEOUT_MS });
        const v = raw?.trim() ?? "";
        if (v !== "") this.#captures.set(name, { value: v, evidence: `capture ${name} from ${c.dom.selector} on ${redactUrl(safeUrl(page))}` });
      }
    }
  }

  /** The observer's page for a cross-actor check, or why there is none. */
  async #observerPage(observer: string | null): Promise<Page | { undecided: string }> {
    if (observer === null) return { undecided: "no observer actor" };
    if (this.#opts.observers === undefined) return { undecided: `observer ${observer} has no session (no --actor ${observer}=<state>)` };
    try {
      return await this.#opts.observers.page(observer);
    } catch (e) {
      return { undecided: `observer ${observer}'s session could not be opened: ${firstLine(e)}` };
    }
  }

  #crossActorEvidence(c: CompiledInvariant): CrossActorEvidence {
    const gate = c.gate as string;
    const value = this.#captures.get(gate)?.value ?? "";
    const shown = "url" in (this.#spec.capture?.[gate] ?? {}) ? redactUrl(value) : String(this.#clip(value));
    return { owner: this.#opts.primaryActor ?? "primary", observer: c.observer ?? "", capture: gate, resource: shown };
  }

  async #evaluateGated(c: CompiledInvariant, primary: Page, action: InvariantAction | null): Promise<InvariantViolation | "held" | { undecided: string }> {
    const gate = c.gate as string;
    if (!this.#captures.has(gate)) return { undecided: `capture ${gate} was never bound from the primary's run` };
    const observerPage = await this.#observerPage(c.observer);
    if (!("goto" in observerPage)) return observerPage;
    if (c.decl.deniedAs !== undefined) return this.#deniedAs(c, observerPage, action);
    const ast = c.ast;
    if (ast === null) return { undecided: "nothing to evaluate" };
    // Each observable is read in ITS actor's context: `as:` probes in the observer's, the rest in the primary's.
    const values = new Map<string, EvalValue>();
    const evidence = new Map<string, string>();
    let observerUrl: string | null = null;
    for (const name of expressionObservables(ast)) {
      const o = this.#spec.observe?.[name];
      if (o === undefined) continue; // a capture
      const onObserver = "probe" in o && o.probe.as !== undefined;
      const observerName = onObserver && "probe" in o ? (o.probe.as ?? null) : null;
      const read = await this.#read(onObserver ? observerPage : primary, name, o, observerName).catch(() => ({ value: UNKNOWN as EvalValue, evidence: undefined }));
      values.set(name, read.value);
      if (read.evidence !== undefined) evidence.set(name, onObserver ? `${read.evidence} (as ${c.observer ?? ""})` : read.evidence);
      if (onObserver && observerUrl === null && "probe" in o) {
        observerUrl = resolveHttpUrl(this.#probeTemplate(o.probe) ?? "", this.#opts.baseUrl)?.href ?? null;
      }
    }
    const lookup = (n: string): EvalValue => {
      const cap = this.#captures.get(n);
      if (cap !== undefined) return cap.value;
      return values.has(n) ? (values.get(n) as EvalValue) : UNKNOWN;
    };
    const result = evaluateInvariantExpression(ast, { before: lookup, after: lookup });
    const lines = [...new Set(evidence.values())];
    if (result === true) return "held";
    if (result === UNKNOWN) return { undecided: `an observable could not be read${lines.length === 0 ? "" : ` (${lines.join("; ")})`}` };
    const shown: Record<string, { before: InvariantValue; after: InvariantValue }> = {};
    for (const n of expressionObservables(ast)) {
      const v = this.#shown(lookup(n));
      shown[n] = { before: v, after: v };
    }
    const detail = Object.entries(shown)
      .map(([n, v]) => `${n}: ${display(v.after)}`)
      .join("; ");
    return this.#violation(c.decl, action, observerUrl ?? action?.url ?? safeUrl(primary), "require", c.decl.require ?? "", detail, shown, lines, undefined, this.#crossActorEvidence(c));
  }

  /**
   * `deniedAs` (#147): PASSIVE — navigates the observer's own page to the resource and only observes
   * the document status, the app's own responses (and their Connect/gRPC codes) and whether a
   * denial text is visible. Held when any declared expectation is observed; a login bounce is
   * "session lost" (undecided). The observer's page text is never kept — only whether the captured
   * id appeared on it.
   */
  async #deniedAs(c: CompiledInvariant, page: Page, action: InvariantAction | null): Promise<InvariantViolation | "held" | { undecided: string }> {
    const d = c.decl.deniedAs as NonNullable<DeclaredInvariant["deniedAs"]>;
    const raw = substituteCaptureRefs(d.open, (n) => this.#captures.get(n)?.value);
    if (raw === null) return { undecided: `a capture in ${d.open} was never bound` };
    const url = resolveHttpUrl(raw, this.#opts.baseUrl);
    if (url === null || url.username !== "" || url.password !== "" || !isAuthorizedExploreTarget(url.href, this.#opts.allowlist)) {
      return { undecided: "open refused: not an authorized origin" };
    }
    const app: Array<{ url: string; status: number; code: Promise<string | null> }> = [];
    const expectApp = d.expect.appResponses;
    const onResponse = (r: Response): void => {
      if (expectApp === undefined || r.request().isNavigationRequest()) return;
      const u = r.url();
      if (!isAuthorizedExploreTarget(u, this.#opts.allowlist) || !matchesUrlGlob(expectApp.url, u)) return;
      app.push({ url: u, status: r.status(), code: expectApp.connectCode === undefined ? Promise.resolve(null) : connectCodeOf(r).catch(() => null) });
    };
    page.on("response", onResponse);
    let status: number | null;
    try {
      const doc = await page.goto(url.href, { waitUntil: "load", timeout: OBSERVER_NAV_TIMEOUT_MS });
      status = doc?.status() ?? null;
      await page.waitForLoadState("networkidle", { timeout: OBSERVER_IDLE_MS }).catch(() => undefined);
    } catch (e) {
      return { undecided: `the observer could not open ${redactUrl(url.href)}: ${firstLine(e)}` };
    } finally {
      page.off("response", onResponse);
    }
    const codes = await Promise.all(app.map((a) => a.code));
    const finalUrl = safeUrl(page);
    const finalPath = pathnameOf(finalUrl);
    const docLine = `open ${redactUrl(url.href)} as ${d.actor} → ${status ?? "no response"}${finalPath !== url.pathname ? ` (landed on ${normalizeRoute(finalUrl)})` : ""}`;
    // Session lost (#82): a login bounce or an unauthenticated document is not a denial.
    if ((finalPath !== url.pathname && LOGIN_PATH_RE.test(finalPath)) || (status === 401 && !(d.expect.documentStatus ?? []).includes(401))) {
      return { undecided: `observer ${d.actor}'s session was lost (${docLine})` };
    }
    const denials: string[] = [];
    if (status !== null && (d.expect.documentStatus ?? []).includes(status)) denials.push(`documentStatus ${status}`);
    if (expectApp !== undefined) {
      app.forEach((a, i) => {
        const code = codes[i] ?? null;
        if ((expectApp.status ?? []).includes(a.status) || (code !== null && (expectApp.connectCode ?? []).includes(code))) {
          denials.push(`app response ${a.status}${code === null ? "" : ` (${code})`}`);
        }
      });
    }
    const text = await page
      .locator("body")
      .innerText({ timeout: DOM_TIMEOUT_MS })
      .catch(() => null);
    if (d.expect.orVisible !== undefined && text !== null && matchesPattern(d.expect.orVisible, text, false)) denials.push("denial text visible");
    if (denials.length > 0) return "held";
    if (text === null && status === null) return { undecided: `nothing observable on the observer's page (${docLine})` };
    // Leaked data is not re-leaked: only WHETHER a captured id appeared, never the page's text.
    const shownIds = [...new Set([c.gate as string, ...captureRefs(d.open)])].filter((n) => {
      const cap = this.#spec.capture?.[n];
      const v = this.#captures.get(n)?.value;
      return cap !== undefined && !("url" in cap) && v !== undefined && text !== null && text.includes(v);
    });
    const evidence = [
      docLine,
      ...app.slice(0, MAX_APP_EVIDENCE).map((a, i) => `app ${redactUrl(a.url)} → ${a.status}${codes[i] === null || codes[i] === undefined ? "" : ` (${codes[i]})`}`),
      shownIds.length > 0 ? `the observer's page shows the primary's ${shownIds.join(", ")}` : "the observer's page did not show a captured id",
    ];
    const detail = `${d.actor} opened it: ${status ?? "no response"}, no declared denial observed`;
    return this.#violation(c.decl, action, url.href, "deniedAs", `deniedAs ${d.actor} ${d.open}`, detail, {}, evidence, undefined, this.#crossActorEvidence(c));
  }

  #probeTemplate(probe: ProbeObservable): string | null {
    const tpl = probe.get ?? probe.head;
    if (tpl === undefined) return null;
    return substituteCaptureRefs(tpl, (n) => this.#captures.get(n)?.value);
  }

  #violation(
    decl: DeclaredInvariant,
    action: InvariantAction | null,
    attributedUrl: string,
    kind: InvariantViolation["kind"],
    expression: string,
    detail: string,
    values: InvariantViolation["values"],
    evidence: string[],
    settledForMs?: number,
    crossActor?: CrossActorEvidence,
  ): InvariantViolation {
    const url = redactUrl(attributedUrl);
    const reason = this.#redact(`invariant ${decl.id} violated: ${expression}${detail === "" ? "" : ` [${detail}]`}`);
    return {
      id: decl.id,
      kind,
      expression,
      values,
      action: action === null ? null : { op: action.op, control: action.control === null ? null : this.#redact(action.control) },
      route: normalizeRoute(url),
      url,
      reason,
      fingerprint: invariantFingerprint(url, reason, decl.id),
      evidence: evidence.map((e) => this.#redact(e)),
      ...(settledForMs === undefined ? {} : { settledForMs }),
      ...(crossActor === undefined ? {} : { crossActor }),
    };
  }

  #applies(decl: DeclaredInvariant, action: InvariantAction | null): boolean {
    if (decl.never !== undefined) return true; // global: every snapshot
    if (action === null || action.op === null) return false; // require/always are about an action
    const w = decl.when;
    if (w === undefined) return true;
    if (w.op !== undefined && !w.op.includes(action.op)) return false;
    if (w.control !== undefined && (action.control === null || !matchesPattern(w.control.name, action.control, true))) return false;
    if (w.route !== undefined && !globRegex(w.route).test(pathnameOf(action.url))) return false;
    return true;
  }

  async #evaluate(
    c: CompiledInvariant,
    page: Page,
    actor: Actor,
    action: InvariantAction | null,
    before: Snapshot,
    initialAfter: Snapshot,
    pageUrl: string,
  ): Promise<InvariantViolation | "held" | "unknown"> {
    const decl = c.decl;
    const attributedUrl = decl.never !== undefined || action === null ? pageUrl : action.url;
    const make = (
      kind: InvariantViolation["kind"],
      expression: string,
      detail: string,
      values: InvariantViolation["values"],
      evidence: string[],
      settledForMs?: number,
    ): InvariantViolation => this.#violation(decl, action, attributedUrl, kind, expression, detail, values, evidence, settledForMs);

    // A visual-state assertion (#148) is decided by code with its evidence; an unreadable one (no
    // match, a value that does not parse) is `unknown` — never a violation, never a pass.
    const visual = decl.always ?? (decl.never !== undefined && "assertion" in decl.never ? decl.never.assertion : undefined);
    if (visual !== undefined && isVisualAssertion(visual)) {
      const v = await evaluateVisual(visual, (d) => descriptorToTarget(d).resolve(page));
      if (v.detail.startsWith("unreadable")) return "unknown";
      const violated = decl.always !== undefined ? !v.held : v.held;
      const kind = decl.always !== undefined ? "always" : "never";
      return violated ? make(kind, `${kind} ${JSON.stringify(visual)}`, this.#clip(v.detail), {}, []) : "held";
    }
    if (decl.always !== undefined) {
      const ok = await checkAssertion(actor, decl.always, { timeoutMs: 500 }).catch(() => null);
      if (ok === null) return "unknown";
      return ok ? "held" : make("always", `always ${JSON.stringify(decl.always)}`, "", {}, []);
    }
    if (decl.never !== undefined) {
      const never = decl.never;
      if ("response" in never) return this.#responseVerdict(decl, never.response, action, attributedUrl);
      if ("pageText" in never) {
        const text = await page
          .locator("body")
          .innerText({ timeout: DOM_TIMEOUT_MS })
          .catch(() => null);
        if (text === null) return "unknown";
        const re = patternRegex(never.pageText);
        const hit = re === null ? (text.includes(never.pageText) ? never.pageText : null) : (re.exec(text)?.[0] ?? null);
        return hit === null ? "held" : make("never", `never pageText ${never.pageText}`, `matched ${JSON.stringify(this.#clip(hit))}`, {}, []);
      }
      const holds = await checkAssertion(actor, never.assertion, { timeoutMs: 0 }).catch(() => null);
      if (holds === null) return "unknown";
      return holds ? make("never", `never ${JSON.stringify(never.assertion)}`, "", {}, []) : "held";
    }

    const ast = c.ast;
    if (ast === null) return "unknown";
    let after = initialAfter;
    const env = (a: Snapshot) => ({
      before: (n: string) => this.#captures.get(n)?.value ?? (before.values.has(n) ? (before.values.get(n) as EvalValue) : UNKNOWN),
      after: (n: string) => this.#captures.get(n)?.value ?? (a.values.has(n) ? (a.values.get(n) as EvalValue) : UNKNOWN),
    });
    let result = evaluateInvariantExpression(ast, env(after));
    let settledForMs: number | undefined;
    // #151: re-poll ONLY a decided violation (result === false) — never an UNKNOWN. An observable
    // that is legitimately absent (`optional: true`) must not stall every action for the whole
    // `withinMs` window; UNKNOWN is reported at once (fail-closed: still never a pass).
    if (result === false && decl.settle !== undefined) {
      // Eventual consistency: re-check until it holds or the window closes. Only the observables this
      // invariant reads are re-read.
      const now = this.#opts.now ?? Date.now;
      const start = now();
      const poll = decl.settle.pollMs ?? DEFAULT_SETTLE_POLL_MS;
      const sleep = this.#opts.sleep ?? ((p: Page, ms: number) => p.waitForTimeout(ms));
      while (result === false && now() - start < decl.settle.withinMs) {
        await sleep(page, Math.min(poll, Math.max(0, decl.settle.withinMs - (now() - start))));
        after = await this.#snapshot(page, new Set(c.afterNames));
        result = evaluateInvariantExpression(ast, env(after));
      }
      settledForMs = now() - start;
    }
    if (result === true) return "held";
    if (result === UNKNOWN) return "unknown";
    const values: Record<string, { before: InvariantValue; after: InvariantValue }> = {};
    for (const n of expressionObservables(ast)) {
      values[n] = { before: this.#shown(before.values.get(n)), after: this.#shown(after.values.get(n)) };
    }
    const detail = Object.entries(values)
      .map(([n, v]) => `${n}: ${display(v.before)} → ${display(v.after)}`)
      .join("; ");
    const evidence = [...new Set(expressionObservables(ast).flatMap((n) => [before.evidence.get(n), after.evidence.get(n)]).filter((e): e is string => e !== undefined))];
    return make("require", decl.require ?? "", detail, values, evidence, settledForMs);
  }

  /**
   * #195 — a `never.response` verdict: drains the matching responses seen since this invariant was
   * last checked (they happened during the current step). None ⇒ held.
   */
  #responseVerdict(decl: DeclaredInvariant, spec: NeverResponse, action: InvariantAction | null, attributedUrl: string): InvariantViolation | "held" {
    const seen = this.#responseHits.get(decl.id);
    this.#responseHits.delete(decl.id);
    if (seen === undefined || seen.total === 0) return "held";
    const step = this.#actions;
    const responses = seen.hits.map((h) => ({ ...h, step }));
    const evidence = responses.map((h) => `${h.method} ${h.url} → ${h.status} (step ${step}: ${this.#stepLabel})`);
    const expression = `never response ${spec.method === undefined ? "" : `${spec.method.toUpperCase()} `}${spec.url} = ${String(spec.status)}`;
    const more = seen.total > responses.length ? ` (+${seen.total - responses.length} more)` : "";
    const v = this.#violation(decl, action, attributedUrl, "never", expression, `${evidence.slice(0, MAX_APP_EVIDENCE).join("; ")}${more}`, {}, evidence);
    return { ...v, responses };
  }

  /**
   * #195 — checks every `never.response` invariant against the responses that arrived since its last
   * check (attributed to the last step). Call once when the run ends, so a response to the LAST
   * action — one that landed after that action's check — is never lost. Never throws.
   */
  flushResponses(page: Page): AfterResult {
    const violations: InvariantViolation[] = [];
    const held: string[] = [];
    const pageUrl = safeUrl(page);
    for (const n of this.#responseNevers) {
      if ((this.#responseHits.get(n.id)?.total ?? 0) === 0) continue;
      const decl = this.#invariants.find((c) => c.decl.id === n.id)?.decl;
      if (decl === undefined) continue;
      const tally = this.#tally.get(n.id) ?? { checked: 0, held: 0, violated: 0, unknown: 0 };
      this.#tally.set(n.id, tally);
      tally.checked += 1;
      const verdict = this.#responseVerdict(decl, n.spec, null, pageUrl);
      if (verdict === "held") {
        tally.held += 1;
        held.push(n.id);
      } else {
        tally.violated += 1;
        violations.push(verdict);
      }
    }
    return { violations, unknown: [], held };
  }

  async #snapshot(page: Page, names: ReadonlySet<string>): Promise<Snapshot> {
    const values = new Map<string, EvalValue>();
    const evidence = new Map<string, string>();
    if (names.size === 0) return { values, evidence };
    // A response that already arrived may still be having its body read: let it land (bounded).
    if (this.#pendingBodies.size > 0) {
      await Promise.race([Promise.allSettled([...this.#pendingBodies]), page.waitForTimeout(PENDING_BODY_WAIT_MS).catch(() => undefined)]);
    }
    for (const name of names) {
      const o = this.#spec.observe?.[name];
      if (o === undefined) {
        values.set(name, UNKNOWN);
        continue;
      }
      const read = await this.#read(page, name, o).catch(() => ({ value: UNKNOWN as EvalValue, evidence: undefined }));
      values.set(name, read.value);
      if (read.evidence !== undefined) evidence.set(name, read.evidence);
    }
    return { values, evidence };
  }

  /**
   * Resolves a probe's `authFrom` (#135) into an `Authorization` header, reading the token from the
   * run's own live session — never from a new credential path. `cookie` reads the browser context's
   * cookie jar; `secret` reads the CLI-resolved `authTokens` map (an `env:VAR` ref this module never
   * resolves itself).
   *
   * `localStorage` (#173): for an OBSERVER (`observer !== null`), it is read straight from that
   * observer's storageState FILE via `ObserverSessions.localStorage` — cheaper, and it never needs
   * the observer's page to have navigated (a probe-only observer, the common "the member CAN read
   * it" cross-actor check, never opens one). Falls back to the live page's own `page.evaluate` when
   * no such reader is wired (the primary actor's own page, always already loaded) or an
   * `ObserverSessions` implementation doesn't offer it — in which case an unread observer token is
   * explained as the page never having loaded that origin, not a bare "unavailable".
   *
   * The token is pushed into the redaction set the instant it is read — before it is ever used in a
   * request — so it can never appear in evidence, an error, or the value the probe returns.
   */
  async #authHeaders(
    page: Page,
    authFrom: ProbeAuthFrom | undefined,
    observer: string | null,
    origin: string,
  ): Promise<{ headers?: Record<string, string>; note: string } | { error: string }> {
    if (authFrom === undefined) return { note: "" };
    const scheme = authFrom.scheme ?? "Bearer";
    const prefix = scheme === "" ? "" : `${scheme} `;
    let token: string | null;
    let source: string;
    if (authFrom.localStorage !== undefined) {
      const key = authFrom.localStorage;
      source = `localStorage:${key}`;
      const fromStorageState = observer === null ? undefined : this.#opts.observers?.localStorage;
      if (fromStorageState !== undefined) {
        token = await fromStorageState(observer as string, key, origin).catch(() => null);
      } else {
        token = await page.evaluate((k) => window.localStorage.getItem(k), key).catch(() => null);
        if (token === null && observer !== null) source = `${source}: observer never loaded ${origin}`;
      }
    } else if (authFrom.cookie !== undefined) {
      const name = authFrom.cookie;
      source = `cookie:${name}`;
      const cookies = await page.context().cookies().catch(() => []);
      token = cookies.find((c) => c.name === name)?.value ?? null;
    } else if (authFrom.secret !== undefined) {
      source = `secret:${authFrom.secret}`;
      token = this.#opts.authTokens?.get(authFrom.secret) ?? null;
    } else {
      return { error: "authFrom names no source" };
    }
    if (token === null || token === "") return { error: `auth token unavailable (${source})` };
    this.#authSecrets.push(token);
    return { headers: { Authorization: `${prefix}${token}` }, note: ` (authenticated via ${source.split(":")[0]})` };
  }

  /**
   * A `dom` observable's visual-state read (#148), by fixed page functions and parsed by code: the
   * first match's in-viewport ratio, a computed style (a number with a `channel`, reduced across
   * matches; else the first match's raw value), or an attribute. Unreadable → missing.
   */
  async #readVisual(
    locator: Locator,
    read: Exclude<NonNullable<DomObservable["read"]>, "text" | "value" | "count">,
    missing: EvalValue,
  ): Promise<{ value: EvalValue; evidence?: string }> {
    if (read === "inViewport") {
      const { boxes, viewport } = await boxesOf(locator.first());
      const box = boxes[0];
      return box === undefined ? { value: missing } : { value: Math.round(intersectionRatio(box, viewport) * 1000) / 1000 };
    }
    if ("attr" in read) {
      const { value } = await attrOf(locator, read.attr);
      return { value: value === null ? missing : this.#clip(value) };
    }
    const raws = await stylesOf(locator, read.style);
    if (read.channel === undefined) {
      const first = raws[0];
      return { value: first === undefined || first === "" ? missing : this.#clip(first) };
    }
    const channel = read.channel;
    const nums = raws.map((r) => styleChannel(r, channel));
    // One unreadable element makes a min/max unknowable: missing, never a partial answer.
    if (nums.length === 0 || nums.some((n) => n === null)) return { value: missing, evidence: `style ${read.style} unreadable` };
    const values = nums as number[];
    const reduce = read.reduce ?? "first";
    const value = reduce === "min" ? Math.min(...values) : reduce === "max" ? Math.max(...values) : (values[0] as number);
    return { value, evidence: `${channel}(${read.style}) ${reduce} over ${values.length} element(s) = ${value}` };
  }

  async #read(page: Page, name: string, o: ObservableSpec, observer: string | null = null): Promise<{ value: EvalValue; evidence?: string }> {
    if ("dom" in o) {
      const d = o.dom;
      const missing: EvalValue = d.optional === true ? null : UNKNOWN;
      const locator = d.selector !== undefined ? page.locator(d.selector) : descriptorToLocator(page, d.target ?? {});
      const count = await locator.count();
      if (d.read === "count") return { value: count };
      if (count === 0) return { value: missing };
      if (d.read !== undefined && d.read !== "text" && d.read !== "value") return this.#readVisual(locator, d.read, missing);
      const first = locator.first();
      const raw = d.read === "value" ? await first.inputValue({ timeout: DOM_TIMEOUT_MS }) : await first.innerText({ timeout: DOM_TIMEOUT_MS });
      const text = raw.trim();
      if (d.number !== undefined && d.number !== false) {
        const nums = parseNumbers(text);
        // #156: "all" is a LIST observable (#147/#148) — a scalar consumer (like #150's
        // `BudgetMonitor`) already treats a list as unreadable, same as a `[*]` network/probe read.
        if (d.number === "all") return nums.length === 0 ? { value: missing } : { value: nums };
        const idx = d.number === true ? 0 : d.number.index;
        const n = nums.at(idx);
        return { value: n === undefined ? missing : n };
      }
      return { value: this.#clip(text) };
    }
    if ("network" in o) {
      const list = this.#networkLists.get(name);
      if (list !== undefined) return { value: list.value, evidence: `network ${list.evidence}` };
      const seen = this.#network.get(name);
      if (seen === undefined) return { value: o.network.optional === true ? null : UNKNOWN };
      return { value: seen.value, evidence: `network ${seen.evidence}` };
    }
    const probe = o.probe;
    const missing: EvalValue = probe.optional === true ? null : UNKNOWN;
    // #147: `${capture.x}` refs are substituted (URL-encoded); an unbound one reads nothing.
    const template = this.#probeTemplate(probe);
    if (template === null) return { value: UNKNOWN, evidence: "probe skipped: a capture it names was never bound" };
    const url = probeUrl(probe.get !== undefined ? { get: template } : { head: template }, this.#opts.baseUrl);
    // Re-checked at request time: a probe NEVER leaves the authorized origins (the dispatch refused
    // it already; this is the fail-closed second gate).
    if (url === null || url.username !== "" || url.password !== "" || !isAuthorizedExploreTarget(url.href, this.#opts.allowlist)) {
      return { value: UNKNOWN, evidence: "probe refused: not an authorized origin" };
    }
    // #135: authenticate from the run's own session — never a new credential path. A declared
    // `authFrom` whose token cannot be read (a missing localStorage key/cookie/env var) fails closed:
    // the probe is refused rather than silently sent unauthenticated (which would misreport state).
    const auth = await this.#authHeaders(page, probe.authFrom, observer, url.origin);
    if ("error" in auth) return { value: UNKNOWN, evidence: `probe refused: ${auth.error}` };
    const method = probe.head !== undefined ? "HEAD" : "GET";
    const res = await page.context().request.fetch(url.href, {
      method,
      ...(auth.headers === undefined ? {} : { headers: auth.headers }),
      maxRedirects: 0,
      failOnStatusCode: false,
      timeout: PROBE_TIMEOUT_MS,
    });
    const evidence = `probe ${method} ${redactUrl(url.href)} → ${res.status()}${auth.note}`;
    try {
      if (probe.json === undefined) return { value: res.status(), evidence };
      if (res.status() < 200 || res.status() >= 300) return { value: missing, evidence };
      const buf = await res.body();
      if (buf.length > MAX_BODY_BYTES) return { value: UNKNOWN, evidence: `${evidence} (body over ${MAX_BODY_BYTES} bytes)` };
      const path = this.#jsonPaths.get(name) ?? [];
      if (jsonPathHasEach(path)) {
        const list = readJsonPathList(JSON.parse(buf.toString("utf8")) as unknown, path);
        return { value: list === undefined ? missing : list.map((v) => this.#clip(v)), evidence };
      }
      const v = readJsonPath(JSON.parse(buf.toString("utf8")) as unknown, path);
      return { value: v === undefined ? missing : this.#clip(v), evidence };
    } finally {
      await res.dispose().catch(() => undefined);
    }
  }

  #clip<T extends ObservedValue>(v: T): T | string {
    if (typeof v !== "string") return v;
    return this.#redact(v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}…` : v);
  }

  #shown(v: EvalValue | undefined): InvariantValue {
    if (v === undefined || v === UNKNOWN) return { unreadable: true };
    if (isList(v)) return { items: v.length };
    return typeof v === "string" ? this.#redact(v) : v;
  }

  #redact(s: string): string {
    return redactText(s, [...(this.#opts.secrets ?? []), ...this.#authSecrets]);
  }
}

function display(v: InvariantValue): string {
  if (v !== null && typeof v === "object") return "items" in v ? `(${v.items} items)` : "(unreadable)";
  return JSON.stringify(v);
}

function isList(v: EvalValue): v is ObservedList {
  return Array.isArray(v);
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/** An invariant violation as a mission finding: deduped by fingerprint, with its reproduction. */
export interface InvariantDefect {
  /** `invariantFingerprint(url, reason, id)` — the declared invariant's id + route. */
  readonly fingerprint: string;
  readonly related: string[];
  readonly kind: "invariant";
  readonly title: string;
  readonly route: string;
  readonly url: string;
  /** The first occurrence's evidence: id, expression, before/after values, action, probe evidence. */
  readonly invariant: InvariantViolation;
  readonly occurrences: number;
  readonly repro: {
    /** Flat index of the Recording step whose action broke the invariant. */
    readonly recordingStepIndex: number;
    /** The finding's own Recording (a coverage/feature path), when the run has no single one. */
    readonly recording?: Recording;
  };
}

/** Collects violations into deduped `InvariantDefect`s (same fingerprint ⇒ one more occurrence). */
export class InvariantDefectLog {
  readonly #defects = new Map<string, { d: InvariantDefect; occurrences: number }>();

  add(v: InvariantViolation, repro: InvariantDefect["repro"]): void {
    const known = this.#defects.get(v.fingerprint);
    if (known !== undefined) {
      known.occurrences += 1;
      return;
    }
    this.#defects.set(v.fingerprint, {
      occurrences: 1,
      d: {
        fingerprint: v.fingerprint,
        related: [v.fingerprint],
        kind: "invariant",
        title: `Invariant "${v.id}" violated on ${v.route}`,
        route: v.route,
        url: v.url,
        invariant: v,
        occurrences: 1,
        repro,
      },
    });
  }

  get size(): number {
    return this.#defects.size;
  }

  defects(): InvariantDefect[] {
    return [...this.#defects.values()].map(({ d, occurrences }) => ({ ...d, occurrences }));
  }
}

/** Flat step count of a Recording (the next step's index). */
export function recordingStepCount(recording: Recording): number {
  return recording.pages.reduce((n, p) => n + p.steps.length, 0);
}
