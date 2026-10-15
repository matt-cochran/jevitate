import { contentHash } from "@jevitate/domain";
import type { Journey } from "./journey.js";

/*
 * #523 — the proof hash: what a `journey verify --mutate` verdict is bound to. It hashes the
 * Journey's EXECUTABLE content only, so approving wording (`journey annotate --approve`), linking a
 * job or persona, or promoting never makes a mutation proof look out of date.
 *
 * Default for a field not listed here: INCLUDED. The projection is a denylist of prose, never an
 * allowlist of executable fields — a new executable field must stale proofs without anyone
 * remembering to add it here; a new prose field merely stales a proof until it is denylisted (safe).
 *
 * | Where                              | Field                                  | Proof hash | Why                                                      |
 * |------------------------------------|----------------------------------------|------------|----------------------------------------------------------|
 * | metadata                           | id, params, secretRefs, requiresAuth   | included   | what runs and with which inputs/session                  |
 * | metadata                           | parameters (name, secret)              | included   | declared inputs and their redaction                      |
 * | metadata                           | parameters[].description               | excluded   | prose                                                    |
 * | metadata                           | preconditions (fixture, hook, login)   | included   | how the start state is set up                            |
 * | metadata                           | preconditions[].description            | excluded   | prose                                                    |
 * | metadata                           | successCriteria[].check                | included   | a code check (the list of checks; a check-less entry adds nothing) |
 * | metadata                           | successCriteria[].description          | excluded   | prose (annotate writes it)                               |
 * | metadata                           | endState, networkChecks, mutationPairs | included   | assertions and the declared negative proofs              |
 * | metadata                           | anchors (name, step, stepId, region)   | included   | mutation sites (`skip:<anchor>`); region scopes missions |
 * | metadata                           | anchors[].description, probes          | excluded   | text for people and missions, never executed             |
 * | metadata                           | anchors[].jobStep, boundary            | excluded   | catalog links                                            |
 * | metadata                           | name, description, goal, role          | excluded   | prose (annotate writes goal)                             |
 * | metadata                           | persona, job, serves                   | excluded   | catalog links, not executed                              |
 * | metadata                           | extensions                             | excluded   | tool-specific fields carried verbatim, never executed    |
 * | metadata                           | promoted, approval, acceptedWeak       | excluded   | approval bookkeeping                                     |
 * | metadata                           | createdAtIso, authoredBy               | excluded   | provenance bookkeeping                                   |
 * | recording                          | version, site, fixture, emulation      | included   | what replays, where, from which state, on which device   |
 * | recording                          | extensions (browser extensions)        | included   | the build replay must match                              |
 * | recording                          | startedAtIso, intent, retro            | excluded   | bookkeeping and prose                                    |
 * | recording.pages[]                  | url, title                             | included   | segment identity (default: included)                     |
 * | recording.pages[].steps[]          | step (action, target, value, expect…)  | included   | the action and its assertion                             |
 * | recording.pages[].steps[]          | stepId, expectRequests, responseTimeout| included   | step identity (mutation sites) and per-step checks       |
 * | recording.pages[].steps[]          | timing, marker, variableName, delta…   | included   | default: included                                        |
 * | recording.pages[].steps[]          | objective, expectedResult              | excluded   | prose, never replayed (annotate writes them)             |
 * | recording.pages[].steps[]          | chunk                                  | excluded   | grouping annotation, never replayed                      |
 * | any TargetDescriptor (anywhere)    | display, tflowId, testIdAttr           | excluded   | display/tracking metadata, never a locator (#468/#470/#497) |
 */

const METADATA_PROSE = [
  "name", "description", "goal", "role", "persona", "job", "serves", "extensions",
  "promoted", "approval", "acceptedWeak", "createdAtIso", "authoredBy",
] as const;
const RECORDING_PROSE = ["startedAtIso", "intent", "retro"] as const;
const STEP_PROSE = ["objective", "expectedResult", "chunk"] as const;
/** Keys a TargetDescriptor carries that never locate an element. Nothing else in a (prose-free) Journey uses these key names. */
const DESCRIPTOR_METADATA = new Set(["display", "tflowId", "testIdAttr"]);

function omit(o: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  for (const k of keys) delete out[k];
  return out;
}

/** A deep copy without descriptor metadata keys (recursing into containers, assertions, checks and nested steps). */
function stripDescriptorMetadata(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDescriptorMetadata);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!DESCRIPTOR_METADATA.has(k)) out[k] = stripDescriptorMetadata(x);
  return out;
}

/**
 * #523: the hash of a Journey's executable content (see the table above) — what a mutation proof is
 * bound to. Prose, catalog links and approval bookkeeping do not change it.
 */
export function journeyProofHash(journey: Journey): string {
  const m = journey.metadata;
  const metadata = omit(m, METADATA_PROSE);
  if (m.parameters !== undefined) metadata.parameters = m.parameters.map((p) => omit(p, ["description"]));
  if (m.preconditions !== undefined) metadata.preconditions = m.preconditions.map((p) => omit(p, ["description"]));
  // Only the code checks: a criterion annotate adds in words (no `check`) leaves the hash as it was.
  delete metadata.successCriteria;
  const checks = (m.successCriteria ?? []).flatMap((c) => (c.check === undefined ? [] : [c.check]));
  if (checks.length > 0) metadata.successCriteriaChecks = checks;
  if (m.anchors !== undefined) metadata.anchors = m.anchors.map((a) => omit(a, ["description", "probes", "jobStep", "boundary"]));
  const recording = omit(journey.recording, RECORDING_PROSE);
  recording.pages = journey.recording.pages.map((p) => ({
    ...p,
    steps: p.steps.map((s) => omit(s, STEP_PROSE)),
  }));
  return contentHash(stripDescriptorMetadata({ metadata, recording }));
}
