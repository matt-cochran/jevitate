import { boundVariables, type Recording } from "@doit/recording";

export interface ParamSchema { required: string[] }
export class ParamValidationError extends Error {}

export function deriveParamSchema(rec: Recording): ParamSchema {
  return { required: boundVariables(rec) };
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
