import { assertionRefs, boundVariables, navigateUrlParams, type Assertion, type Recording } from "@jevitate/recording";
import { ownAssertions, type Journey } from "./journey.js";

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

/**
 * #573: the params a Journey RUN takes — its Recording's (`deriveParamSchema`), then every declared
 * parameter (`params` / `parameters`) only an assertion names: a step expectation or an end-state
 * check comparing against `{ var: x }` / `${x}`. Such a value is expected context, not an action
 * input, so nothing in the Recording binds it; a name an earlier `extract` binds is not a param.
 */
export function journeyParamSchema(journey: Journey): ParamSchema {
  const { required } = deriveParamSchema(journey.recording);
  const declared = new Set([...journey.metadata.params, ...(journey.metadata.parameters ?? []).map((p) => p.name)]);
  const extracted = new Set<string>();
  const add = (a: Assertion): void => {
    for (const name of assertionRefs(a)) {
      if (declared.has(name) && !extracted.has(name) && !required.includes(name)) required.push(name);
    }
  };
  for (const page of journey.recording.pages) {
    for (const { step } of page.steps) {
      if (step.kind === "extract") extracted.add(step.as);
      for (const { assertion } of ownAssertions(step)) add(assertion);
      if (step.kind === "forEach") {
        for (const child of step.steps) {
          if (child.kind === "extract") extracted.add(child.as);
          for (const { assertion } of ownAssertions(child)) add(assertion);
        }
      }
    }
  }
  for (const c of journey.metadata.endState ?? []) if (c.kind === "page" || c.kind === "reloadThen") add(c.assertion);
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

/**
 * #399: every `--param` a Journey takes, for listings (`journey find`, MCP `find_capabilities`, the
 * named tools): its declared `params`, then any required one only its steps name (a navigate
 * `${placeholder}` declared in `parameters` alone).
 */
export function journeyRunParams(journey: Journey): string[] {
  const out = [...journey.metadata.params];
  for (const p of journeyParamSchema(journey).required) if (!out.includes(p)) out.push(p);
  return out;
}
