import { AnchorEditError, FsJourneyStore, JourneyRegistry, addAnchor, anchorAddCommand, anchorLintIssues, removeAnchor, suggestAnchors, stampUnstampedAnchors, type AddAnchorInput, type AnchorLintIssue, type AnchorSuggestion, type Journey, type StampedAnchor } from "@jevitate/journey";
import { UnknownJourneyError } from "./journey-api.js";
import { journeyReviewHash } from "./journey-review.js";

/**
 * #487/#507: edit a Journey's anchors (`journey anchor add|remove`, `journey lint --fix`) — the API
 * both the CLI and MCP call. Each edit writes the Journey (step ids minted and anchors stamped the
 * way `promote` does) and returns the anchor lint issues that remain. On a PROMOTED Journey (#507)
 * add/remove still work: it stays promoted with its old approval kept (as after `migrate --step-ids`),
 * the approval is now stale, and the result carries the re-approval command. `journey lint --fix` does the same.
 */

export interface AnchorEditResult {
  readonly journeyId: string;
  /** The Journey's anchor-rule problems after the edit (warnings; empty when it complies). */
  readonly issues: readonly AnchorLintIssue[];
  /** #507: true (only) when the edited Journey is promoted — its approval is now stale until a person re-approves. */
  readonly needsReapproval?: true;
  /** #507: with `needsReapproval`: `jevitate journey promote <id> --reviewed-hash <new review hash>`. */
  readonly reapproveCommand?: string;
}

export interface AnchorFixResult extends AnchorEditResult {
  /** The anchors given a step id (empty: nothing needed it, nothing was written). */
  readonly stamped: readonly StampedAnchor[];
}

async function load(dir: string, id: string): Promise<{ store: FsJourneyStore; journey: Journey }> {
  const store = new FsJourneyStore(dir);
  const journey = await new JourneyRegistry(store).get(id);
  if (journey === null) throw new UnknownJourneyError(`unknown journey '${id}'`);
  return { store, journey };
}

/** The result for a Journey just written: its anchor issues, plus (#507) the re-approval a promoted one now needs. */
function written(id: string, journey: Journey): AnchorEditResult {
  const issues = anchorLintIssues(journey);
  if (!journey.metadata.promoted) return { journeyId: id, issues };
  return { journeyId: id, issues, needsReapproval: true, reapproveCommand: `jevitate journey promote ${id} --reviewed-hash ${journeyReviewHash(journey)}` };
}

async function edit(dir: string, id: string, change: (j: Journey) => Journey): Promise<AnchorEditResult> {
  const { store, journey } = await load(dir, id);
  const next = change(journey);
  await store.put(next);
  return written(id, (await store.get(id)) ?? next);
}

/** Adds an anchor (`stepId` written at once). Throws `UnknownJourneyError`, `AnchorEditError`. */
export function addJourneyAnchor(dir: string, id: string, input: AddAnchorInput): Promise<AnchorEditResult> {
  return edit(dir, id, (j) => addAnchor(j, input));
}

/** Removes the named anchor. Throws as `addJourneyAnchor`. */
export function removeJourneyAnchor(dir: string, id: string, name: string): Promise<AnchorEditResult> {
  return edit(dir, id, (j) => removeAnchor(j, name));
}

/** `journey lint --fix`: stamps each number-only anchor with its step's id and writes the Journey (#507: a promoted one too — its approval goes stale). Nothing to stamp: nothing written. */
export async function fixJourneyAnchors(dir: string, id: string): Promise<AnchorFixResult> {
  const { store, journey } = await load(dir, id);
  const { journey: next, stamped } = stampUnstampedAnchors(journey);
  if (stamped.length === 0) return { journeyId: id, issues: anchorLintIssues(journey), stamped };
  await store.put(next);
  return { ...written(id, (await store.get(id)) ?? next), stamped };
}

export interface AnchorSuggestResult {
  readonly journeyId: string;
  readonly steps: number;
  /** Advisory only: nothing was written. Each carries the `journey anchor add` command that accepts it. */
  readonly suggestions: readonly (AnchorSuggestion & { readonly command: string })[];
}

/** `journey anchors --suggest`: anchors worth adding where the recorded flow changes state. Writes nothing. */
export async function suggestJourneyAnchors(dir: string, id: string, readRequests?: readonly string[]): Promise<AnchorSuggestResult> {
  const { journey } = await load(dir, id);
  const suggestions = suggestAnchors(journey, { readRequests }).map((s) => ({ ...s, command: anchorAddCommand(id, s) }));
  return { journeyId: id, steps: journey.recording.pages.reduce((n, p) => n + p.steps.length, 0), suggestions };
}

export { AnchorEditError };
