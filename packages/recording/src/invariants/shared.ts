/**
 * Constants and small shared types that are part of `@jevitate/recording`'s PUBLIC surface (this
 * module is re-exported wholesale by the `invariants.ts` barrel — keep it to symbols that were
 * already exported from the pre-split file; anything package-internal belongs in `internal.ts`).
 */

/** A declared observable name: an identifier that is not one of the expression's keywords. */
export const OBSERVABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An invariant id: same path-safe format as mission/journey ids (it keys a fingerprint). */
export const INVARIANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Bounds on the eventual-consistency window (`settle`). */
export const MAX_SETTLE_WITHIN_MS = 10 * 60_000;
export const MIN_SETTLE_POLL_MS = 250;
/** An actor name (#147): the same format as a `--persona` name. */
export const ACTOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Hard caps on a spec's size (it is caller input on the MCP path). */
export const MAX_OBSERVABLES = 64;
export const MAX_INVARIANTS = 64;
/** A budget-declaration cap (#150): a run's spend axes are few by design, not a general-purpose list. */
export const MAX_BUDGETS = 8;

/**
 * The HTTP methods a `network`/`never.response`/`capture.network` `method` may name (#213: a spec
 * used to accept anything alphabetic — `"FETCH"` parsed fine and then just never matched a real
 * request). Case-insensitive; the declared-invariants monitor already `.toUpperCase()`s both sides.
 */
export const INVARIANT_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

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

/**
 * The action-op vocabulary `when.op` / `capture.*.after.op` may name (#124, #176): every op the
 * explore engine can gate an invariant around (`packages/explore/src/actions.ts` `OPS`), minus the
 * loop-control pseudo-ops (`done`, `report`, `blocked`, `edit_text` — never the op an app-declared
 * invariant is written against). An unknown name (a natural but unsupported guess like `"navigate"`
 * or `"scroll"`) used to validate fine and then never fire (#176) — now it is refused up front.
 */
export const ACTION_OPS = ["click", "type", "send", "select", "upload", "scroll_up", "scroll_down", "wait", "reload"] as const;
export type ActionOp = (typeof ACTION_OPS)[number];
