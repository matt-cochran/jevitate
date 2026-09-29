import { CAPTURE_GATE_RE, CAPTURE_REF_RE } from "./internal.js";

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
