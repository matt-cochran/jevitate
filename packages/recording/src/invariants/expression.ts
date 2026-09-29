import { MAX_EXPRESSION_CHARS, RESERVED } from "./internal.js";

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
