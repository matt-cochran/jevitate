import { navigateUrlParams, type Step, type ValueOrVar } from "@jevitate/recording";

function varName(v: ValueOrVar | undefined): string[] {
  return v !== undefined && "var" in v ? [v.var] : [];
}

/** The parameters (by name) a step uses, its `forEach` children included. */
export function paramsOf(step: Step): string[] {
  switch (step.kind) {
    case "navigate":
      return navigateUrlParams(step.url);
    case "fill":
    case "select":
      return varName(step.value);
    case "editText":
      return varName(step.value);
    case "upload":
      return varName(step.file);
    case "forEach":
      return step.steps.flatMap(paramsOf);
    default:
      return [];
  }
}
