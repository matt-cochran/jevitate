import { z } from "zod";
import { AssertionSchema, type Assertion } from "./schema.js";
import {
  expressionObservables,
  parseInvariantExpression,
  type ExprNode,
} from "./invariants/expression.js";
import {
  INVARIANT_ID_RE,
  MAX_BUDGETS,
  MAX_INVARIANTS,
  MAX_OBSERVABLES,
  MAX_SETTLE_WITHIN_MS,
  MIN_SETTLE_POLL_MS,
  OBSERVABLE_NAME_RE,
  type InvariantSettle,
  type InvariantWhen,
} from "./invariants/shared.js";
import {
  CAPTURE_GATE_RE,
  CAPTURE_REF_RE,
  CaptureSchema,
  DeniedAsSchema,
  MAX_EXPRESSION_CHARS,
  NeverSchema,
  ObservableSchema,
  OpSchema,
  RESERVED,
  TextPatternSchema,
} from "./invariants/internal.js";
import { probeUrl, resolveHttpUrl } from "./invariants/probe.js";
import { type ObservableSpec } from "./invariants/observable.js";
import { type InvariantNever } from "./invariants/never-response.js";
import {
  captureRefs,
  invariantGate,
  type CaptureSpec,
  type DeniedAsSpec,
} from "./invariants/capture.js";

export * from "./invariants/expression.js";
export * from "./invariants/json-path.js";
export * from "./invariants/patterns.js";
export * from "./invariants/shared.js";
export * from "./invariants/dom.js";
export * from "./invariants/network.js";
export * from "./invariants/probe.js";
export * from "./invariants/observable.js";
export * from "./invariants/never-response.js";
export * from "./invariants/capture.js";
export * from "./invariants/validate.js";

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
