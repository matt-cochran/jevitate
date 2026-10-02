import { z } from "zod";
import { ATTR_NAME_RE, AssertionSchema, STYLE_PROPERTIES, TargetDescriptorSchema } from "../schema.js";
import { parseJsonPath } from "./json-path.js";
import { patternRegex } from "./patterns.js";
import { AUTH_SECRET_REF_RE } from "./probe.js";
import { ACTION_OPS, ACTOR_NAME_RE, INVARIANT_HTTP_METHODS } from "./shared.js";

/**
 * Package-internal helpers shared across the invariant modules (parser, schema, validator) but
 * never part of `@jevitate/recording`'s public surface — none of these were exported from the
 * pre-split `invariants.ts` either (the zod object schemas below were the file's private
 * "=== Schema ===" section; they stay ungrouped from their kind's public type so the
 * `invariants.ts` barrel can `export *` each kind module without leaking them). Deliberately NOT
 * re-exported by the `invariants.ts` barrel.
 */

export const RESERVED = new Set(["before", "after", "delta", "contains", "sameList", "null", "true", "false"]);
/** `${capture.<name>}` in a probe path or a `deniedAs.open` (#147). */
export const CAPTURE_REF_RE = /\$\{capture\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** A `when.after` naming a capture (#147). */
export const CAPTURE_GATE_RE = /^capture\.([A-Za-z_][A-Za-z0-9_]*)$/;
export const MAX_EXPRESSION_CHARS = 1_000;

const HTTP_METHOD_MSG = `must be one of ${INVARIANT_HTTP_METHODS.join(", ")} (case-insensitive)`;
export const httpMethodField = (): z.ZodOptional<z.ZodString> =>
  z
    .string()
    .refine((m) => (INVARIANT_HTTP_METHODS as readonly string[]).includes(m.toUpperCase()), HTTP_METHOD_MSG)
    .optional();

export const OpSchema = z.enum(ACTION_OPS, {
  error: (issue) => `unknown op ${JSON.stringify(issue.input)} (expected one of ${ACTION_OPS.join(", ")})`,
});

export const TextPatternSchema = z
  .string()
  .min(1)
  .superRefine((s, ctx) => {
    try {
      patternRegex(s);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: `invalid regex: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

export const JsonPathStringSchema = z.string().superRefine((s, ctx) => {
  try {
    parseJsonPath(s);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : String(e) });
  }
});

export const DomObservableSchema = z
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

export const NetworkObservableSchema = z
  .object({
    url: z.string().min(1),
    method: httpMethodField(),
    json: JsonPathStringSchema.optional(),
    request: JsonPathStringSchema.optional(),
    optional: z.boolean().optional(),
  })
  .strict()
  .superRefine((n, ctx) => {
    if ((n.json === undefined) === (n.request === undefined)) {
      ctx.addIssue({ code: "custom", message: "a network observable reads exactly one of json (the response body) or request (the request body)", path: ["json"] });
    }
  });

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

export const ProbeObservableSchema = z
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
export const ObservableSchema = z
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

export const NeverResponseSchema = z
  .object({
    url: z.string().min(1).max(2_000),
    status: z.union([
      z.number().int().min(100).max(599),
      z.string().regex(/^([1-5][0-9]{2}|[1-5][xX]{2})$/, 'status is a code ("403") or a class ("4xx")'),
    ]),
    method: httpMethodField(),
  })
  .strict();

export const NeverSchema = z
  .object({ pageText: TextPatternSchema.optional(), assertion: AssertionSchema.optional(), response: NeverResponseSchema.optional() })
  .strict()
  .superRefine((n, ctx) => {
    if ([n.pageText, n.assertion, n.response].filter((k) => k !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", message: "a never is exactly one of pageText, assertion or response" });
    }
  });

export const CaptureWhenSchema = z
  .object({
    control: z.object({ name: TextPatternSchema }).strict().optional(),
    route: z.string().min(1).optional(),
    op: z.array(OpSchema).min(1).optional(),
  })
  .strict()
  .refine((w) => w.control !== undefined || w.route !== undefined || w.op !== undefined, "after names at least one of control, route or op");

export const CaptureSchema = z
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

export const DeniedAsSchema = z
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
