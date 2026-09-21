import type { Recording, DiffResult, ColumnClass, PostdocDecision } from "@jevitate/recording";
import { flattenBaseFillSteps, CONFIDENT_VARIABLE_THRESHOLD } from "@jevitate/recording";

/**
 * Produces `PostdocDecision[]` for `applyPostdoc` WITHOUT a human in the
 * loop, for the fully-automated Jev-driving authoring pipeline:
 *
 * - confident variable (kind "variable", confidence >= CONFIDENT_VARIABLE_THRESHOLD)
 *   -> promote to a named `{var}` slot.
 * - "constant" -> materialize take 0's local captured value as a literal
 *   (always replayable — this is what a single take, or a corroborated
 *   constant, safely resolves to).
 * - anything else ("noise", "ambiguous", "enumeration", or a variable BELOW
 *   the confidence threshold) -> `handback`: never guess at a possibly-sensitive
 *   varying value. This is the conservative default the design calls for
 *   ("default constant unless corroborated... ambiguous surfaced to the
 *   human/LLM") — here "surfaced" means a replay-time handback rather than
 *   blocking authoring on a synchronous human decision.
 *
 * `base` must be take 0 of the SAME `diffTakes(takes)` call that produced
 * `diff` (same precondition as `@jevitate/recording`'s `applyDiff`).
 */
export function autoDecidePostdoc(base: Recording, diff: DiffResult): PostdocDecision[] {
  const baseFillSteps = flattenBaseFillSteps(base);
  const valueBearingColumns = diff.columns
    .map((columnClass, originalIndex) => ({ columnClass, originalIndex }))
    .filter(({ columnClass }) => columnClass.values[0] !== null);

  if (baseFillSteps.length !== valueBearingColumns.length) {
    throw new Error(
      `autoDecidePostdoc: base has ${baseFillSteps.length} fill/select step(s) but diff has ` +
        `${valueBearingColumns.length} value-bearing column(s) — base must be take 0 of the ` +
        `diffTakes(...) call that produced this diff`,
    );
  }

  const usedNames = new Set<string>();
  return baseFillSteps.map(({ ref }, k) => {
    const { columnClass, originalIndex } = valueBearingColumns[k];

    if (columnClass.kind === "variable" && columnClass.confidence >= CONFIDENT_VARIABLE_THRESHOLD) {
      const name = pickAutoName(columnClass, originalIndex, usedNames);
      usedNames.add(name);
      return { step: ref, classify: "variable", name };
    }
    if (columnClass.kind === "constant") {
      return { step: ref, classify: "constant" };
    }
    return {
      step: ref,
      classify: "handback",
      prompt: `Jev-driven authoring could not confidently classify this field's value (${columnClass.kind}, confidence ${columnClass.confidence.toFixed(2)}) — please provide it at replay time.`,
    };
  });
}

function pickAutoName(columnClass: ColumnClass, originalIndex: number, used: Set<string>): string {
  const base = columnClass.inferredType ?? "value";
  let n = originalIndex;
  let name = `${base}${n}`;
  while (used.has(name)) {
    n++;
    name = `${base}${n}`;
  }
  return name;
}
