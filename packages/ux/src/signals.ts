// signals.ts — usability findings from CONCRETE, verifiable run signals (#96).
//
// The rubric tier asks Jev whether a screen violates a principle; this tier asks nothing of a
// model. It reads what the run itself measured — the requests it saw (method, endpoint, status,
// start/end), the screens it observed (url, signature, visible text, a busy indicator) and the
// steps it took — and applies app-agnostic, mechanical oracles:
//
//   - hung request   — a request pending far past the run's own typical settle time while no
//                      screen in that window showed any status (a job that silently hangs);
//   - duplicate write — the same control clicked twice on the same page, and the same write
//                      request (POST/PUT/PATCH/DELETE) succeeded both times (a double launch);
//   - internal id    — a UUID/ObjectId/prefixed-id-shaped string rendered in user-facing text
//                      that the run did not type itself;
//   - inert control  — a successful click after which nothing observable changed: same url,
//                      same screen signature, same visible text, and no request.
//
// Each finding cites its evidence (step, requests, text, screenshot) and carries a confidence
// derived from the strength of that evidence — never from a model. They are UxFindings with tier
// `signal`, so they go through the report's --min-confidence suppression like every other finding
// (they are ungraded, like the objective a11y tier, so the quality policy does not apply).
//
// Inputs arrive ALREADY REDACTED (the capture layer redacts urls/text before they reach here).
import type { AnalysisOutcome, UxFinding } from "./types.js";
import { detectDuplicateWrites, detectHungRequests, detectInertControls, detectInternalIds } from "./signals/basic.js";
import { detectJourneySignals } from "./signals/journey.js";
import type { RunSignalCapture, SignalOptions } from "./signals/types.js";

export * from "./signals/types.js";
export * from "./signals/finding.js";
export * from "./signals/basic.js";
export * from "./signals/journey.js";

/** Every signal oracle over one run's capture. */
export function detectSignals(capture: RunSignalCapture, opts: SignalOptions = {}): UxFinding[] {
  const journey = detectJourneySignals(capture, opts);
  return [
    ...detectHungRequests(capture, opts),
    ...withoutSubsumedDuplicateWrites(detectDuplicateWrites(capture, opts), journey),
    ...detectInternalIds(capture),
    ...detectInertControls(capture),
    ...journey,
  ];
}

/**
 * Adds signal findings to an analysis outcome, so they reach `buildReport` — and its
 * --min-confidence suppression — exactly like rubric findings. A failed analysis is left as is.
 */
export function withSignalFindings(outcome: AnalysisOutcome, findings: readonly UxFinding[]): AnalysisOutcome {
  if (outcome.kind === "failed" || findings.length === 0) return outcome;
  return {
    ...outcome,
    findings: [...outcome.findings, ...findings],
    rawOccurrences: (outcome.rawOccurrences ?? outcome.findings.length) + findings.reduce((n, f) => n + f.occurrences, 0),
  };
}

/** A duplicate-write finding whose steps a duplicate-create already explains is the same defect — reported once. */
function withoutSubsumedDuplicateWrites(writes: readonly UxFinding[], journey: readonly UxFinding[]): UxFinding[] {
  const creates = journey.filter((f) => f.signal?.kind === "duplicate-create").map((f) => new Set(f.signal!.steps));
  if (creates.length === 0) return [...writes];
  return writes.filter((w) => !creates.some((c) => (w.signal?.steps ?? []).every((s) => c.has(s))));
}
