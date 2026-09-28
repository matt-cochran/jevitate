import { z } from "zod";
import { parseJsonPath } from "./json-path.js";
import { patternRegex } from "./patterns.js";
import { ACTION_OPS, INVARIANT_HTTP_METHODS } from "./shared.js";

/**
 * Package-internal helpers shared across the invariant modules (parser, schema, validator) but
 * never part of `@jevitate/recording`'s public surface — none of these were exported from the
 * pre-split `invariants.ts` either. Deliberately NOT re-exported by the `invariants.ts` barrel.
 */

export const RESERVED = new Set(["before", "after", "delta", "contains", "null", "true", "false"]);
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
