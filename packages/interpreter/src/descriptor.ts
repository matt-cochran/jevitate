import type { Locator, Page } from "playwright";
import type { TargetDescriptor } from "@jevitate/recording";
import { Target } from "@jevitate/screenplay";
import { descriptorLocator } from "./resolve-target.js";

/**
 * Builds a Screenplay Target from a closed-schema TargetDescriptor, following
 * the binding selector priority ladder (RxD design spec §4/§8):
 *
 *   testId > role+name > label > text > css
 *
 * `role`+`name` is a single combined rung: a `role` with no `name` does not
 * satisfy it, and falls through to the next rung exactly as if `role` were
 * absent.
 *
 * `frameUrl` is part of the TargetDescriptor shape but out of scope for this
 * ladder — iframe support is deferred beyond A.1. A descriptor with
 * `frameUrl` set throws unconditionally (checked before the ladder, even
 * when other fields are also set) rather than silently resolving against
 * the main frame — fail-closed, since "silently acted on the wrong frame"
 * is not the same failure mode as "not found."
 */
export function descriptorToTarget(d: TargetDescriptor): Target {
  if (d.frameUrl) {
    throw new Error("frameUrl is not supported in A.1");
  }
  if (!(d.testId || (d.role && d.name) || d.label || d.text || d.css)) {
    throw new Error(`TargetDescriptor has no usable selector: ${JSON.stringify(d)}`);
  }
  // Exact name/label/text matching + the recorded ordinal (see ./resolve-target.ts). An action on a
  // target goes through `resolveTarget`, which additionally refuses an ambiguous or missing element.
  return Target.named(targetName(d)).locatedBy((page: Page): Locator => descriptorLocator(page, d));
}

function targetName(d: TargetDescriptor): string {
  if (d.testId) return `testId=${d.testId}`;
  if (d.role && d.name) return `role=${d.role} name=${d.name}`;
  if (d.label) return `label=${d.label}`;
  if (d.text) return `text=${d.text}`;
  return `css=${d.css ?? "?"}`;
}
