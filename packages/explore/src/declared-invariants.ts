import type { Page, Response } from "playwright";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
import { checkAssertion } from "@jevitate/interpreter";
import { descriptorToLocator } from "@jevitate/recorder";
import {
  UNKNOWN,
  evaluateInvariantExpression,
  expressionObservables,
  globRegex,
  matchesPattern,
  parseInvariantExpression,
  parseJsonPath,
  patternRegex,
  probeUrl,
  readJsonPath,
  type DeclaredInvariant,
  type EvalValue,
  type ExprNode,
  type InvariantSpec,
  type JsonPathSegment,
  type ObservableSpec,
  type ProbeAuthFrom,
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
 * Read-only by construction:
 *  - `dom` reads text/value/count of the first match of a target on the current page;
 *  - `network` reads a JSON path in the last response (to an authorized origin) whose URL matches;
 *  - `probe` is a GET or HEAD of an authorized origin through the mission browser context's own
 *    request client (its own cookies — no new credential path), no redirects followed, bounded
 *    body, re-checked against the allowlist at request time (the dispatch already refused any
 *    other origin). Only the extracted scalar survives, redacted; never the body.
 */

/** A value as it appears in a finding: the observed scalar, or that it could not be read. */
export type InvariantValue = ObservedValue | { readonly unreadable: true };

export interface InvariantAction {
  /** The op acted (`click`, `type`, …); null for a check with no action (a seed load). */
  readonly op: string | null;
  /** The acted control's accessible name (null when target-free). */
  readonly control: string | null;
  /** The page URL the action was taken on. */
  readonly url: string;
}

export interface InvariantViolation {
  readonly id: string;
  readonly kind: "require" | "never" | "always";
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
}

const DOM_TIMEOUT_MS = 1_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_VALUE_CHARS = 120;
const DEFAULT_SETTLE_POLL_MS = 1_000;
const PENDING_BODY_WAIT_MS = 2_000;

function namesUsing(ast: ExprNode, fns: ReadonlyArray<"before" | "after" | "delta">): string[] {
  const out = new Set<string>();
  const walk = (n: ExprNode): void => {
    if (n.t === "obs" && fns.includes(n.fn)) out.add(n.name);
    else if (n.t === "neg") walk(n.e);
    else if (n.t === "bin") {
      walk(n.l);
      walk(n.r);
    }
  };
  walk(ast);
  return [...out];
}

/** The first number in a text (`"≈ 1,240 credits"` → 1240, `"-5"` → -5); null when there is none. */
export function parseFirstNumber(text: string): number | null {
  const m = /-?\d[\d,]*(\.\d+)?/.exec(text);
  if (m === null) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
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
  readonly #tally = new Map<string, { checked: number; held: number; violated: number; unknown: number }>();
  /** Every auth token this monitor has read (#135): scrubbed from evidence/values the instant it's read. */
  readonly #authSecrets: string[] = [];
  #before: Snapshot | null = null;

  constructor(spec: InvariantSpec, opts: InvariantMonitorOptions) {
    this.#spec = spec;
    this.#opts = opts;
    this.#invariants = spec.invariants.map((decl) => {
      const ast = decl.require === undefined ? null : parseInvariantExpression(decl.require);
      return {
        decl,
        ast,
        afterNames: ast === null ? [] : namesUsing(ast, ["after", "delta"]),
        beforeNames: ast === null ? [] : namesUsing(ast, ["before", "delta"]),
      };
    });
    for (const [name, o] of Object.entries(spec.observe ?? {})) {
      const path = "network" in o ? o.network.json : "probe" in o ? o.probe.json : undefined;
      if (path !== undefined) this.#jsonPaths.set(name, parseJsonPath(path));
    }
    for (const inv of spec.invariants) this.#tally.set(inv.id, { checked: 0, held: 0, violated: 0, unknown: 0 });
  }

  /** The spec this monitor evaluates (persisted with a result so verify-fix re-checks the same one). */
  get spec(): InvariantSpec {
    return this.#spec;
  }

  /** Every invariant's tally so far. */
  report(): InvariantReport[] {
    return this.#spec.invariants.map((inv) => ({ id: inv.id, ...(this.#tally.get(inv.id) ?? { checked: 0, held: 0, violated: 0, unknown: 0 }) }));
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
    if (read.value === UNKNOWN) return { value: null, unreadable: true, ...(read.evidence === undefined ? {} : { evidence: read.evidence }) };
    return { value: read.value, unreadable: false, ...(read.evidence === undefined ? {} : { evidence: read.evidence }) };
  }

  /**
   * Starts listening for `network` observables on a page. Idempotent; `before`/`after` call it, but a
   * mission should call it BEFORE its first navigation so the seed load's responses are seen.
   */
  attach(page: Page): void {
    if (this.#attached.has(page)) return;
    this.#attached.add(page);
    const network = Object.entries(this.#spec.observe ?? {}).filter(
      (e): e is [string, { network: NonNullable<Extract<ObservableSpec, { network: unknown }>["network"]> }] => "network" in e[1],
    );
    if (network.length === 0) return;
    page.on("response", (response: Response) => {
      const url = response.url();
      if (!isAuthorizedExploreTarget(url, this.#opts.allowlist)) return;
      const method = response.request().method().toUpperCase();
      const hits = network.filter(([, o]) => matchesUrlGlob(o.network.url, url) && (o.network.method === undefined || o.network.method.toUpperCase() === method));
      if (hits.length === 0) return;
      const read = response
        .body()
        .then((buf) => {
          if (buf.length > MAX_BODY_BYTES) return;
          const body: unknown = JSON.parse(buf.toString("utf8"));
          for (const [name] of hits) {
            const v = readJsonPath(body, this.#jsonPaths.get(name) ?? []);
            if (v === undefined) continue;
            this.#network.set(name, { value: this.#clip(v), evidence: `${method} ${redactUrl(url)} → ${response.status()}` });
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
    const names = new Set(this.#invariants.flatMap((c) => c.beforeNames));
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
      (c) => (opts.only === undefined || c.decl.id === opts.only) && (opts.force === true || this.#applies(c.decl, action)),
    );
    const afterNames = new Set(applicable.flatMap((c) => c.afterNames));
    const beforeNames = new Set(this.#invariants.flatMap((c) => c.beforeNames));
    if (opts.rearm === true) for (const n of beforeNames) afterNames.add(n);
    const after = await this.#snapshot(page, afterNames);
    let polled = false;
    const violations: InvariantViolation[] = [];
    const unknown: string[] = [];
    const held: string[] = [];
    const pageUrl = safeUrl(page);
    for (const c of applicable) {
      const tally = this.#tally.get(c.decl.id) ?? { checked: 0, held: 0, violated: 0, unknown: 0 };
      this.#tally.set(c.decl.id, tally);
      tally.checked += 1;
      const verdict = await this.#evaluate(c, page, actor, action, before, after, pageUrl);
      if (c.decl.settle !== undefined && verdict !== "held") polled = true;
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
    return { violations, unknown, held };
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
    ): InvariantViolation => {
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
        evidence,
        ...(settledForMs === undefined ? {} : { settledForMs }),
      };
    };

    if (decl.always !== undefined) {
      const ok = await checkAssertion(actor, decl.always, { timeoutMs: 500 }).catch(() => null);
      if (ok === null) return "unknown";
      return ok ? "held" : make("always", `always ${JSON.stringify(decl.always)}`, "", {}, []);
    }
    if (decl.never !== undefined) {
      const never = decl.never;
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
      before: (n: string) => (before.values.has(n) ? (before.values.get(n) as EvalValue) : UNKNOWN),
      after: (n: string) => (a.values.has(n) ? (a.values.get(n) as EvalValue) : UNKNOWN),
    });
    let result = evaluateInvariantExpression(ast, env(after));
    let settledForMs: number | undefined;
    if (result !== true && decl.settle !== undefined) {
      // Eventual consistency: re-check until it holds or the window closes. Only the observables this
      // invariant reads are re-read.
      const now = this.#opts.now ?? Date.now;
      const start = now();
      const poll = decl.settle.pollMs ?? DEFAULT_SETTLE_POLL_MS;
      const sleep = this.#opts.sleep ?? ((p: Page, ms: number) => p.waitForTimeout(ms));
      while (result !== true && now() - start < decl.settle.withinMs) {
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
   * run's own live session — never from a new credential path. `localStorage` is read via
   * `page.evaluate` (in the page's own JS context); `cookie` from the browser context's cookie jar;
   * `secret` from the CLI-resolved `authTokens` map (an `env:VAR` ref this module never resolves
   * itself). The token is pushed into the redaction set the instant it is read — before it is ever
   * used in a request — so it can never appear in evidence, an error, or the value the probe returns.
   */
  async #authHeaders(
    page: Page,
    authFrom: ProbeAuthFrom | undefined,
  ): Promise<{ headers?: Record<string, string>; note: string } | { error: string }> {
    if (authFrom === undefined) return { note: "" };
    const scheme = authFrom.scheme ?? "Bearer";
    const prefix = scheme === "" ? "" : `${scheme} `;
    let token: string | null;
    let source: string;
    if (authFrom.localStorage !== undefined) {
      const key = authFrom.localStorage;
      source = `localStorage:${key}`;
      token = await page.evaluate((k) => window.localStorage.getItem(k), key).catch(() => null);
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

  async #read(page: Page, name: string, o: ObservableSpec): Promise<{ value: EvalValue; evidence?: string }> {
    if ("dom" in o) {
      const d = o.dom;
      const missing: EvalValue = d.optional === true ? null : UNKNOWN;
      const locator = d.selector !== undefined ? page.locator(d.selector) : descriptorToLocator(page, d.target ?? {});
      const count = await locator.count();
      if (d.read === "count") return { value: count };
      if (count === 0) return { value: missing };
      const first = locator.first();
      const raw = d.read === "value" ? await first.inputValue({ timeout: DOM_TIMEOUT_MS }) : await first.innerText({ timeout: DOM_TIMEOUT_MS });
      const text = raw.trim();
      if (d.number === true) {
        const n = parseFirstNumber(text);
        return { value: n === null ? missing : n };
      }
      return { value: this.#clip(text) };
    }
    if ("network" in o) {
      const seen = this.#network.get(name);
      if (seen === undefined) return { value: o.network.optional === true ? null : UNKNOWN };
      return { value: seen.value, evidence: `network ${seen.evidence}` };
    }
    const probe = o.probe;
    const missing: EvalValue = probe.optional === true ? null : UNKNOWN;
    const url = probeUrl(probe, this.#opts.baseUrl);
    // Re-checked at request time: a probe NEVER leaves the authorized origins (the dispatch refused
    // it already; this is the fail-closed second gate).
    if (url === null || url.username !== "" || url.password !== "" || !isAuthorizedExploreTarget(url.href, this.#opts.allowlist)) {
      return { value: UNKNOWN, evidence: "probe refused: not an authorized origin" };
    }
    // #135: authenticate from the run's own session — never a new credential path. A declared
    // `authFrom` whose token cannot be read (a missing localStorage key/cookie/env var) fails closed:
    // the probe is refused rather than silently sent unauthenticated (which would misreport state).
    const auth = await this.#authHeaders(page, probe.authFrom);
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
      const v = readJsonPath(JSON.parse(buf.toString("utf8")) as unknown, this.#jsonPaths.get(name) ?? []);
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
    return typeof v === "string" ? this.#redact(v) : v;
  }

  #redact(s: string): string {
    return redactText(s, [...(this.#opts.secrets ?? []), ...this.#authSecrets]);
  }
}

function display(v: InvariantValue): string {
  if (v !== null && typeof v === "object") return "(unreadable)";
  return JSON.stringify(v);
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
