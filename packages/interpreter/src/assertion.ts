import type { Assertion } from "@jevitate/recording";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, CountOf, IsVisible, TextOf, ValueOf } from "@jevitate/screenplay";
import { descriptorToTarget } from "./descriptor.js";
import { evaluateVisual, isVisualAssertion } from "./visual-state.js";

/** Default bound for the bounded polling loop, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5000;
/** Default interval between re-evaluations in the bounded polling loop, in milliseconds. */
const DEFAULT_POLL_MS = 100;

/**
 * Options for the bounded polling loop shared by `checkAssertion` and every
 * other postcondition check that needs the same retry window.
 */
export interface CheckAssertionOptions {
  /** Overall bound on how long to keep re-evaluating. Default 5000ms. */
  timeoutMs?: number;
  /** Interval between re-evaluations. Default 100ms. */
  pollMs?: number;
}

/**
 * The one bounded-polling primitive every postcondition check in the
 * interpreter goes through: re-evaluates `sample` at `opts.pollMs` intervals
 * (default 100ms) until it returns `true` or `opts.timeoutMs` (default
 * 5000ms) elapses.
 *
 * Exported so the row-scoped checks in `run-step.ts` (`forEach`'s "at least
 * one row" precondition and `checkAssertionInRow`) share this exact loop and
 * these exact defaults rather than growing a second, divergent one. Before
 * that, the same `Assertion` retried for 5s at the top level and failed
 * instantly inside a `forEach` row.
 *
 * Fails closed by construction: it returns `false` once the bound elapses
 * without `sample` ever holding. Polling only rescues a check that raced an
 * async UI update inside the window; it never converts a persistent failure
 * into a pass.
 */
export async function pollUntil(
  sample: () => Promise<boolean>,
  opts?: CheckAssertionOptions,
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await sample()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Evaluates a closed-schema `Assertion` against the current page state,
 * polling (re-evaluating) it at `opts.pollMs` intervals (default 100ms) up
 * to `opts.timeoutMs` (default 5000ms) — a bounded, web-first-assertion
 * style retry so a postcondition checked immediately after an
 * async-rendering action doesn't false-fail just because the UI hasn't
 * painted yet at the moment of the first sample.
 *
 * Returns `true` as soon as the assertion holds. Returns `false` only once
 * the timeout has elapsed without it ever holding — this still fails
 * closed: a timeout is never silently treated as success. Every `kind`
 * (`visible`/`urlIncludes`/`textIncludes`/`count`/`valueEquals`) goes through the same
 * polling wrapper; none is special-cased as one-shot.
 *
 * Returns a boolean rather than throwing — callers (e.g. `runStep`) decide
 * whether a `false` result is fatal.
 */
export async function checkAssertion(
  actor: Actor,
  a: Assertion,
  opts?: CheckAssertionOptions,
): Promise<boolean> {
  return pollUntil(() => evaluateAssertionOnce(actor, a), opts);
}

/**
 * `textIncludes`'s match: case-INsensitive (#113), and documented as such (`--help`, README). The
 * element's text comes from `TextOf` (`innerText`), which applies CSS `text-transform` — a badge
 * whose DOM text is "Approved" but renders `uppercase` reads "APPROVED", and a case-sensitive compare
 * would say the page never showed what it plainly does. Locale-aware casing (`toLocaleLowerCase`),
 * same as the rest of the interpreter's text matching.
 */
export function textIncludesCI(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

/** A single, non-retrying sample of `a` against the current page state. */
async function evaluateAssertionOnce(actor: Actor, a: Assertion): Promise<boolean> {
  if (isVisualAssertion(a)) {
    const page = actor.ability(BrowseTheWebToken).session.page;
    return (await evaluateVisual(a, (d) => descriptorToTarget(d).resolve(page))).held;
  }
  switch (a.kind) {
    case "visible":
      return actor.asks(IsVisible.target(descriptorToTarget(a.target)));
    case "urlIncludes": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      return page.url().includes(a.text);
    }
    case "textIncludes": {
      const text = await actor.asks(TextOf.target(descriptorToTarget(a.target)));
      return text !== null && textIncludesCI(text, a.text);
    }
    case "count": {
      const n = await actor.asks(CountOf.target(descriptorToTarget(a.target)));
      return (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max);
    }
    case "valueEquals":
      return (await actor.asks(ValueOf.target(descriptorToTarget(a.target)))) === a.value;
  }
}

/**
 * The literal text `textIncludes` compares against, for enriching a failure detail with what was
 * actually read (#113) — a case/CSS-text-transform mismatch is otherwise invisible in "did not
 * hold". The caller bounds and redacts it before surfacing it (page text is untrusted, and may carry
 * a secret). Returns null for a target that did not resolve, or for any other assertion kind.
 */
export async function readAssertionText(actor: Actor, a: Assertion): Promise<string | null> {
  if (a.kind !== "textIncludes") return null;
  return actor.asks(TextOf.target(descriptorToTarget(a.target))).catch(() => null);
}

/**
 * What a visual-state assertion (#148) observed — the ratio, the computed values, the flash timing —
 * for a verdict's detail (one fresh sample, decided by the same code as `checkAssertion`). Null for
 * any other kind. Page-derived: the caller bounds and redacts it before surfacing it.
 */
export async function readAssertionEvidence(actor: Actor, a: Assertion): Promise<string | null> {
  if (!isVisualAssertion(a)) return null;
  const page = actor.ability(BrowseTheWebToken).session.page;
  return (await evaluateVisual(a, (d) => descriptorToTarget(d).resolve(page))).detail;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown when a step's postcondition (`expect`/`check`) evaluates false.
 * This is the fail-closed guardrail from the RxD design spec's Poka-Yoke
 * language: an action whose expected outcome did not hold must never be
 * silently swallowed. The message includes enough of the assertion's shape
 * (kind, and target/text where present) for a caller such as
 * `RecordingInterpreter` to report "assertion X failed at step Y".
 */
export class PostconditionFailed extends Error {
  constructor(a: Assertion, context?: string) {
    super(`${context ? `${context}: ` : ""}postcondition failed: ${describeAssertion(a)}`);
    this.name = "PostconditionFailed";
  }
}

function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case "visible":
      return `kind=visible target=${JSON.stringify(a.target)}`;
    case "urlIncludes":
      return `kind=urlIncludes text=${JSON.stringify(a.text)}`;
    case "textIncludes":
      return `kind=textIncludes target=${JSON.stringify(a.target)} text=${JSON.stringify(a.text)}`;
    case "count":
      return `kind=count target=${JSON.stringify(a.target)} min=${a.min} max=${a.max}`;
    case "valueEquals":
      return `kind=valueEquals target=${JSON.stringify(a.target)} value=${JSON.stringify(a.value)}`;
    case "style":
      return `kind=style target=${JSON.stringify(a.target)} ${a.channel === undefined ? a.property : `${a.channel}(${a.property})`}${a.op}${JSON.stringify(a.value)}`;
    case "inViewport":
      return `kind=inViewport target=${JSON.stringify(a.target)} min=${a.min}`;
    case "box":
      return `kind=box target=${JSON.stringify(a.target)} width=${a.minWidth}..${a.maxWidth} height=${a.minHeight}..${a.maxHeight}`;
    case "overlap":
      return `kind=overlap target=${JSON.stringify(a.target)} other=${JSON.stringify(a.other)} overlapping=${a.overlapping}`;
    case "attr":
      return `kind=attr target=${JSON.stringify(a.target)} name=${a.name}${a.absent === true ? " absent" : a.value === undefined ? " present" : ` value=${JSON.stringify(a.value)}`}`;
    case "flashed":
      return `kind=flashed target=${JSON.stringify(a.target)} ${a.className !== undefined ? `class=${a.className}` : a.attr !== undefined ? `attr=${a.attr}` : "animation"} withinMs=${a.withinMs}`;
  }
}
