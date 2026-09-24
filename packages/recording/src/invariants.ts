import { z } from "zod";
import {
  ATTR_NAME_RE,
  AssertionSchema,
  STYLE_PROPERTIES,
  TargetDescriptorSchema,
  type Assertion,
  type StyleChannel,
  type StyleProperty,
  type TargetDescriptor,
} from "./schema.js";

/**
 * App-declared invariants (#86): a CLOSED, declarative spec a caller hands to a dispatch
 * (`--invariants <file>`, `MissionRequest.invariants`, the MCP `queue_exploration` argument) so
 * Jevitate can check app-specific hard rules around every action — "if the credit balance went
 * down, the imports list grew" — the same way it treats a console error or a 5xx.
 *
 * Nothing here is ever `eval`ed. The spec is data:
 *
 *  - `observe`: named, READ-ONLY observables —
 *      `dom`     text / value / count / number read from a target on the current page (the
 *                recording `TargetDescriptor` vocabulary, or a CSS `selector` shorthand) — or its
 *                visual state (#148): a computed style (`{ style, channel?, reduce? }`), an
 *                attribute (`{ attr }`), or `inViewport` (the box's visible fraction, 0..1);
 *      `network` a JSON path in the last captured response whose URL matches a glob;
 *      `probe`   a `get` (or `head`) of an existing endpoint on an AUTHORIZED origin, with the
 *                mission session's own cookies — never another method, never another origin.
 *  - `invariants`: each one is exactly one of
 *      `require` a tiny expression over the observables, snapshotted around the action:
 *                `before(x)`, `after(x)` (= bare `x`), `delta(x)`; `+ - * /`; `== != < <= > >=`;
 *                `&&`, `||`, `->` (implication); `null`, `true`, `false`. Parsed here into an AST
 *                and evaluated by a small interpreter — three-valued: an observable that could not
 *                be read makes the result `unknown`, which is never a violation and never a pass;
 *      `never`   page text matching a pattern, or a recording `Assertion` that must never hold;
 *      `always`  a recording `Assertion` that must hold after every action.
 *  - `budget`: mission spend budgets (#150) over a declared observable — a cumulative cap
 *      (`maxDelta`) on the change from the run's baseline reading, with an optional pre-action
 *      `guard` that refuses a paid action whose estimated cost would cross what remains. Crossing a
 *      budget stops the mission cleanly, before its next action; browser-side tracking (`baseline`,
 *      the guard, the post-settle check) lives in `@jevitate/explore`'s `BudgetMonitor`.
 *
 * Multi-actor missions (#147) add CROSS-ACTOR checks: `capture` binds a resource id (or URL) from
 * the primary actor's run; a `probe` with `as: <actor>` reads in an observer actor's OWN context;
 * an invariant gated on `when.after: "capture.<name>"` runs once, right after that capture binds —
 * either a `require` over the observer's observables (`!contains(intruderList, itemId)`) or a
 * `deniedAs` passive open of the resource in the observer's context.
 *
 * This module is pure (schema + parser + evaluator) so the dispatch surfaces can reject a bad spec
 * — with a precise path like `invariants[2].require: unknown observable "balanse"` — before any
 * browser work. The browser-side evaluation lives in `@jevitate/explore`.
 */

/** A declared observable name: an identifier that is not one of the expression's keywords. */
export const OBSERVABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["before", "after", "delta", "contains", "null", "true", "false"]);
/** An invariant id: same path-safe format as mission/journey ids (it keys a fingerprint). */
export const INVARIANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Bounds on the eventual-consistency window (`settle`). */
export const MAX_SETTLE_WITHIN_MS = 10 * 60_000;
export const MIN_SETTLE_POLL_MS = 250;
/** An actor name (#147): the same format as a `--persona` name. */
export const ACTOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** `${capture.<name>}` in a probe path or a `deniedAs.open` (#147). */
const CAPTURE_REF_RE = /\$\{capture\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** A `when.after` naming a capture (#147). */
const CAPTURE_GATE_RE = /^capture\.([A-Za-z_][A-Za-z0-9_]*)$/;
/** Hard caps on a spec's size (it is caller input on the MCP path). */
export const MAX_OBSERVABLES = 64;
export const MAX_INVARIANTS = 64;
/** A budget-declaration cap (#150): a run's spend axes are few by design, not a general-purpose list. */
export const MAX_BUDGETS = 8;
const MAX_EXPRESSION_CHARS = 1_000;

export interface DomObservable {
  /** A CSS selector (shorthand for `target: { css }`). Exactly one of `selector` / `target`. */
  selector?: string;
  target?: TargetDescriptor;
  /**
   * What to read: the FIRST match's text (default) or form value, the match count, or its visual
   * state (#148) — see `DomRead`.
   */
  read?: DomRead;
  /**
   * Parse the number(s) out of what was read (`"≈ 1,240 credits"` → 1240; a Unicode minus U+2212 and
   * thousands separators are handled). `true` reads the FIRST number (index 0, the default); `{
   * index }` reads the number at that 0-based position (negative counts from the end, so `-1` is the
   * LAST) — e.g. `"≈ 30–90 credits"` with `{ index: 1 }` reads 90, a range's upper bound; `"all"`
   * reads every number as a LIST observable (#147/#148's list-valued reads) — a scalar consumer (like
   * #150's `BudgetMonitor`) treats it as unreadable, same as a `[*]` network/probe read.
   */
  number?: boolean | "all" | { readonly index: number };
  /** When the element is absent the value is `null` (instead of "could not be read"). */
  optional?: boolean;
}

/**
 * A `dom` observable's read. Besides `text`/`value`/`count`:
 *  - `inViewport` — the first match's visible fraction of its box inside the viewport (0..1);
 *  - `{ style, channel?, reduce? }` — the COMPUTED value of an allowlisted CSS property, parsed by
 *    code: with a `channel` (a color's `alpha`/`r`/`g`/`b`, a length's `px`) a number, else the raw
 *    string. `reduce` picks across matches: `first` (default), `min`/`max` (numeric: need a channel);
 *  - `{ attr }` — an attribute of the first match (absent attribute → the observable is missing).
 * All are read by fixed built-in page functions — never a declared string evaluated as JS.
 */
export type DomRead =
  | "text"
  | "value"
  | "count"
  | "inViewport"
  | { style: StyleProperty; channel?: StyleChannel; reduce?: "first" | "min" | "max" }
  | { attr: string };

export interface NetworkObservable {
  /** URL glob over the full URL (`**` any run, `*` any run without `/`); a leading `/` globs path+query. */
  url: string;
  /** Only responses to this request method (default: any). */
  method?: string;
  /** JSON path into the response body, e.g. `$.entries[0].credits`. */
  json: string;
  optional?: boolean;
}

/**
 * Authenticates a probe from the run's own session (#135) — never a new credential path. Exactly one
 * source:
 *  - `localStorage` — a key read from the live page's `localStorage` (via `page.evaluate`);
 *  - `cookie`       — a named cookie's value, read from the browser context;
 *  - `secret`       — a `--secret`/env reference (`env:VAR`), resolved by the CLI dispatch — never
 *                      read from a file here.
 * The value becomes the probe's `Authorization` header, prefixed by `scheme` (default `Bearer`; `""`
 * sends the raw value with no prefix). The token itself never reaches the model, is never persisted,
 * and is redacted from every evidence line the same way a bound secret is.
 */
export interface ProbeAuthFrom {
  localStorage?: string;
  cookie?: string;
  secret?: string;
  /** Prefixed onto the Authorization header's value. Default `"Bearer"`; `""` = no prefix. */
  scheme?: string;
}

export interface ProbeObservable {
  /** A read-only GET of this path (resolved against the mission's start URL) or absolute URL. */
  get?: string;
  /** A read-only HEAD (its value is the HTTP status). Exactly one of `get` / `head`. */
  head?: string;
  /** JSON path into a GET's body; without it the value is the HTTP status. */
  json?: string;
  optional?: boolean;
  /** Authenticates the probe from the run's session (#135); see `ProbeAuthFrom`. */
  authFrom?: ProbeAuthFrom;
  /**
   * #147: read in this OBSERVER actor's own browser context (its own cookies), never the primary's.
   * Only a capture-gated invariant (`when.after: "capture.<name>"`) may read such an observable.
   */
  as?: string;
}

export type ObservableSpec = { dom: DomObservable } | { network: NetworkObservable } | { probe: ProbeObservable };

/** When a `require`/`always` invariant is checked. Every given field must match. Absent ⇒ after every action. */
export interface InvariantWhen {
  /**
   * `"action"` (the default), or `"capture.<name>"` (#147): a CROSS-ACTOR check, run ONCE, right
   * after that capture is first bound from the primary's run (then `when` takes no other key).
   */
  after?: "action" | `capture.${string}`;
  /** The acted control's accessible name: `"/regex/flags"` or an exact string. */
  control?: { name: string };
  /** The route the action was taken on (path glob, e.g. `/billing/**`). */
  route?: string;
  /** Only these action ops (click, type, select, send, …). */
  op?: string[];
}

export interface InvariantSettle {
  /** Re-check a violated invariant until it holds or this window closes (ms). */
  withinMs: number;
  /** Interval between re-checks (ms). Default 1000. */
  pollMs?: number;
}

export type InvariantNever = { pageText: string } | { assertion: Assertion };

/**
 * #147 — which of the primary actor's actions a capture binds after. Every given field must match
 * (the same vocabulary as `InvariantWhen`).
 */
export interface CaptureWhen {
  control?: { name: string };
  /** The route the action was taken on (path glob). */
  route?: string;
  op?: string[];
}

/**
 * #147 — a resource id (or URL) taken from the PRIMARY actor's run, so an observer's checks can
 * ask about exactly that resource. Bound once (its first value); read-only like every observable:
 *  - `network` a JSON path in a captured response (to an authorized origin) whose URL matches;
 *  - `dom`     text / form value / an attribute (`attr:data-id`) of the first match on the page;
 *  - `url`     the primary's page URL once an action matching `after` settled (and, with `route`,
 *              only when that URL's path matches the glob).
 */
export type CaptureSpec =
  | { network: { url: string; method?: string; json: string } }
  | { dom: { selector: string; read?: string; after?: CaptureWhen } }
  | { url: { after: CaptureWhen; route?: string } };

/**
 * #147 — "the observer is DENIED this resource": navigate the observer's own context to `open`
 * (passive: the app makes its own reads) and hold when ANY declared expectation is observed. A 200
 * page with none of them is a violation; an observer bounced to a login page is "session lost"
 * (undecided), never "denied".
 */
export interface DeniedAsSpec {
  /** The observer actor (a registered `--actor` other than the primary). */
  actor: string;
  /** Path or absolute URL; `${capture.<name>}` is substituted (a `url` capture may be the whole of it). */
  open: string;
  expect: {
    /** The observer's document (main-frame) response status is one of these. */
    documentStatus?: number[];
    /** An app response whose URL matches `url` has one of these statuses or Connect/gRPC codes. */
    appResponses?: { url: string; status?: number[]; connectCode?: string[] };
    /** Page text matching this pattern (`"/re/flags"` or a literal) is visible. */
    orVisible?: string;
  };
}

export interface DeclaredInvariant {
  id: string;
  description?: string;
  when?: InvariantWhen;
  require?: string;
  never?: InvariantNever;
  always?: Assertion;
  /** #147: a cross-actor denial check (needs `when.after: "capture.<name>"`). */
  deniedAs?: DeniedAsSpec;
  settle?: InvariantSettle;
}

/**
 * A mission spend budget (#150) over a declared observable: `observe` names an entry in this same
 * spec's `observe` map (a `dom` read or a read-only `probe`, authenticated like any other #86/#135
 * observable — never a new credential path). `maxDelta` is a cumulative cap on `current - baseline`
 * since the run's first settled snapshot: negative caps spend (a balance that must not drop past
 * it), positive caps growth. Crossing it stops the mission cleanly, before its next action.
 */
export interface BudgetGuard {
  /** A constant per-action cost, or an observable name read BEFORE the action (e.g. a shown estimate). */
  estimate: number | string;
  /** Safety margin over the estimate (a real charge can run higher than shown, #150's A25). Default 1. */
  factor?: number;
}

export interface BudgetDeclaration {
  /** The named observable this budget tracks (must be declared in this spec's `observe`). */
  observe: string;
  /** The cumulative change from baseline that ends the run: negative caps spend, positive caps growth. */
  maxDelta: number;
  /** Refuses a paid action (#116) whose estimated cost would cross the remaining budget. */
  guard?: BudgetGuard;
  /** Keeps re-reading after the loop ends, to catch a charge that settles after the last action. */
  settle?: InvariantSettle;
  /** `stop` (default): an observable that cannot be read fails closed. `continue`: skip that check. */
  onUnreadable?: "stop" | "continue";
}

export interface InvariantSpec {
  version?: 1;
  /** #147: resource ids/URLs bound from the primary actor's run. */
  capture?: Record<string, CaptureSpec>;
  observe?: Record<string, ObservableSpec>;
  invariants: DeclaredInvariant[];
  /** Mission spend budgets (#150) over this spec's declared observables. */
  budget?: BudgetDeclaration[];
}

// === Expression language ===

export type ExprNode =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "lit"; readonly v: null | boolean }
  | { readonly t: "obs"; readonly fn: "before" | "after" | "delta"; readonly name: string }
  | { readonly t: "neg"; readonly e: ExprNode }
  /** `!x` (#147): Kleene negation — unknown stays unknown. */
  | { readonly t: "not"; readonly e: ExprNode }
  /** `contains(list, x)` (#147): a list (`[*]` path) or text holds the value. */
  | { readonly t: "contains"; readonly l: ExprNode; readonly r: ExprNode }
  | { readonly t: "bin"; readonly op: BinOp; readonly l: ExprNode; readonly r: ExprNode };

export type BinOp = "+" | "-" | "*" | "/" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||" | "->";

export class InvariantExpressionError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
    this.name = "InvariantExpressionError";
  }
}

type Tok = { k: "num"; v: number; at: number } | { k: "id"; v: string; at: number } | { k: "op"; v: string; at: number };

const OPS = ["->", "&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "(", ")", "!", ","];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num !== null) {
      out.push({ k: "num", v: Number(num[0]), at: i });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id !== null) {
      out.push({ k: "id", v: id[0], at: i });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw new InvariantExpressionError(`unexpected character ${JSON.stringify(c)} at ${i}`, i);
    out.push({ k: "op", v: op, at: i });
    i += op.length;
  }
  return out;
}

/**
 * Parses an invariant expression into an AST. Throws `InvariantExpressionError` (with the offset)
 * on anything outside the grammar — there is no escape hatch to code.
 */
export function parseInvariantExpression(src: string): ExprNode {
  if (src.length > MAX_EXPRESSION_CHARS) throw new InvariantExpressionError(`expression longer than ${MAX_EXPRESSION_CHARS} chars`, 0);
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const isOp = (v: string): boolean => {
    const t = peek();
    return t !== undefined && t.k === "op" && t.v === v;
  };
  const expectOp = (v: string): void => {
    const t = peek();
    if (t === undefined || t.k !== "op" || t.v !== v) {
      throw new InvariantExpressionError(`expected "${v}" at ${t === undefined ? src.length : t.at}`, t?.at ?? src.length);
    }
    p += 1;
  };
  const binary = (next: () => ExprNode, ops: readonly BinOp[]): ExprNode => {
    let l = next();
    for (;;) {
      const t = peek();
      if (t === undefined || t.k !== "op" || !ops.includes(t.v as BinOp)) return l;
      p += 1;
      l = { t: "bin", op: t.v as BinOp, l, r: next() };
    }
  };
  const primary = (): ExprNode => {
    const t = peek();
    if (t === undefined) throw new InvariantExpressionError("unexpected end of expression", src.length);
    if (t.k === "num") {
      p += 1;
      return { t: "num", v: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      p += 1;
      const e = impl();
      expectOp(")");
      return e;
    }
    if (t.k === "op" && t.v === "-") {
      p += 1;
      return { t: "neg", e: primary() };
    }
    if (t.k === "op" && t.v === "!") {
      p += 1;
      return { t: "not", e: primary() };
    }
    if (t.k === "id") {
      p += 1;
      if (t.v === "contains") {
        expectOp("(");
        const l = impl();
        expectOp(",");
        const r = impl();
        expectOp(")");
        return { t: "contains", l, r };
      }
      if (t.v === "null") return { t: "lit", v: null };
      if (t.v === "true") return { t: "lit", v: true };
      if (t.v === "false") return { t: "lit", v: false };
      if (t.v === "before" || t.v === "after" || t.v === "delta") {
        expectOp("(");
        const arg = peek();
        if (arg === undefined || arg.k !== "id" || RESERVED.has(arg.v)) {
          throw new InvariantExpressionError(`${t.v}() takes one observable name (at ${arg?.at ?? src.length})`, arg?.at ?? src.length);
        }
        p += 1;
        expectOp(")");
        return { t: "obs", fn: t.v, name: arg.v };
      }
      return { t: "obs", fn: "after", name: t.v };
    }
    throw new InvariantExpressionError(`unexpected "${t.v}" at ${t.at}`, t.at);
  };
  const mul = (): ExprNode => binary(primary, ["*", "/"]);
  const add = (): ExprNode => binary(mul, ["+", "-"]);
  const cmp = (): ExprNode => {
    const l = add();
    const t = peek();
    if (t !== undefined && t.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      p += 1;
      return { t: "bin", op: t.v as BinOp, l, r: add() };
    }
    return l;
  };
  const and = (): ExprNode => binary(cmp, ["&&"]);
  const or = (): ExprNode => binary(and, ["||"]);
  // `->` is right-associative: a -> b -> c  ≡  a -> (b -> c).
  const impl = (): ExprNode => {
    const l = or();
    if (isOp("->")) {
      p += 1;
      return { t: "bin", op: "->", l, r: impl() };
    }
    return l;
  };
  if (toks.length === 0) throw new InvariantExpressionError("empty expression", 0);
  const ast = impl();
  const rest = peek();
  if (rest !== undefined) throw new InvariantExpressionError(`unexpected "${rest.v}" at ${rest.at}`, rest.at);
  return ast;
}

/** Visits every node of an expression (pre-order). */
export function walkExpression(ast: ExprNode, visit: (n: ExprNode) => void): void {
  visit(ast);
  if (ast.t === "neg" || ast.t === "not") walkExpression(ast.e, visit);
  else if (ast.t === "bin" || ast.t === "contains") {
    walkExpression(ast.l, visit);
    walkExpression(ast.r, visit);
  }
}

/** Every observable (or capture) name an expression reads. */
export function expressionObservables(ast: ExprNode): string[] {
  const out = new Set<string>();
  walkExpression(ast, (n) => {
    if (n.t === "obs") out.add(n.name);
  });
  return [...out];
}

/** A snapshotted observable value. `UNKNOWN` = it could not be read (never a violation, never a pass). */
export const UNKNOWN: unique symbol = Symbol("unknown");
export type ObservedValue = number | string | boolean | null;
/** A `[*]` JSON path's values (#147): only `contains()` reads it; it is never shown item by item. */
export type ObservedList = readonly ObservedValue[];
export type EvalValue = ObservedValue | ObservedList | typeof UNKNOWN;

export interface ExpressionEnv {
  readonly before: (name: string) => EvalValue;
  readonly after: (name: string) => EvalValue;
}

/** Three-valued evaluation: `true` holds, `false` is violated, `UNKNOWN` could not be decided. */
export function evaluateInvariantExpression(ast: ExprNode, env: ExpressionEnv): boolean | typeof UNKNOWN {
  const v = evalNode(ast, env);
  return typeof v === "boolean" ? v : UNKNOWN;
}

function evalNode(n: ExprNode, env: ExpressionEnv): EvalValue {
  switch (n.t) {
    case "num":
      return n.v;
    case "lit":
      return n.v;
    case "obs": {
      if (n.fn === "before") return env.before(n.name);
      if (n.fn === "after") return env.after(n.name);
      const a = env.after(n.name);
      const b = env.before(n.name);
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      if (a === null || b === null) return null;
      return typeof a === "number" && typeof b === "number" ? a - b : UNKNOWN;
    }
    case "neg": {
      const v = evalNode(n.e, env);
      if (v === UNKNOWN || v === null) return v;
      return typeof v === "number" ? -v : UNKNOWN;
    }
    case "not": {
      const v = asBool(evalNode(n.e, env));
      return v === UNKNOWN ? UNKNOWN : !v;
    }
    case "contains":
      return evalContains(evalNode(n.l, env), evalNode(n.r, env));
    case "bin":
      return evalBin(n.op, n.l, n.r, env);
  }
}

/**
 * `contains(haystack, needle)`: a list holds an item equal to the needle (ids compare as text, so
 * `42` matches `"42"`), or a text includes it. A missing (`null`) haystack holds nothing; a missing
 * needle decides nothing.
 */
function evalContains(hay: EvalValue, needle: EvalValue): EvalValue {
  if (hay === UNKNOWN || needle === UNKNOWN || needle === null || Array.isArray(needle)) return UNKNOWN;
  if (hay === null) return false;
  const want = String(needle);
  if (Array.isArray(hay)) return hay.some((item) => item !== null && String(item) === want);
  if (typeof hay === "string") return want !== "" && hay.includes(want);
  return UNKNOWN;
}

function evalBin(op: BinOp, ln: ExprNode, rn: ExprNode, env: ExpressionEnv): EvalValue {
  if (op === "&&" || op === "||" || op === "->") {
    const l = asBool(evalNode(ln, env));
    // Kleene logic: a decided left side can settle the result without the right one.
    if (op === "&&" && l === false) return false;
    if (op === "||" && l === true) return true;
    if (op === "->" && l === false) return true;
    const r = asBool(evalNode(rn, env));
    if (op === "&&") return l === true && r === true ? true : r === false ? false : UNKNOWN;
    if (op === "||") return r === true ? true : l === false && r === false ? false : UNKNOWN;
    // ->: l is true or unknown here.
    return r === true ? true : l === true && r === false ? false : UNKNOWN;
  }
  const l = evalNode(ln, env);
  const r = evalNode(rn, env);
  if (l === UNKNOWN || r === UNKNOWN) return UNKNOWN;
  // A list is only ever read through contains().
  if (Array.isArray(l) || Array.isArray(r)) return UNKNOWN;
  if (op === "==") return l === r;
  if (op === "!=") return l !== r;
  if (l === null || r === null) return op === "+" || op === "-" || op === "*" || op === "/" ? null : UNKNOWN;
  if (typeof l !== "number" || typeof r !== "number") return UNKNOWN;
  switch (op) {
    case "+":
      return l + r;
    case "-":
      return l - r;
    case "*":
      return l * r;
    case "/":
      return r === 0 ? UNKNOWN : l / r;
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
  }
  return UNKNOWN;
}

function asBool(v: EvalValue): boolean | typeof UNKNOWN {
  return typeof v === "boolean" ? v : UNKNOWN;
}

// === JSON path (tiny subset) ===

/** `[*]` (#147): every element of an array. */
export const JSON_PATH_EACH: { readonly each: true } = Object.freeze({ each: true as const });
export type JsonPathSegment = string | number | typeof JSON_PATH_EACH;

/** `$`, `.key`, `[n]`, `["key"]`, `[*]` — nothing else (no filters, no recursive descent, no script). */
export function parseJsonPath(src: string): JsonPathSegment[] {
  if (!src.startsWith("$")) throw new Error(`a JSON path starts with "$", got ${JSON.stringify(src)}`);
  const out: JsonPathSegment[] = [];
  let i = 1;
  while (i < src.length) {
    const rest = src.slice(i);
    const key = /^\.([A-Za-z_$][A-Za-z0-9_$-]*)/.exec(rest);
    if (key !== null) {
      out.push(key[1] as string);
      i += key[0].length;
      continue;
    }
    const idx = /^\[(\d+)\]/.exec(rest);
    if (idx !== null) {
      out.push(Number(idx[1]));
      i += idx[0].length;
      continue;
    }
    if (rest.startsWith("[*]")) {
      out.push(JSON_PATH_EACH);
      i += 3;
      continue;
    }
    const quoted = /^\["([^"\\]*)"\]/.exec(rest);
    if (quoted !== null) {
      out.push(quoted[1] as string);
      i += quoted[0].length;
      continue;
    }
    throw new Error(`unsupported JSON path syntax at ${i} in ${JSON.stringify(src)}`);
  }
  return out;
}

/** Does a JSON path fan out (`[*]`)? Its value is then a list (`readJsonPathList`). */
export function jsonPathHasEach(path: readonly JsonPathSegment[]): boolean {
  return path.some((seg) => seg === JSON_PATH_EACH);
}

/**
 * Reads a fanned-out JSON path (`$.items[*].id`) into the list of scalars it reaches — objects and
 * missing members are skipped. `undefined` when the path's fixed prefix (before the first `[*]`)
 * is missing.
 */
export function readJsonPathList(value: unknown, path: readonly JsonPathSegment[]): ObservedValue[] | undefined {
  let cur: unknown[] = [value];
  let fanned = false;
  for (const seg of path) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (v === null || typeof v !== "object") continue;
      if (seg === JSON_PATH_EACH) {
        if (Array.isArray(v)) next.push(...(v as unknown[]));
      } else if (typeof seg === "number") {
        if (Array.isArray(v) && seg < v.length) next.push(v[seg]);
      } else if (typeof seg === "string" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, seg)) {
        next.push((v as Record<string, unknown>)[seg]);
      }
    }
    if (seg === JSON_PATH_EACH) {
      if (!fanned && !cur.some((v) => Array.isArray(v))) return undefined;
      fanned = true;
    } else if (!fanned && next.length === 0) return undefined;
    cur = next;
  }
  return cur.filter((v): v is ObservedValue => v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean");
}

/** Reads a JSON path; `undefined` when a segment is missing. Only scalars come back (objects → undefined). */
export function readJsonPath(value: unknown, path: readonly JsonPathSegment[]): ObservedValue | undefined {
  // A fanned-out path read as one value is its size ("the list grew").
  if (jsonPathHasEach(path)) return readJsonPathList(value, path)?.length;
  let cur: unknown = value;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object" || typeof seg === "object") return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  if (cur === null || typeof cur === "number" || typeof cur === "string" || typeof cur === "boolean") return cur;
  // A collection's size is the one non-scalar read that is useful ("the list grew").
  if (Array.isArray(cur)) return cur.length;
  return undefined;
}

// === Patterns and globs ===

/** `"/re/flags"` → a RegExp; anything else → null (a literal). Throws on an invalid regex. */
export function patternRegex(src: string): RegExp | null {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(src);
  if (m === null) return null;
  return new RegExp(m[1] as string, m[2]);
}

/** Does `text` match a pattern: a `/regex/` searches, a literal must equal (`exact`) or be contained. */
export function matchesPattern(pattern: string, text: string, exact: boolean): boolean {
  const re = patternRegex(pattern);
  if (re !== null) {
    re.lastIndex = 0;
    return re.test(text);
  }
  return exact ? text.trim() === pattern.trim() : text.includes(pattern);
}

/** A URL/path glob → RegExp: `**` any run, `*` any run without `/`, everything else literal. */
export function globRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else out += "[^/]*";
    } else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// === Schema ===

const TextPatternSchema = z
  .string()
  .min(1)
  .superRefine((s, ctx) => {
    try {
      patternRegex(s);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: `invalid regex: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

const JsonPathStringSchema = z.string().superRefine((s, ctx) => {
  try {
    parseJsonPath(s);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : String(e) });
  }
});

const DomObservableSchema = z
  .object({
    selector: z.string().min(1).optional(),
    target: TargetDescriptorSchema.optional(),
    read: z
      .union([
        z.enum(["text", "value", "count", "inViewport"]),
        z
          .object({
            style: z.enum(STYLE_PROPERTIES),
            channel: z.enum(["alpha", "r", "g", "b", "px"]).optional(),
            reduce: z.enum(["first", "min", "max"]).optional(),
          })
          .strict()
          .refine((r) => (r.reduce ?? "first") === "first" || r.channel !== undefined, {
            message: "reduce min/max needs a numeric channel",
          }),
        z.object({ attr: z.string().regex(ATTR_NAME_RE) }).strict(),
      ])
      .optional(),
    number: z.union([z.boolean(), z.literal("all"), z.object({ index: z.number().int() }).strict()]).optional(),
    optional: z.boolean().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if ((d.selector === undefined) === (d.target === undefined)) {
      ctx.addIssue({ code: "custom", message: "exactly one of selector or target is required", path: ["selector"] });
    }
  });

const NetworkObservableSchema = z
  .object({
    url: z.string().min(1),
    method: z.string().regex(/^[A-Za-z]+$/).optional(),
    json: JsonPathStringSchema,
    optional: z.boolean().optional(),
  })
  .strict();

/** `authFrom.secret`'s only accepted shape (#135): the same `env:VAR` reference `--secret-field` uses. */
export const AUTH_SECRET_REF_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

const ProbeAuthFromSchema = z
  .object({
    localStorage: z.string().min(1).optional(),
    cookie: z.string().min(1).optional(),
    secret: z.string().regex(AUTH_SECRET_REF_RE, 'a secret ref must be "env:VAR"').optional(),
    scheme: z.string().max(40).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if ([a.localStorage, a.cookie, a.secret].filter((k) => k !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", message: "authFrom is exactly one of localStorage, cookie or secret" });
    }
  });

const ProbeObservableSchema = z
  .object({
    get: z.string().min(1).optional(),
    head: z.string().min(1).optional(),
    json: JsonPathStringSchema.optional(),
    optional: z.boolean().optional(),
    authFrom: ProbeAuthFromSchema.optional(),
    as: z.string().regex(ACTOR_NAME_RE, "invalid actor name").optional(),
  })
  // `.strict()` is the method guardrail: a `post`/`put`/`delete`/`method`/`headers`/`body` key is an
  // unknown key and the spec is refused — a probe can only ever be a GET or a HEAD, with no payload.
  .strict()
  .superRefine((p, ctx) => {
    if ((p.get === undefined) === (p.head === undefined)) {
      ctx.addIssue({ code: "custom", message: "a probe is exactly one of get or head (read-only)", path: ["get"] });
    }
    if (p.head !== undefined && p.json !== undefined) {
      ctx.addIssue({ code: "custom", message: "a head probe has no body to read", path: ["json"] });
    }
  });

// Keyed objects (not a zod union) so a refusal names the exact field: `observe.balance.dom.selector`.
const ObservableSchema = z
  .object({
    dom: DomObservableSchema.optional(),
    network: NetworkObservableSchema.optional(),
    probe: ProbeObservableSchema.optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if ([o.dom, o.network, o.probe].filter((k) => k !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", message: "an observable is exactly one of dom, network or probe" });
    }
  });

const BudgetGuardSchema = z
  .object({
    estimate: z.union([z.number(), z.string().min(1)]),
    factor: z.number().positive().optional(),
  })
  .strict();

const BudgetDeclarationSchema = z
  .object({
    observe: z.string().min(1),
    maxDelta: z.number().refine((n) => n !== 0, "maxDelta must not be 0 (nothing could ever cross it)"),
    guard: BudgetGuardSchema.optional(),
    settle: z
      .object({
        withinMs: z.number().int().positive().max(MAX_SETTLE_WITHIN_MS),
        pollMs: z.number().int().min(MIN_SETTLE_POLL_MS).optional(),
      })
      .strict()
      .optional(),
    onUnreadable: z.enum(["stop", "continue"]).optional(),
  })
  .strict();

const WhenSchema = z
  .object({
    after: z
      .string()
      .refine((a) => a === "action" || CAPTURE_GATE_RE.test(a), 'after is "action" or "capture.<name>"')
      .optional(),
    control: z.object({ name: TextPatternSchema }).strict().optional(),
    route: z.string().min(1).optional(),
    op: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const NeverSchema = z
  .object({ pageText: TextPatternSchema.optional(), assertion: AssertionSchema.optional() })
  .strict()
  .superRefine((n, ctx) => {
    if ((n.pageText === undefined) === (n.assertion === undefined)) {
      ctx.addIssue({ code: "custom", message: "a never is exactly one of pageText or assertion" });
    }
  });

const CaptureWhenSchema = z
  .object({
    control: z.object({ name: TextPatternSchema }).strict().optional(),
    route: z.string().min(1).optional(),
    op: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((w) => w.control !== undefined || w.route !== undefined || w.op !== undefined, "after names at least one of control, route or op");

const CaptureSchema = z
  .object({
    network: z
      .object({ url: z.string().min(1), method: z.string().regex(/^[A-Za-z]+$/).optional(), json: JsonPathStringSchema })
      .strict()
      .optional(),
    dom: z
      .object({
        selector: z.string().min(1),
        read: z
          .string()
          .regex(/^(text|value|attr:[A-Za-z_:][A-Za-z0-9_.:-]*)$/, 'read is "text", "value" or "attr:<name>"')
          .optional(),
        after: CaptureWhenSchema.optional(),
      })
      .strict()
      .optional(),
    url: z.object({ after: CaptureWhenSchema, route: z.string().min(1).optional() }).strict().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ([c.network, c.dom, c.url].filter((k) => k !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", message: "a capture is exactly one of network, dom or url" });
    }
  });

const StatusListSchema = z.array(z.number().int().min(100).max(599)).min(1).max(20);

const DeniedAsSchema = z
  .object({
    actor: z.string().regex(ACTOR_NAME_RE, "invalid actor name"),
    open: z.string().min(1).max(2_000),
    expect: z
      .object({
        documentStatus: StatusListSchema.optional(),
        appResponses: z
          .object({
            url: z.string().min(1),
            status: StatusListSchema.optional(),
            connectCode: z.array(z.string().regex(/^[a-z_]+$/, "a Connect code is snake_case (not_found)")).min(1).max(20).optional(),
          })
          .strict()
          .refine((a) => a.status !== undefined || a.connectCode !== undefined, "appResponses needs status or connectCode")
          .optional(),
        orVisible: TextPatternSchema.optional(),
      })
      .strict()
      .refine(
        (e) => e.documentStatus !== undefined || e.appResponses !== undefined || e.orVisible !== undefined,
        "expect names at least one of documentStatus, appResponses or orVisible",
      ),
  })
  .strict();

const InvariantSchema = z
  .object({
    id: z.string().regex(INVARIANT_ID_RE, "invalid id").max(80),
    description: z.string().max(500).optional(),
    when: WhenSchema.optional(),
    require: z.string().min(1).max(MAX_EXPRESSION_CHARS).optional(),
    never: NeverSchema.optional(),
    always: AssertionSchema.optional(),
    deniedAs: DeniedAsSchema.optional(),
    settle: z
      .object({
        withinMs: z.number().int().positive().max(MAX_SETTLE_WITHIN_MS),
        pollMs: z.number().int().min(MIN_SETTLE_POLL_MS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((inv, ctx) => {
    const kinds = [inv.require, inv.never, inv.always, inv.deniedAs].filter((k) => k !== undefined).length;
    if (kinds !== 1) ctx.addIssue({ code: "custom", message: "exactly one of require, never, always or deniedAs is required", path: ["require"] });
    const gated = inv.when?.after !== undefined && inv.when.after !== "action";
    if (gated) {
      const w = inv.when ?? {};
      if (w.control !== undefined || w.route !== undefined || w.op !== undefined) {
        ctx.addIssue({ code: "custom", message: "a capture-gated invariant runs once, after its capture: when takes no other key", path: ["when"] });
      }
      if (inv.require === undefined && inv.deniedAs === undefined) {
        ctx.addIssue({ code: "custom", message: "a capture-gated invariant is a require or a deniedAs", path: ["when", "after"] });
      }
    }
    if (inv.deniedAs !== undefined && !gated) {
      ctx.addIssue({ code: "custom", message: 'deniedAs needs when.after: "capture.<name>" (it asks about a captured resource)', path: ["when"] });
    }
    if (inv.never !== undefined && inv.when !== undefined) {
      ctx.addIssue({ code: "custom", message: "a never invariant is global: it takes no when", path: ["when"] });
    }
    if (inv.settle !== undefined && inv.require === undefined) {
      ctx.addIssue({ code: "custom", message: "settle applies to a require invariant only", path: ["settle"] });
    }
    if (inv.require !== undefined) {
      try {
        parseInvariantExpression(inv.require);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : String(e), path: ["require"] });
      }
    }
  });

/**
 * The closed invariant-spec schema: every object is `.strict()` (an unknown key is refused), and
 * cross-references (an expression's observables) are checked. Origin authorization of probes needs
 * the mission's allowlist — see `validateInvariantSpec`.
 */
const InvariantSpecObjectSchema = z
  .object({
    version: z.literal(1).optional(),
    capture: z
      .record(z.string(), CaptureSchema)
      .optional()
      .superRefine((cap, ctx) => {
        if (cap === undefined) return;
        const names = Object.keys(cap);
        if (names.length > MAX_OBSERVABLES) ctx.addIssue({ code: "custom", message: `at most ${MAX_OBSERVABLES} captures` });
        for (const n of names) {
          if (!OBSERVABLE_NAME_RE.test(n) || RESERVED.has(n)) {
            ctx.addIssue({ code: "custom", message: `invalid capture name ${JSON.stringify(n)}`, path: [n] });
          }
        }
      }),
    observe: z
      .record(z.string(), ObservableSchema)
      .optional()
      .superRefine((obs, ctx) => {
        if (obs === undefined) return;
        const names = Object.keys(obs);
        if (names.length > MAX_OBSERVABLES) ctx.addIssue({ code: "custom", message: `at most ${MAX_OBSERVABLES} observables` });
        for (const n of names) {
          if (!OBSERVABLE_NAME_RE.test(n) || RESERVED.has(n)) {
            ctx.addIssue({ code: "custom", message: `invalid observable name ${JSON.stringify(n)}`, path: [n] });
          }
        }
      }),
    invariants: z.array(InvariantSchema).max(MAX_INVARIANTS),
    budget: z.array(BudgetDeclarationSchema).max(MAX_BUDGETS).optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const declared = new Set(Object.keys(spec.observe ?? {}));
    const captures = new Set(Object.keys(spec.capture ?? {}));
    for (const n of captures) {
      if (declared.has(n)) ctx.addIssue({ code: "custom", message: `${JSON.stringify(n)} is both a capture and an observable`, path: ["capture", n] });
    }
    // Captures are only ever read from the primary's run; `${capture.x}` must name one.
    for (const [name, o] of Object.entries(spec.observe ?? {})) {
      if (!("probe" in o) || o.probe === undefined) continue;
      const tpl = o.probe.get ?? o.probe.head ?? "";
      for (const ref of captureRefs(tpl)) {
        if (!captures.has(ref)) ctx.addIssue({ code: "custom", message: `unknown capture ${JSON.stringify(ref)}`, path: ["observe", name, "probe"] });
      }
    }
    const observerObservables = new Set(
      Object.entries(spec.observe ?? {})
        .filter(([, o]) => "probe" in o && o.probe?.as !== undefined)
        .map(([n]) => n),
    );
    const ids = new Set<string>();
    if (spec.invariants.length === 0 && (spec.budget ?? []).length === 0) {
      ctx.addIssue({ code: "custom", message: "at least one of invariants or budget is required", path: ["invariants"] });
    }
    spec.invariants.forEach((inv, i) => {
      if (ids.has(inv.id)) ctx.addIssue({ code: "custom", message: `duplicate invariant id ${JSON.stringify(inv.id)}`, path: ["invariants", i, "id"] });
      ids.add(inv.id);
      const gate = invariantGate(inv);
      if (gate !== null && !captures.has(gate)) {
        ctx.addIssue({ code: "custom", message: `unknown capture ${JSON.stringify(gate)}`, path: ["invariants", i, "when", "after"] });
      }
      if (inv.deniedAs !== undefined) {
        for (const ref of captureRefs(inv.deniedAs.open)) {
          if (!captures.has(ref)) ctx.addIssue({ code: "custom", message: `unknown capture ${JSON.stringify(ref)}`, path: ["invariants", i, "deniedAs", "open"] });
        }
      }
      if (inv.require === undefined) return;
      let ast: ExprNode;
      try {
        ast = parseInvariantExpression(inv.require);
      } catch {
        return; // reported by the invariant's own refinement
      }
      for (const name of expressionObservables(ast)) {
        if (!declared.has(name) && !captures.has(name)) {
          ctx.addIssue({ code: "custom", message: `unknown observable ${JSON.stringify(name)}`, path: ["invariants", i, "require"] });
        }
        // An observer's read happens once per capture, never around every primary action.
        if (observerObservables.has(name) && gate === null) {
          ctx.addIssue({
            code: "custom",
            message: `${JSON.stringify(name)} is read as another actor: the invariant needs when.after: "capture.<name>"`,
            path: ["invariants", i, "when"],
          });
        }
      }
    });
    (spec.budget ?? []).forEach((b, i) => {
      if (!declared.has(b.observe)) {
        ctx.addIssue({ code: "custom", message: `unknown observable ${JSON.stringify(b.observe)}`, path: ["budget", i, "observe"] });
      }
      if (typeof b.guard?.estimate === "string" && !declared.has(b.guard.estimate)) {
        ctx.addIssue({ code: "custom", message: `unknown observable ${JSON.stringify(b.guard.estimate)}`, path: ["budget", i, "guard", "estimate"] });
      }
    });
  });

// The refinements above guarantee the exactly-one-of shapes the `InvariantSpec` type encodes.
export const InvariantSpecSchema: z.ZodType<InvariantSpec> = InvariantSpecObjectSchema as unknown as z.ZodType<InvariantSpec>;

/** A refused spec: every problem, each prefixed with its path (`invariants[2].require: …`). */
export class InvariantSpecError extends Error {
  readonly code = "E_INVARIANTS" as const;
  constructor(readonly problems: readonly string[]) {
    super(`invalid invariants: ${problems.join("; ")}`);
    this.name = "InvariantSpecError";
  }
}

/** `["invariants", 2, "observe"]` → `invariants[2].observe`. */
export function formatSpecPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out === "" ? "(root)" : out;
}

/** The origin a probe's URL resolves to (relative paths against `baseUrl`), or null when unparseable. */
export function probeUrl(probe: ProbeObservable, baseUrl: string): URL | null {
  const raw = probe.get ?? probe.head;
  if (raw === undefined) return null;
  return resolveHttpUrl(raw, baseUrl);
}

/** An http(s) URL (relative paths against `baseUrl`), or null. */
export function resolveHttpUrl(raw: string, baseUrl: string): URL | null {
  try {
    const u = new URL(raw, baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Every `${capture.<name>}` a template references (#147), deduped. */
export function captureRefs(template: string): string[] {
  return [...new Set([...template.matchAll(CAPTURE_REF_RE)].map((m) => m[1] as string))];
}

/**
 * Substitutes `${capture.<name>}` refs (#147). A ref that IS the whole template is replaced by the
 * raw value (a captured URL); inside a path/query it is URL-encoded, so a captured id can never
 * add a path segment, a query or an origin. Null when any ref is unbound.
 */
export function substituteCaptureRefs(template: string, lookup: (name: string) => string | undefined): string | null {
  const whole = /^\$\{capture\.([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(template);
  if (whole !== null) return lookup(whole[1] as string) ?? null;
  let missing = false;
  const out = template.replace(CAPTURE_REF_RE, (_m, name: string) => {
    const v = lookup(name);
    if (v === undefined) {
      missing = true;
      return "";
    }
    return encodeURIComponent(v);
  });
  return missing ? null : out;
}

/** The capture a cross-actor invariant is gated on (`when.after: "capture.x"` → `x`), or null. */
export function invariantGate(inv: { readonly when?: { readonly after?: string } }): string | null {
  const after = inv.when?.after;
  if (after === undefined || after === "action") return null;
  return CAPTURE_GATE_RE.exec(after)?.[1] ?? null;
}

/**
 * The observer actor a cross-actor invariant checks from (#147): its `deniedAs.actor`, or the
 * `as:` of the first observable its expression reads. Null for a primary-only invariant.
 */
export function invariantObserver(spec: InvariantSpec, inv: DeclaredInvariant): string | null {
  if (inv.deniedAs !== undefined) return inv.deniedAs.actor;
  if (inv.require === undefined) return null;
  let ast: ExprNode;
  try {
    ast = parseInvariantExpression(inv.require);
  } catch {
    return null;
  }
  for (const name of expressionObservables(ast)) {
    const o = spec.observe?.[name];
    if (o !== undefined && "probe" in o && o.probe.as !== undefined) return o.probe.as;
  }
  return null;
}

/** Every actor a spec names (probe `as:`, `deniedAs.actor`), deduped (#147). */
export function invariantActors(spec: InvariantSpec): string[] {
  const out = new Set<string>();
  for (const o of Object.values(spec.observe ?? {})) if ("probe" in o && o.probe.as !== undefined) out.add(o.probe.as);
  for (const inv of spec.invariants) if (inv.deniedAs !== undefined) out.add(inv.deniedAs.actor);
  return [...out];
}

/** A capture template with every ref replaced by a harmless placeholder: its ORIGIN is checkable. */
function placeholderUrl(template: string): string {
  return template.replace(CAPTURE_REF_RE, "x");
}

function originOf(s: string): string | null {
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

export interface ValidateInvariantOptions {
  /** Authorized origins: every probe must resolve onto one. Required when the spec has probes. */
  readonly allowlist?: readonly string[];
  /** What relative probe paths resolve against (the mission's start URL / target base URL). */
  readonly baseUrl?: string;
  /**
   * The registered OBSERVER actors (#147: every `--actor` but the primary). Every probe `as:` and
   * `deniedAs.actor` must name one; with none registered, a spec naming an actor is refused.
   */
  readonly observers?: readonly string[];
}

/**
 * Validates a raw spec and authorizes its probes — the dispatch-time gate. Throws
 * `InvariantSpecError` listing every problem with its path; returns the typed spec otherwise.
 * A probe whose origin is not on `allowlist` (or that cannot be resolved) is refused here, so a
 * bad spec never reaches a browser.
 */
export function validateInvariantSpec(raw: unknown, opts: ValidateInvariantOptions = {}): InvariantSpec {
  const parsed = InvariantSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvariantSpecError(parsed.error.issues.map((i) => `${formatSpecPath(i.path)}: ${i.message}`));
  }
  const spec = parsed.data;
  const problems: string[] = [];
  const allowed = new Set((opts.allowlist ?? []).map(originOf).filter((o): o is string => o !== null));
  const observers = new Set(opts.observers ?? []);
  const urlCaptures = new Set(Object.entries(spec.capture ?? {}).filter(([, c]) => "url" in c).map(([n]) => n));
  const checkActor = (actor: string, at: string): void => {
    if (observers.has(actor)) return;
    problems.push(
      observers.size === 0
        ? `${at}: actor ${JSON.stringify(actor)} is not registered (pass --actor <primary>=<state> --actor ${actor}=<state>)`
        : `${at}: actor ${JSON.stringify(actor)} is not a registered observer (have: ${[...observers].join(", ")})`,
    );
  };
  // A template that STARTS with a capture takes its origin from the captured value: only a `url`
  // capture (the primary's own, already-authorized page URL) may do that. Re-checked at request time.
  const leadingCapture = (template: string, at: string): boolean => {
    const lead = /^\$\{capture\.([A-Za-z_][A-Za-z0-9_]*)\}/.exec(template);
    if (lead === null) return false;
    if (!urlCaptures.has(lead[1] as string)) problems.push(`${at}: only a url capture may start a URL (it would set the origin)`);
    return true;
  };
  spec.invariants.forEach((inv, i) => {
    if (inv.deniedAs === undefined) return;
    const at = `invariants[${i}].deniedAs`;
    checkActor(inv.deniedAs.actor, `${at}.actor`);
    if (leadingCapture(inv.deniedAs.open, `${at}.open`)) return;
    if (opts.baseUrl === undefined || opts.allowlist === undefined) {
      problems.push(`${at}.open: needs the mission's authorized origins to be checked against`);
      return;
    }
    const u = resolveHttpUrl(placeholderUrl(inv.deniedAs.open), opts.baseUrl);
    if (u === null) problems.push(`${at}.open: not an http(s) URL or path`);
    else if (u.username !== "" || u.password !== "") problems.push(`${at}.open: a URL may not carry credentials`);
    else if (!allowed.has(u.origin)) problems.push(`${at}.open: origin ${u.origin} is not an authorized origin`);
  });
  for (const [name, o] of Object.entries(spec.observe ?? {})) {
    if (!("probe" in o)) continue;
    const at = `observe.${name}.probe`;
    if (o.probe.as !== undefined) checkActor(o.probe.as, `${at}.as`);
    if (leadingCapture(o.probe.get ?? o.probe.head ?? "", at)) continue;
    if (opts.baseUrl === undefined || opts.allowlist === undefined) {
      problems.push(`${at}: a probe needs the mission's authorized origins to be checked against`);
      continue;
    }
    const tpl = o.probe.get ?? o.probe.head ?? "";
    const u = probeUrl(o.probe.get !== undefined ? { get: placeholderUrl(tpl) } : { head: placeholderUrl(tpl) }, opts.baseUrl);
    if (u === null) {
      problems.push(`${at}: not an http(s) URL or path`);
      continue;
    }
    if (u.username !== "" || u.password !== "") {
      problems.push(`${at}: a probe URL may not carry credentials`);
      continue;
    }
    if (!allowed.has(u.origin)) problems.push(`${at}: origin ${u.origin} is not an authorized origin`);
  }
  if (problems.length > 0) throw new InvariantSpecError(problems);
  return spec;
}

/**
 * Merges several specs (repeatable `--invariants`) into one. An observable declared twice with a
 * different definition, or a repeated invariant id, is refused rather than silently shadowed.
 */
export function mergeInvariantSpecs(specs: readonly InvariantSpec[]): InvariantSpec {
  const observe: Record<string, ObservableSpec> = {};
  const capture: Record<string, CaptureSpec> = {};
  const invariants: DeclaredInvariant[] = [];
  const budget: BudgetDeclaration[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  specs.forEach((s, f) => {
    for (const [name, c] of Object.entries(s.capture ?? {})) {
      const known = capture[name];
      if (known !== undefined && JSON.stringify(known) !== JSON.stringify(c)) {
        problems.push(`file ${f + 1}: capture.${name}: declared differently in an earlier file`);
      }
      capture[name] = c;
    }
    for (const [name, o] of Object.entries(s.observe ?? {})) {
      const known = observe[name];
      if (known !== undefined && JSON.stringify(known) !== JSON.stringify(o)) {
        problems.push(`file ${f + 1}: observe.${name}: declared differently in an earlier file`);
      }
      observe[name] = o;
    }
    for (const inv of s.invariants) {
      if (ids.has(inv.id)) problems.push(`file ${f + 1}: invariant id ${JSON.stringify(inv.id)} repeats an earlier file's`);
      ids.add(inv.id);
      invariants.push(inv);
    }
    budget.push(...(s.budget ?? []));
  });
  if (problems.length > 0) throw new InvariantSpecError(problems);
  return {
    ...(Object.keys(capture).length > 0 ? { capture } : {}),
    ...(Object.keys(observe).length > 0 ? { observe } : {}),
    invariants,
    ...(budget.length > 0 ? { budget } : {}),
  };
}

/**
 * Every `authFrom.secret` ref (`env:VAR`) a spec's probes use (#135), deduped — what the dispatch
 * resolves from the environment before any browser opens (never read here: this module is pure).
 */
export function invariantAuthSecretRefs(spec: InvariantSpec): string[] {
  const refs = new Set<string>();
  for (const o of Object.values(spec.observe ?? {})) {
    if ("probe" in o && o.probe.authFrom?.secret !== undefined) refs.add(o.probe.authFrom.secret);
  }
  return [...refs];
}
