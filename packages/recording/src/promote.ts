import type { Recording, RecordedStep, PageSegment } from "./schema.js";
import { RecordingSchema } from "./schema.js";

export interface StepRef {
  page: number;
  step: number;
}

/**
 * Promotes a step's value to a variable in a recording.
 * Returns a new Recording with the target step's value changed to a variable reference
 * and its variableName field set. The original recording is not mutated.
 *
 * @throws if the step kind is not "fill" or "select"
 * @throws if page or step index is out of range
 */
export function promoteToVariable(
  rec: Recording,
  ref: StepRef,
  varName: string,
): Recording {
  // Validate indices
  if (ref.page < 0 || ref.page >= rec.pages.length) {
    throw new Error(`Page index ${ref.page} out of range (0-${rec.pages.length - 1})`);
  }

  const page = rec.pages[ref.page];
  if (ref.step < 0 || ref.step >= page.steps.length) {
    throw new Error(`Step index ${ref.step} out of range (0-${page.steps.length - 1})`);
  }

  const recordedStep = page.steps[ref.step];
  const step = recordedStep.step;

  // Validate that only fill/select steps can be promoted
  if (step.kind !== "fill" && step.kind !== "select") {
    throw new Error(
      `Only fill and select steps can be promoted, but found "${step.kind}"`,
    );
  }

  // Build new recording with deep clone of the path from root to target step
  const newPages: PageSegment[] = rec.pages.map((p, pageIdx) => {
    if (pageIdx !== ref.page) {
      // Keep other pages as-is
      return p;
    }

    // Clone this page
    const newSteps: RecordedStep[] = p.steps.map((s, stepIdx) => {
      if (stepIdx !== ref.step) {
        // Keep other steps as-is
        return s;
      }

      // Clone the target step and modify it
      return {
        ...s,
        step: {
          ...step,
          value: { var: varName },
        },
        variableName: varName,
      };
    });

    return {
      ...p,
      steps: newSteps,
    };
  });

  const newRecording: Recording = {
    ...rec,
    pages: newPages,
  };

  // Validate the result against the schema
  const validation = RecordingSchema.safeParse(newRecording);
  if (!validation.success) {
    throw new Error(`Recording validation failed: ${validation.error.message}`);
  }
  return validation.data;
}

/**
 * Returns every declared variable name in the recording,
 * in document order (page order, then step order within a page).
 */
export function boundVariables(rec: Recording): string[] {
  const vars: string[] = [];

  for (const page of rec.pages) {
    for (const recordedStep of page.steps) {
      if (recordedStep.variableName !== undefined) {
        vars.push(recordedStep.variableName);
      }
    }
  }

  return vars;
}
