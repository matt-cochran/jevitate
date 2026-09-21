// index.ts — the FROZEN v1 rubric: Nielsen backbone + 5 Tier-1 differentiators
// + the objective-a11y subset. `loadV1Rubric()` validates + indexes it.
import type { RubricEntry } from "../../types.js";
import { loadRubric } from "../schema.js";
import { NIELSEN } from "./nielsen.js";
import { SCENT } from "./scent.js";
import { DISCLOSURE } from "./disclosure.js";
import { COGNITIVE_LOAD } from "./load.js";
import { PRIMARY_ACTION } from "./primary-action.js";
import { DARK_PATTERNS } from "./dark-patterns.js";
import { A11Y } from "./a11y.js";

export const V1_RUBRIC: readonly RubricEntry[] = Object.freeze([
  ...NIELSEN,
  SCENT,
  DISCLOSURE,
  COGNITIVE_LOAD,
  PRIMARY_ACTION,
  DARK_PATTERNS,
  ...A11Y,
]);

/** Validates and indexes the frozen v1 rubric into a `Map<id, RubricEntry>`. */
export function loadV1Rubric(): Map<string, RubricEntry> {
  return loadRubric(V1_RUBRIC);
}
