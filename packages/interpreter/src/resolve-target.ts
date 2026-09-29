import type { Locator, Page } from "playwright";
import type { TargetDescriptor } from "@jevitate/recording";

/**
 * How a recorded target is found again at replay — the ONE definition, shared with the recorder
 * (which validates descriptors with the very same rung) so a descriptor proven at record time is a
 * descriptor that replays:
 *
 *  1. a recorded stable ANCHOR (`[id=…]` / `[name=…]`), when it still resolves to exactly one
 *     element;
 *  2. otherwise the rung — test id, or role + name / label / text matched EXACTLY (never by
 *     substring or prefix) — narrowed by the recorded `ordinal` among equally-named candidates.
 *     When the recording also noted how many candidates there were, a different count now means
 *     the page changed around the target.
 *
 * It never clicks a guess: a target that is missing, or matches more than one element with nothing
 * recorded to tell them apart, fails with a typed `ReplayTargetError`. Older recordings (no anchor,
 * no candidate count) replay with exact name + nth — never with substring matching.
 */

export type ReplayTargetFailure = "replay-target-not-found" | "ambiguous";

export class ReplayTargetError extends Error {
  constructor(
    readonly kind: ReplayTargetFailure,
    detail: string,
  ) {
    super(`${kind}: ${detail}`);
    this.name = "ReplayTargetError";
  }
}

/** The rung's locator, BEFORE `ordinal` — exact name/label/text matching. */
export function rungLocator(page: Page, d: TargetDescriptor): Locator {
  if (d.frameUrl) throw new Error("frameUrl is not supported in A.1");
  if (d.testId) return page.getByTestId(d.testId);
  if (d.role && d.name) {
    return page.getByRole(d.role as Parameters<Page["getByRole"]>[0], { name: d.name, exact: true });
  }
  if (d.label) return page.getByLabel(d.label, { exact: true });
  if (d.text) return page.getByText(d.text, { exact: true });
  if (d.css) return page.locator(d.css);
  throw new Error(`TargetDescriptor has no usable selector: ${JSON.stringify(d)}`);
}

/** The locator for a recorded attribute anchor, or null when none was captured. */
export function anchorLocator(page: Page, anchor: TargetDescriptor["anchor"]): Locator | null {
  const quote = (v: string): string => JSON.stringify(v);
  if (anchor?.id !== undefined) return page.locator(`[id=${quote(anchor.id)}]`);
  if (anchor?.name !== undefined) return page.locator(`[name=${quote(anchor.name)}]`);
  return null;
}

/** The rung narrowed by `ordinal` — synchronous, no uniqueness check (see `resolveTarget`). */
export function descriptorLocator(page: Page, d: TargetDescriptor): Locator {
  const base = rungLocator(page, d);
  return d.ordinal !== undefined ? base.nth(d.ordinal) : base;
}

function describe(d: TargetDescriptor): string {
  if (d.testId) return `testId=${d.testId}`;
  if (d.role && d.name) return `role=${d.role} name=${JSON.stringify(d.name)}`;
  if (d.label) return `label=${JSON.stringify(d.label)}`;
  if (d.text) return `text=${JSON.stringify(d.text)}`;
  return `css=${d.css ?? "?"}`;
}

export interface ResolveTargetOptions {
  /** How long the target may take to appear (ms). Default 15s. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

/**
 * Resolves the recorded target to exactly ONE element, waiting (bounded) for it to render. Throws
 * `ReplayTargetError` — never returns a guess.
 */
export async function resolveTarget(page: Page, d: TargetDescriptor, opts: ResolveTargetOptions = {}): Promise<Locator> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const anchor = anchorLocator(page, d.anchor);
    if (anchor !== null && (await anchor.count()) === 1) return anchor;

    const base = rungLocator(page, d);
    const count = await base.count();
    if (d.ordinal !== undefined) {
      const sameField = d.candidates === undefined || count === d.candidates;
      if (sameField && count > d.ordinal) return base.nth(d.ordinal);
    } else if (count === 1) {
      return base;
    }

    if (Date.now() >= deadline) {
      if (count === 0) throw new ReplayTargetError("replay-target-not-found", `${describe(d)} matched nothing`);
      if (d.ordinal !== undefined && d.candidates === undefined && count <= d.ordinal) {
        throw new ReplayTargetError(
          "replay-target-not-found",
          `${describe(d)} has ${count} match(es); the recorded one was #${d.ordinal + 1}`,
        );
      }
      throw new ReplayTargetError(
        "ambiguous",
        d.ordinal !== undefined
          ? `${describe(d)} now matches ${count} elements (recorded: #${d.ordinal + 1} of ${d.candidates ?? "?"})`
          : `${describe(d)} matches ${count} elements and nothing recorded tells them apart`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
