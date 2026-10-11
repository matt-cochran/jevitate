import { AnchorEditError, FsJourneyStore, JourneyRegistry, addAnchor, anchorLintIssues, removeAnchor, stampUnstampedAnchors, type AddAnchorInput, type AnchorLintIssue, type Journey, type StampedAnchor } from "@jevitate/journey";
import { UnknownJourneyError } from "./journey-api.js";

/**
 * #487: edit a draft Journey's anchors (`journey anchor add|remove`, `journey lint --fix`) — the API
 * both the CLI and MCP call. Each edit writes the Journey (step ids minted and anchors stamped the
 * way `promote` does) and returns the anchor lint issues that remain.
 */

/** A PROMOTED Journey's anchors changed: its approval binds to the content hash, so the edit would silently void it. Exit 64. */
export class PromotedJourneyEditError extends Error {
  readonly code = "E_JOURNEY_ANCHOR_ARGS";
  constructor(id: string) {
    super(
      `journey '${id}' is promoted: changing its anchors changes the content hash its approval is bound to (stamping a step id included, since the hash covers it). ` +
        `Edit it as a draft and re-promote — jevitate journey review ${id}, then jevitate journey promote ${id} — a person re-approves the new content`,
    );
  }
}

export interface AnchorEditResult {
  readonly journeyId: string;
  /** The Journey's anchor-rule problems after the edit (warnings; empty when it complies). */
  readonly issues: readonly AnchorLintIssue[];
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

async function edit(dir: string, id: string, change: (j: Journey) => Journey): Promise<AnchorEditResult> {
  const { store, journey } = await load(dir, id);
  if (journey.metadata.promoted) throw new PromotedJourneyEditError(id);
  const next = change(journey);
  await store.put(next);
  const written = (await store.get(id)) ?? next;
  return { journeyId: id, issues: anchorLintIssues(written) };
}

/** Adds an anchor (`stepId` written at once). Throws `UnknownJourneyError`, `PromotedJourneyEditError`, `AnchorEditError`. */
export function addJourneyAnchor(dir: string, id: string, input: AddAnchorInput): Promise<AnchorEditResult> {
  return edit(dir, id, (j) => addAnchor(j, input));
}

/** Removes the named anchor. Throws as `addJourneyAnchor`. */
export function removeJourneyAnchor(dir: string, id: string, name: string): Promise<AnchorEditResult> {
  return edit(dir, id, (j) => removeAnchor(j, name));
}

/** `journey lint --fix`: stamps each number-only anchor with its step's id and writes the Journey. Nothing to stamp: nothing written, even when promoted. */
export async function fixJourneyAnchors(dir: string, id: string): Promise<AnchorFixResult> {
  const { store, journey } = await load(dir, id);
  const { journey: next, stamped } = stampUnstampedAnchors(journey);
  if (stamped.length === 0) return { journeyId: id, issues: anchorLintIssues(journey), stamped };
  if (journey.metadata.promoted) throw new PromotedJourneyEditError(id);
  await store.put(next);
  return { journeyId: id, issues: anchorLintIssues((await store.get(id)) ?? next), stamped };
}

export { AnchorEditError };
