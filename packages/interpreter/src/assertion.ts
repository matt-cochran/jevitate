import type { Assertion } from "@doit/recording";
import type { Actor } from "@doit/screenplay";
import { BrowseTheWebToken, CountOf, IsVisible, TextOf } from "@doit/screenplay";
import { descriptorToTarget } from "./descriptor.js";

/**
 * Evaluates a closed-schema `Assertion` against the current page state,
 * routing each `kind` to its corresponding Screenplay question (RxD design
 * spec §4). Returns a boolean rather than throwing — callers (e.g.
 * `runStep`) decide whether a `false` result is fatal.
 */
export async function checkAssertion(actor: Actor, a: Assertion): Promise<boolean> {
  switch (a.kind) {
    case "visible":
      // NOTE (deferred to a future milestone, documentation-only): this is a
      // ONE-SHOT sample — the underlying `locator.isVisible()` (and, for
      // `urlIncludes` below, `page.url()`) do not retry/wait, unlike
      // Playwright's own action auto-waiting. A postcondition check here
      // does not poll, so a `visible`/`urlIncludes` expect immediately
      // after an async-rendering action can race and fail-closed-but-falsely
      // (the real outcome held, but wasn't observable yet at check time).
      // Flag as a known gap to resolve (e.g. via bounded polling) before a
      // future milestone relies on generated recordings with auto-inserted
      // postconditions at scale.
      return actor.asks(IsVisible.target(descriptorToTarget(a.target)));
    case "urlIncludes": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      return page.url().includes(a.text);
    }
    case "textIncludes": {
      const text = await actor.asks(TextOf.target(descriptorToTarget(a.target)));
      return text.includes(a.text);
    }
    case "count": {
      const n = await actor.asks(CountOf.target(descriptorToTarget(a.target)));
      return (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max);
    }
  }
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
  }
}
