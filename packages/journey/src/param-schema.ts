import { boundVariables, navigateUrlParams, type Recording } from "@jevitate/recording";

export interface ParamSchema { required: string[] }
export class ParamValidationError extends Error {}

/** The params a Recording takes: its bound variables, then (#399) any `${name}` in a navigate URL. */
export function deriveParamSchema(rec: Recording): ParamSchema {
  const required = boundVariables(rec);
  for (const page of rec.pages) {
    for (const { step } of page.steps) {
      if (step.kind !== "navigate") continue;
      for (const name of navigateUrlParams(step.url)) if (!required.includes(name)) required.push(name);
    }
  }
  return { required };
}

export function validateParams(schema: ParamSchema, params: Record<string, string>): void {
  const provided = Object.keys(params);
  const missing = schema.required.filter((v) => !(v in params));
  const unknown = provided.filter((p) => !schema.required.includes(p));
  if (missing.length > 0 || unknown.length > 0) {
    throw new ParamValidationError(
      `param mismatch — missing: [${missing.join(", ")}], unknown: [${unknown.join(", ")}]`,
    );
  }
}
