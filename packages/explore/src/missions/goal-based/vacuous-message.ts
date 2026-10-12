/** #202's vacuous-check message (#500: moved verbatim out of `goal-based.ts`; re-exported there with `export *`). */

/** #202: the named message for a check that was satisfied before the run did anything. */
export function vacuousCheckMessage(spec: string): string {
  return `check '${spec}' held at step 0, before any action — it cannot verify the goal`;
}
