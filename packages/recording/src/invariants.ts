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
 *
 * This module is pure (schema + parser + evaluator) so the dispatch surfaces can reject a bad spec
 * — with a precise path like `invariants[2].require: unknown observable "balanse"` — before any
 * browser work. The browser-side evaluation lives in `@jevitate/explore`.
 */

/** A declared observable name: an identifier that is not one of the expression's keywords. */
export const OBSERVABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["before", "after", "delta", "null", "true", "false"]);
/** An invariant id: same path-safe format as mission/journey ids (it keys a fingerprint). */
export const INVARIANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Bounds on the eventual-consistency window (`settle`). */
export const MAX_SETTLE_WITHIN_MS = 10 * 60_000;
export const MIN_SETTLE_POLL_MS = 250;
/** Hard caps on a spec's size (it is caller input on the MCP path). */
export const MAX_OBSERVABLES = 64;
export const MAX_INVARIANTS = 64;
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
  /** Parse the first number out of what was read (`"≈ 1,240 credits"` → 1240). */
  number?: boolean;
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
}

export type ObservableSpec = { dom: DomObservable } | { network: NetworkObservable } | { probe: ProbeObservable };

/** When a `require`/`always` invariant is checked. Every given field must match. Absent ⇒ after every action. */
export interface InvariantWhen {
  after?: "action";
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

export interface DeclaredInvariant {
  id: string;
  description?: string;
  when?: InvariantWhen;
  require?: string;
  never?: InvariantNever;
  always?: Assertion;
  settle?: InvariantSettle;
}

export interface InvariantSpec {
  version?: 1;
  observe?: Record<string, ObservableSpec>;
  invariants: DeclaredInvariant[];
}

// === Expression language ===

export type ExprNode =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "lit"; readonly v: null | boolean }
  | { readonly t: "obs"; readonly fn: "before" | "after" | "delta"; readonly name: string }
  | { readonly t: "neg"; readonly e: ExprNode }
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

const OPS = ["->", "&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "(", ")"];

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
    if (t.k === "id") {
      p += 1;
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

/** Every observable name an expression reads. */
export function expressionObservables(ast: ExprNode): string[] {
  const out = new Set<string>();
  const walk = (n: ExprNode): void => {
    if (n.t === "obs") out.add(n.name);
    else if (n.t === "neg") walk(n.e);
    else if (n.t === "bin") {
      walk(n.l);
      walk(n.r);
    }
  };
  walk(ast);
  return [...out];
}

/** A snapshotted observable value. `UNKNOWN` = it could not be read (never a violation, never a pass). */
export const UNKNOWN: unique symbol = Symbol("unknown");
export type ObservedValue = number | string | boolean | null;
export type EvalValue = ObservedValue | typeof UNKNOWN;

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
    case "bin":
      return evalBin(n.op, n.l, n.r, env);
  }
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

export type JsonPathSegment = string | number;

/** `$`, `.key`, `[n]`, `["key"]` — nothing else (no filters, no wildcards, no script). */
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

/** Reads a JSON path; `undefined` when a segment is missing. Only scalars come back (objects → undefined). */
export function readJsonPath(value: unknown, path: readonly JsonPathSegment[]): ObservedValue | undefined {
  let cur: unknown = value;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
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
    number: z.boolean().optional(),
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

const WhenSchema = z
  .object({
    after: z.literal("action").optional(),
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

const InvariantSchema = z
  .object({
    id: z.string().regex(INVARIANT_ID_RE, "invalid id").max(80),
    description: z.string().max(500).optional(),
    when: WhenSchema.optional(),
    require: z.string().min(1).max(MAX_EXPRESSION_CHARS).optional(),
    never: NeverSchema.optional(),
    always: AssertionSchema.optional(),
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
    const kinds = [inv.require, inv.never, inv.always].filter((k) => k !== undefined).length;
    if (kinds !== 1) ctx.addIssue({ code: "custom", message: "exactly one of require, never or always is required", path: ["require"] });
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
    invariants: z.array(InvariantSchema).min(1).max(MAX_INVARIANTS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const declared = new Set(Object.keys(spec.observe ?? {}));
    const ids = new Set<string>();
    spec.invariants.forEach((inv, i) => {
      if (ids.has(inv.id)) ctx.addIssue({ code: "custom", message: `duplicate invariant id ${JSON.stringify(inv.id)}`, path: ["invariants", i, "id"] });
      ids.add(inv.id);
      if (inv.require === undefined) return;
      let ast: ExprNode;
      try {
        ast = parseInvariantExpression(inv.require);
      } catch {
        return; // reported by the invariant's own refinement
      }
      for (const name of expressionObservables(ast)) {
        if (!declared.has(name)) {
          ctx.addIssue({ code: "custom", message: `unknown observable ${JSON.stringify(name)}`, path: ["invariants", i, "require"] });
        }
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
  try {
    const u = new URL(raw, baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
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
  for (const [name, o] of Object.entries(spec.observe ?? {})) {
    if (!("probe" in o)) continue;
    const at = `observe.${name}.probe`;
    if (opts.baseUrl === undefined || opts.allowlist === undefined) {
      problems.push(`${at}: a probe needs the mission's authorized origins to be checked against`);
      continue;
    }
    const u = probeUrl(o.probe, opts.baseUrl);
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
  const invariants: DeclaredInvariant[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  specs.forEach((s, f) => {
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
  });
  if (problems.length > 0) throw new InvariantSpecError(problems);
  return { ...(Object.keys(observe).length > 0 ? { observe } : {}), invariants };
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
