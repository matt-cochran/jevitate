// ux-api.ts — the CLI layer over @jevitate/ux. Two surfaces:
//   - runUxReview(): offline analysis over a saved Recording (`jevitate ux`).
//   - runUsabilityMission(): live analysis during an exploration
//     (`explore --strategy usability`) — reuses explore()'s loop via the
//     additive onSnapshot hook, collects evidence per screen, and analyzes
//     ONCE post-run (proper batching/budget; no model calls slow the browser).
//
// This is the ONLY place @jevitate/ux meets @jevitate/explore — the dep
// direction stays ux ⟂ explore (both are consumed here, neither imports the
// other). Findings are advisory; a UX finding never gates a run.
export { type RunUsabilityMissionOptions, type RunUsabilityMissionResult, UsabilityInvariantsUnsupportedError, runUsabilityMission } from "./ux-usability.js";
export { type LoadedSidecars, type RecordingSidecars, type RunUxReviewOptions, type RunUxReviewResult, UxAnalysisFailedError, discoverRecordingSidecars, loadRecordingSidecars, runUxReview } from "./ux-review.js";
export { type MissionTranscriptEntryLike, captureFromTranscript, extractTypedValues, recordingToEvidence, snapshotToEvidence } from "./ux-evidence.js";

