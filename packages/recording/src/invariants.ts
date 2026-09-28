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
import {
  expressionObservables,
  parseInvariantExpression,
  type ExprNode,
} from "./invariants/expression.js";
import { parseJsonPath } from "./invariants/json-path.js";
import { globRegex, matchesPattern, patternRegex } from "./invariants/patterns.js";
import {
  ACTION_OPS,
  ACTOR_NAME_RE,
  INVARIANT_HTTP_METHODS,
  INVARIANT_ID_RE,
  MAX_BUDGETS,
  MAX_INVARIANTS,
  MAX_OBSERVABLES,
  MAX_SETTLE_WITHIN_MS,
  MIN_SETTLE_POLL_MS,
  OBSERVABLE_NAME_RE,
  type ActionOp,
  type InvariantSettle,
  type InvariantWhen,
} from "./invariants/shared.js";
import {
  CAPTURE_GATE_RE,
  CAPTURE_REF_RE,
  httpMethodField,
  JsonPathStringSchema,
  MAX_EXPRESSION_CHARS,
  OpSchema,
  RESERVED,
  TextPatternSchema,
} from "./invariants/internal.js";

export * from "./invariants/expression.js";
export * from "./invariants/json-path.js";
export * from "./invariants/patterns.js";
export * from "./invariants/shared.js";

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

/**
 * #195 — `never.response`: an app response on the mission's OWN traffic (the primary's page) that
 * must never be seen, e.g. the guaranteed billing 403 of a role (`{ url: "/api/v1/tool/billing/**",
 * status: "403" }`). `url` is a glob: starting with `/` it matches the response URL's PATH (with or
 * without its query); otherwise the whole URL. Only responses from the mission's authorized origins
 * (the start URL's origin unless `--allow` widens it) are ever matched. `status` is an exact code
 * (`"403"` or `403`) or a class (`"4xx"`); `method` optionally narrows it (`GET`, `POST`, …).
 */
export interface NeverResponse {
  url: string;
  status: string | number;
  method?: string;
}

export type InvariantNever = { pageText: string } | { assertion: Assertion } | { response: NeverResponse };

/** Does an HTTP status match a `never.response.status` (#195): an exact code, or a class like `"4xx"`. */
export function matchesResponseStatus(want: string | number, status: number): boolean {
  const s = String(want).toLowerCase();
  const cls = /^([1-5])xx$/.exec(s);
  if (cls !== null) return Math.floor(status / 100) === Number(cls[1]);
  return Number(s) === status;
}

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

// === Schema ===

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
    method: httpMethodField(),
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
    op: z.array(OpSchema).min(1).optional(),
  })
  .strict();

const NeverResponseSchema = z
  .object({
    url: z.string().min(1).max(2_000),
    status: z.union([
      z.number().int().min(100).max(599),
      z.string().regex(/^([1-5][0-9]{2}|[1-5][xX]{2})$/, 'status is a code ("403") or a class ("4xx")'),
    ]),
    method: httpMethodField(),
  })
  .strict();

const NeverSchema = z
  .object({ pageText: TextPatternSchema.optional(), assertion: AssertionSchema.optional(), response: NeverResponseSchema.optional() })
  .strict()
  .superRefine((n, ctx) => {
    if ([n.pageText, n.assertion, n.response].filter((k) => k !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", message: "a never is exactly one of pageText, assertion or response" });
    }
  });

const CaptureWhenSchema = z
  .object({
    control: z.object({ name: TextPatternSchema }).strict().optional(),
    route: z.string().min(1).optional(),
    op: z.array(OpSchema).min(1).optional(),
  })
  .strict()
  .refine((w) => w.control !== undefined || w.route !== undefined || w.op !== undefined, "after names at least one of control, route or op");

const CaptureSchema = z
  .object({
    network: z
      .object({ url: z.string().min(1), method: httpMethodField(), json: JsonPathStringSchema })
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

interface SpecIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * The spec's cross-reference problems (#213: a duplicate invariant id, an unknown observable or
 * capture, a cross-actor read with no gate, "at least one of invariants or budget") — recomputed
 * from the RAW input, defensively (every field is duck-typed, never assumed to be the right shape).
 *
 * Why this duplicates `InvariantSpecObjectSchema`'s own `superRefine` logic: zod does not run a
 * `superRefine` once ANY nested field's parse aborts (a wrong type, an unrecognized `.strict()` key,
 * …) — so a spec with an unrelated type error used to lose every one of these checks along with it,
 * reporting only the type error and hiding real problems elsewhere in the same file. `raw` has no
 * such failure mode: it is read defensively here regardless of what else is wrong with the spec, and
 * `validateInvariantSpec` merges its findings with the schema's own. The schema's `superRefine` is
 * left as-is for its other direct callers (`parsePersistedMission`, `MissionRequestSchema`).
 */
function crossReferenceProblems(raw: unknown): SpecIssue[] {
  const spec = asRecord(raw);
  if (spec === undefined) return [];
  const issues: SpecIssue[] = [];
  const captureObj = asRecord(spec.capture) ?? {};
  const observeObj = asRecord(spec.observe) ?? {};
  const declared = new Set(Object.keys(observeObj));
  const captures = new Set(Object.keys(captureObj));
  for (const n of captures) {
    if (declared.has(n)) issues.push({ path: ["capture", n], message: `${JSON.stringify(n)} is both a capture and an observable` });
  }
  const probeOf = (o: unknown): Record<string, unknown> | undefined => {
    const rec = asRecord(o);
    return rec === undefined ? undefined : asRecord(rec.probe);
  };
  for (const [name, o] of Object.entries(observeObj)) {
    const probe = probeOf(o);
    if (probe === undefined) continue;
    const tpl = typeof probe.get === "string" ? probe.get : typeof probe.head === "string" ? probe.head : "";
    for (const ref of captureRefs(tpl)) {
      if (!captures.has(ref)) issues.push({ path: ["observe", name, "probe"], message: `unknown capture ${JSON.stringify(ref)}` });
    }
  }
  const observerObservables = new Set(
    Object.entries(observeObj)
      .filter(([, o]) => probeOf(o)?.as !== undefined)
      .map(([n]) => n),
  );
  const invariantsRaw = Array.isArray(spec.invariants) ? spec.invariants : [];
  const budgetRaw = Array.isArray(spec.budget) ? spec.budget : [];
  if (invariantsRaw.length === 0 && budgetRaw.length === 0) {
    issues.push({ path: ["invariants"], message: "at least one of invariants or budget is required" });
  }
  const ids = new Set<string>();
  invariantsRaw.forEach((invRaw, i) => {
    const inv = asRecord(invRaw);
    if (inv === undefined) return; // reported by the schema's own type check
    if (typeof inv.id === "string") {
      if (ids.has(inv.id)) issues.push({ path: ["invariants", i, "id"], message: `duplicate invariant id ${JSON.stringify(inv.id)}` });
      ids.add(inv.id);
    }
    const gate = invariantGate(inv as { when?: { after?: string } });
    if (gate !== null && !captures.has(gate)) {
      issues.push({ path: ["invariants", i, "when", "after"], message: `unknown capture ${JSON.stringify(gate)}` });
    }
    const deniedAs = asRecord(inv.deniedAs);
    if (deniedAs !== undefined && typeof deniedAs.open === "string") {
      for (const ref of captureRefs(deniedAs.open)) {
        if (!captures.has(ref)) issues.push({ path: ["invariants", i, "deniedAs", "open"], message: `unknown capture ${JSON.stringify(ref)}` });
      }
    }
    if (typeof inv.require !== "string") return;
    let ast: ExprNode;
    try {
      ast = parseInvariantExpression(inv.require);
    } catch {
      return; // reported by the expression's own refinement
    }
    for (const name of expressionObservables(ast)) {
      if (!declared.has(name) && !captures.has(name)) {
        issues.push({ path: ["invariants", i, "require"], message: `unknown observable ${JSON.stringify(name)}` });
      }
      if (observerObservables.has(name) && gate === null) {
        issues.push({
          path: ["invariants", i, "when"],
          message: `${JSON.stringify(name)} is read as another actor: the invariant needs when.after: "capture.<name>"`,
        });
      }
    }
  });
  budgetRaw.forEach((bRaw, i) => {
    const b = asRecord(bRaw);
    if (b === undefined) return;
    if (typeof b.observe === "string" && !declared.has(b.observe)) {
      issues.push({ path: ["budget", i, "observe"], message: `unknown observable ${JSON.stringify(b.observe)}` });
    }
    const guard = asRecord(b.guard);
    if (guard !== undefined && typeof guard.estimate === "string" && !declared.has(guard.estimate)) {
      issues.push({ path: ["budget", i, "guard", "estimate"], message: `unknown observable ${JSON.stringify(guard.estimate)}` });
    }
  });
  return issues;
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

/**
 * The concrete (wildcard-free) origin a `never.response.url` glob begins with, or null when the
 * glob has no such literal prefix (a bare path, or a wildcarded scheme/host `https://*.x.test/…`
 * that may still resolve onto an authorized origin at request time — left unchecked here).
 */
function literalGlobOrigin(urlGlob: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/*?]+/i.exec(urlGlob);
  if (m === null) return null;
  return originOf(m[0]);
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
  // #213: computed independently of whether the schema parse succeeded — see `crossReferenceProblems`.
  const crossRef = crossReferenceProblems(raw).map((i) => `${formatSpecPath(i.path)}: ${i.message}`);
  if (!parsed.success) {
    const shapeProblems = parsed.error.issues.map((i) => `${formatSpecPath(i.path)}: ${i.message}`);
    const extra = crossRef.filter((p) => !shapeProblems.includes(p));
    throw new InvariantSpecError([...shapeProblems, ...extra]);
  }
  const spec = parsed.data;
  const problems: string[] = [...crossRef];
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
    if (inv.never !== undefined && "response" in inv.never) {
      const at = `invariants[${i}].never.response.url`;
      const url = inv.never.response.url;
      // A glob starting with "/" is matched path-only against ANY authorized origin's response
      // (`matchesUrlGlob` in declared-invariants.ts) — always reachable. An absolute glob whose HOST
      // is a concrete, wildcard-free origin is matched against the full URL, but the listener only
      // ever tests responses `isAuthorizedExploreTarget` already let through — an unauthorized
      // literal origin can therefore never fire. A wildcarded origin (`https://*.x.test/...`) is left
      // alone: it may still resolve onto an authorized origin at request time.
      if (!url.startsWith("/") && (opts.baseUrl !== undefined || opts.allowlist !== undefined)) {
        const origin = literalGlobOrigin(url);
        if (origin !== null && (opts.allowlist === undefined || !allowed.has(origin))) {
          problems.push(
            `${at}: origin ${origin} is not an authorized origin — never.response only watches the mission's own ` +
              `authorized traffic and this rule can never fire (use a leading "/" path glob to match any authorized origin, or add --allow ${origin})`,
          );
        }
      }
    }
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