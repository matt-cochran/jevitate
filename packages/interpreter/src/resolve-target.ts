import type { Locator, Page } from "playwright";
import type { TargetDescriptor } from "@jevitate/recording";
import { clock } from "@jevitate/domain";

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

/** The attribute Playwright's `getByTestId` matches (its default; jevitate never reconfigures it). */
export const PLAYWRIGHT_TEST_ID_ATTRIBUTE = "data-testid";

/** #468: TFlow tracking metadata — never a locator and never a test-id attribute. */
export const TFLOW_ID_ATTRIBUTE = "data-tflow-id";

/** An HTML attribute name safe to put in a css attribute selector unquoted. */
const ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/**
 * #470: the test-id locator. Playwright's `getByTestId` only matches its ONE configured attribute
 * (`data-testid`), so a test id recorded from another attribute (`data-test`, a team's `data-cy`)
 * resolves by an exact `[attr="value"]` css match instead. `data-tflow-id` is refused: tracking
 * metadata never locates an element.
 */
function testIdLocator(page: Page, testId: string, attr: string | undefined): Locator {
  if (attr === undefined || attr === PLAYWRIGHT_TEST_ID_ATTRIBUTE) return page.getByTestId(testId);
  if (attr === TFLOW_ID_ATTRIBUTE) throw new Error(`${TFLOW_ID_ATTRIBUTE} is tracking metadata, never a test-id attribute`);
  if (!ATTRIBUTE_NAME.test(attr)) throw new Error(`testIdAttr is not an attribute name: ${JSON.stringify(attr)}`);
  return page.locator(`[${attr}=${JSON.stringify(testId)}]`);
}

/**
 * #470: the rung a target resolves by — `anchor` (a recorded `[id]`/`[name]`) or the descriptor's own
 * rung. Metadata for locator health; it never changes how a target resolves.
 */
export type ResolvedRung = "anchor" | "testId" | "role+name" | "label" | "text" | "css";

/** #470: how one step's target actually resolved at replay. */
export interface ResolvedTarget {
  readonly rung: ResolvedRung;
  /** The `testId` rung: the attribute it matched (absent = `data-testid`). */
  readonly testIdAttr?: string;
  /** The recorded `ordinal` the rung needed to tell equally-named elements apart. */
  readonly ordinal?: number;
  /** How many elements the rung matched when it needed an `ordinal`. */
  readonly candidates?: number;
}

/** The descriptor's own rung, in `rungLocator`'s order (no anchor). Throws like `rungLocator` on none. */
export function descriptorRung(d: TargetDescriptor): Exclude<ResolvedRung, "anchor"> {
  if (d.testId) return "testId";
  if (d.role && d.name) return "role+name";
  if (d.label) return "label";
  if (d.text) return "text";
  if (d.css) return "css";
  throw new Error(`TargetDescriptor has no usable selector: ${JSON.stringify(d)}`);
}

/** The rung's locator, BEFORE `ordinal` — exact name/label/text matching. */
export function rungLocator(page: Page, d: TargetDescriptor): Locator {
  if (d.frameUrl) throw new Error("frameUrl is not supported in A.1");
  if (d.testId) return testIdLocator(page, d.testId, d.testIdAttr);
  if (d.role && d.name) {
    return page.getByRole(d.role as Parameters<Page["getByRole"]>[0], { name: d.name, exact: true });
  }
  if (d.label) return page.getByLabel(d.label, { exact: true });
  // #335: `textMatch: "contains"` (a success check's `textContains=`) matches a substring.
  if (d.text) return page.getByText(d.text, { exact: d.textMatch !== "contains" });
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
  if (d.testId) return d.testIdAttr === undefined || d.testIdAttr === PLAYWRIGHT_TEST_ID_ATTRIBUTE ? `testId=${d.testId}` : `testId[${d.testIdAttr}]=${d.testId}`;
  if (d.role && d.name) return `role=${d.role} name=${JSON.stringify(d.name)}`;
  if (d.label) return `label=${JSON.stringify(d.label)}`;
  if (d.text) return `${d.textMatch === "contains" ? "textContains" : "text"}=${JSON.stringify(d.text)}`;
  return `css=${d.css ?? "?"}`;
}

export interface ResolveTargetOptions {
  /** How long the target may take to appear (ms). Default 15s. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /**
   * #470: told how the target resolved (the rung, and the ordinal it needed), once, just before
   * `resolveTarget` returns. Metadata only: it is never told about a failed resolution and cannot
   * change the outcome.
   */
  readonly onResolved?: (via: ResolvedTarget) => void;
}

function resolvedVia(d: TargetDescriptor, rung: ResolvedRung, count: number): ResolvedTarget {
  return {
    rung,
    ...(rung === "testId" && d.testIdAttr !== undefined ? { testIdAttr: d.testIdAttr } : {}),
    ...(rung !== "anchor" && d.ordinal !== undefined ? { ordinal: d.ordinal, candidates: count } : {}),
  };
}

/**
 * Resolves the recorded target to exactly ONE element, waiting (bounded) for it to render. Throws
 * `ReplayTargetError` — never returns a guess.
 */
export async function resolveTarget(page: Page, d: TargetDescriptor, opts: ResolveTargetOptions = {}): Promise<Locator> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const anchor = anchorLocator(page, d.anchor);
    if (anchor !== null && (await anchor.count()) === 1) {
      opts.onResolved?.(resolvedVia(d, "anchor", 1));
      return anchor;
    }

    const base = rungLocator(page, d);
    const count = await base.count();
    if (d.ordinal !== undefined) {
      const sameField = d.candidates === undefined || count === d.candidates;
      if (sameField && count > d.ordinal) {
        opts.onResolved?.(resolvedVia(d, descriptorRung(d), count));
        return base.nth(d.ordinal);
      }
    } else if (count === 1) {
      opts.onResolved?.(resolvedVia(d, descriptorRung(d), count));
      return base;
    }

    if (clock.now() >= deadline) {
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
    await clock.sleep(pollMs);
  }
}
