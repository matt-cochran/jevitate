
/**
 * The ONE place a mission's decision transcript is persisted, for every strategy that makes model
 * decisions (goal, usability, coverage, adversarial): `<artifact>.transcript.json` next to the
 * run's primary artifact (its Recording or report), so a stalled or failed run is explainable
 * after the fact. Entries are built by `@jevitate/explore`'s `TranscriptLog` from already-redacted
 * state — nothing here adds page data.
 */

/** `<dir>/<name>.json` → `<dir>/<name>.transcript.json` (any other extension is kept and suffixed). */
export function transcriptPathFor(artifactPath: string): string {
  return artifactPath.endsWith(".json")
    ? `${artifactPath.slice(0, -".json".length)}.transcript.json`
    : `${artifactPath}.transcript.json`;
}
