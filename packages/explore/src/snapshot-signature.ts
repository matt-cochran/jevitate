import type { ControlFacts } from "./snapshot-browser.js";
import { contentHash } from "@jevitate/domain";
import { redactText } from "./redact.js";
import { TEMPORAL_FORMATS, isTemporalInputType } from "./temporal-value.js";

/** Facts plus the value, which is present only for a non-secret value-bearing control. */
export interface DescribedFacts extends ControlFacts {
  readonly value: string | null;
}

export function summarize(facts: DescribedFacts): string {
  const head = facts.name !== "" ? `${facts.role || facts.tag} "${facts.name}"` : facts.role || facts.tag;
  const bits: string[] = [];
  if (!facts.enabled) bits.push("disabled");
  if (facts.checked === true) bits.push("checked");
  if (facts.checked === false) bits.push("unchecked");
  if (facts.expanded === true) bits.push("expanded");
  if (facts.expanded === false) bits.push("collapsed");
  if (facts.value !== null && facts.value !== "") bits.push(`value="${facts.value}"`);
  if (facts.richText) bits.push("rich text");
  // #332: a date/time input takes only its wire format — say which, so the model types `08:00`, not `8:00 AM`.
  if (facts.tag === "input" && isTemporalInputType(facts.inputType)) bits.push(`format ${TEMPORAL_FORMATS[facts.inputType!.toLowerCase()]!.split(" ")[0]}`);
  if (facts.accept !== null && facts.accept !== "") bits.push(`accept=${facts.accept}`);
  if (facts.selected !== null && facts.selected !== "") bits.push(`selected="${facts.selected}"`);
  if (facts.options !== null && facts.options.length > 0) {
    const shown = facts.options.slice(0, 12).map((o) => `"${o}"`).join(" | ");
    bits.push(`options: ${shown}${facts.options.length > 12 ? ` | …${facts.options.length - 12} more` : ""}`);
  }
  return bits.length > 0 ? `${head} (${bits.join(", ")})` : head;
}

/**
 * The semantic freshness signature: a hash of the full URL, the viewport, and
 * each control's safe state (role/name/tag/enabled/checked/value). Same page
 * state ⇒ same signature; a navigation, a newly-revealed control, or a value
 * change ⇒ a different one. This is state-derived, NOT DOM-mutation counting.
 */
export function computeSignature(
  url: string,
  viewport: { width: number; height: number } | null,
  facts: readonly DescribedFacts[],
): string {
  return contentHash({
    url,
    viewport,
    controls: facts.map((f) => ({
      tag: f.tag,
      role: f.role,
      name: f.name,
      enabled: f.enabled,
      checked: f.checked,
      value: f.value,
      selected: f.selected,
      ...(f.expanded === null ? {} : { expanded: f.expanded }),
    })),
  });
}

/**
 * The bounded fields, masked first and then cut, here and not in the page: a cut made before the mask
 * leaves the start of a secret that crosses it, which no value match can find.
 */
export function boundFacts(f: ControlFacts, secrets: readonly string[]): ControlFacts {
  const r = (s: string): string => redactText(s, secrets);
  const quoted = f.scope === null ? null : /^([^"]*) "(.*)"$/s.exec(r(f.scope));
  return {
    ...f,
    options: f.options === null ? null : f.options.map((o) => r(o).slice(0, 200)),
    selected: f.selected === null ? null : r(f.selected),
    heading: f.heading === null ? null : r(f.heading).slice(0, 120),
    scope: f.scope === null ? null : quoted === null ? r(f.scope) : `${quoted[1]} "${(quoted[2] ?? "").slice(0, 60)}"`,
  };
}
