import { ensureStepIds } from "@jevitate/recording";
import { ANCHOR_NAME_RULE_RE, stampAnchorStepIds, suggestAnchorName } from "./anchor-rules.js";
import type { Journey, JourneyAnchor } from "./journey.js";

/**
 * #487: editing a Journey's anchors without hand-editing JSON. Pure: each function returns the
 * edited Journey (or throws `AnchorEditError`); the caller owns I/O, the promoted-Journey guard and
 * re-linting. An anchor written here carries its step's stable `stepId` at once (never "by number
 * only"), so `anchor-unstamped` never needs a later `journey promote` to be fixed.
 */

/** A refused anchor edit: a bad name, a duplicate, an unknown anchor or step. The CLI maps it to usage (64). */
export class AnchorEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorEditError";
  }
}

export interface AddAnchorInput {
  readonly name: string;
  /** A 1-based step number (`3`), or a step's stable id. */
  readonly step: string | number;
  readonly description?: string;
  readonly probes?: readonly string[];
}

function flatIds(journey: Journey): string[] {
  return journey.recording.pages.flatMap((p) => p.steps.map((s) => s.stepId ?? ""));
}

/** The Journey with a stable `stepId` on every step (deterministic; the same object when all have one). */
function withStepIds(journey: Journey): Journey {
  const recording = ensureStepIds(journey.recording);
  return recording === journey.recording ? journey : { ...journey, recording };
}

/** Resolves `--step <n|stepId>` to the step's number and id; throws `AnchorEditError` naming the valid choices. */
export function resolveAnchorStep(journey: Journey, step: string | number): { readonly step: number; readonly stepId: string } {
  const ids = flatIds(withStepIds(journey));
  const value = String(step).trim();
  if (/^[0-9]+$/.test(value)) {
    const n = Number(value);
    const id = ids[n - 1];
    if (id === undefined) throw new AnchorEditError(`step ${value} is not a step of journey '${journey.metadata.id}' (steps 1..${ids.length})`);
    return { step: n, stepId: id };
  }
  const index = ids.indexOf(value);
  if (value === "" || index < 0) {
    throw new AnchorEditError(`'${value}' is neither a step number (1..${ids.length}) nor a step id of journey '${journey.metadata.id}'`);
  }
  return { step: index + 1, stepId: value };
}

/** The Journey with the anchor added (its `stepId` and `step` both set). Refuses a bad or duplicate name and an unknown step. */
export function addAnchor(journey: Journey, input: AddAnchorInput): Journey {
  if (!ANCHOR_NAME_RULE_RE.test(input.name)) {
    throw new AnchorEditError(
      `anchor name '${input.name}': a name is 1-64 of lowercase a-z, 0-9, . _ - and starts with a letter or digit (try '${suggestAnchorName(input.name)}')`,
    );
  }
  if (/^[0-9]+$/.test(input.name)) throw new AnchorEditError(`anchor name '${input.name}': a name that is all digits reads as a step number — name it for the state`);
  const anchors = journey.metadata.anchors ?? [];
  if (anchors.some((a) => a.name === input.name)) {
    throw new AnchorEditError(`journey '${journey.metadata.id}' already has an anchor named '${input.name}' — remove it first or pick another name`);
  }
  const at = resolveAnchorStep(journey, input.step);
  const description = input.description?.trim() ?? "";
  const probes = (input.probes ?? []).map((p) => p.trim()).filter((p) => p !== "");
  const anchor: JourneyAnchor = {
    name: input.name,
    step: at.step,
    stepId: at.stepId,
    ...(description === "" ? {} : { description }),
    ...(probes.length === 0 ? {} : { probes }),
  };
  const stamped = withStepIds(journey);
  return { ...stamped, metadata: { ...stamped.metadata, anchors: [...anchors, anchor] } };
}

/** The Journey without the named anchor (`anchors` is dropped when none remain). Refuses an unknown name. */
export function removeAnchor(journey: Journey, name: string): Journey {
  const anchors = journey.metadata.anchors ?? [];
  if (!anchors.some((a) => a.name === name)) {
    throw new AnchorEditError(
      `journey '${journey.metadata.id}' has no anchor named '${name}'${anchors.length === 0 ? " (it declares no anchors)" : ` (its anchors: ${anchors.map((a) => a.name).join(", ")})`}`,
    );
  }
  const rest = anchors.filter((a) => a.name !== name);
  const { anchors: _gone, ...metadata } = journey.metadata;
  return { ...journey, metadata: { ...metadata, ...(rest.length === 0 ? {} : { anchors: rest }) } };
}

/** One anchor `lint --fix` stamped: its name, step number and the step id now written. */
export interface StampedAnchor {
  readonly name: string;
  readonly step: number;
  readonly stepId: string;
}

/**
 * `journey lint --fix` (#487): stamps the `stepId` of each anchor that references a step by number
 * only (the `anchor-unstamped` case), minting any missing step ids first. Only ids are added; `step`
 * is kept. The same Journey object and an empty list when nothing needed it.
 */
export function stampUnstampedAnchors(journey: Journey): { readonly journey: Journey; readonly stamped: StampedAnchor[] } {
  const anchors = journey.metadata.anchors ?? [];
  const needs = anchors.filter((a) => a.stepId === undefined);
  if (needs.length === 0) return { journey, stamped: [] };
  const result = stampAnchorStepIds(withStepIds(journey));
  const after = result.metadata.anchors ?? [];
  const stamped = anchors.flatMap((a, i) => {
    const id = after[i]?.stepId;
    return a.stepId === undefined && id !== undefined ? [{ name: a.name, step: a.step, stepId: id }] : [];
  });
  return { journey: stamped.length === 0 ? journey : result, stamped };
}
