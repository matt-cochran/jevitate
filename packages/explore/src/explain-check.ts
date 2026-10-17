import { describeNavigateUrl, type Assertion, type AssertionOperand, type TargetDescriptor } from "@jevitate/recording";
import type { SuccessCheck } from "./success-checks.js";

/** The longest a text/value is shown before it is cut (with a trailing `…`). */
const MAX_VALUE_CHARS = 80;

function cut(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value;
}

/** #565: an expected text or value — a literal quoted, a `{ var }` reference named (never a value). */
function shown(op: AssertionOperand): string {
  return typeof op === "string" ? `"${cut(op)}"` : `the value of ${op.var}`;
}

/**
 * Words a recorded selector in plain English for a human reviewer. Preference order: the
 * recorded display label (#497), then a role+name pair, then a bare name or label, then the
 * element's text, then a test id (its dashes/underscores become spaces), then a CSS selector.
 */
export function explainTarget(d: TargetDescriptor): string {
  // #497: the label a person saw, recorded as display metadata, reads best of all.
  if (d.display !== undefined) return d.display.role === undefined ? `"${d.display.name}"` : `the "${d.display.name}" ${d.display.role}`;
  if (d.role !== undefined && d.name !== undefined && d.name !== "") return `the "${d.name}" ${d.role}`;
  if (d.name !== undefined && d.name !== "") return `"${d.name}"`;
  if (d.label !== undefined && d.label !== "") return `"${d.label}"`;
  if (d.text !== undefined) return `the text "${cut(d.text)}"`;
  if (d.testId !== undefined) return d.testId.replace(/[-_]/g, " ");
  if (d.css !== undefined) return `the element ${d.css}`;
  return `the ${d.role ?? "element"}`;
}

function explainAssertion(a: Assertion): { text: string; weak: boolean } {
  switch (a.kind) {
    case "urlIncludes":
      return { text: `the URL contains "${cut(a.text)}"`, weak: false };
    case "visible":
      return { text: `${explainTarget(a.target)} is visible`, weak: false };
    case "textIncludes":
      return { text: `${explainTarget(a.target)} shows ${shown(a.text)}`, weak: false };
    case "count": {
      const target = explainTarget(a.target);
      if (a.max === undefined && (a.min === undefined || a.min === 0)) {
        return { text: `any number of ${target}, including none`, weak: true };
      }
      if (a.max === undefined) return { text: `at least ${a.min} ${target}`, weak: false };
      if (a.min === undefined) return { text: `at most ${a.max} ${target}`, weak: false };
      return { text: `between ${a.min} and ${a.max} ${target}`, weak: false };
    }
    case "valueEquals":
      return { text: `${explainTarget(a.target)} has ${typeof a.value === "string" ? "the value " : ""}${shown(a.value)}`, weak: false };
    case "attr": {
      const target = explainTarget(a.target);
      if (a.absent === true) return { text: `${target} has no ${a.name}`, weak: false };
      if (a.value === undefined) return { text: `${target} has ${a.name}`, weak: false };
      return { text: `${target} has ${a.name}=${shown(a.value)}`, weak: false };
    }
    case "style": {
      const channel = a.channel === undefined ? "" : ` (${a.channel})`;
      return { text: `${explainTarget(a.target)} has ${a.property}${channel} ${a.op} ${cut(a.value)}`, weak: false };
    }
    case "inViewport":
      return { text: `${explainTarget(a.target)} is on screen`, weak: false };
    case "box":
      return { text: `${explainTarget(a.target)} fits the size bounds`, weak: false };
    case "overlap":
      return {
        text: `${explainTarget(a.target)} ${a.overlapping ? "overlaps" : "does not overlap"} ${explainTarget(a.other)}`,
        weak: false,
      };
    case "flashed":
      return { text: `${explainTarget(a.target)} flashed after the action`, weak: false };
  }
}

/**
 * Words a Journey success check in plain English for a human reviewer. `weak` is true only when
 * the check can never fail: a `count` with no maximum and a minimum that is 0 or absent — also
 * when that count is the assertion of a `reloadThen`.
 */
export function explainCheck(c: SuccessCheck): { text: string; weak: boolean } {
  switch (c.kind) {
    case "page":
      return explainAssertion(c.assertion);
    case "reloadThen": {
      const inner = explainAssertion(c.assertion);
      return { text: `after a reload, ${inner.text}`, weak: inner.weak };
    }
    case "requestMade":
      return { text: `a ${c.method.toUpperCase()} request to ${c.pathGlob} is sent`, weak: false };
    case "responseStatus": {
      const status = "class" in c.status ? `${c.status.class}xx` : String(c.status.code);
      return { text: `${c.method.toUpperCase()} ${c.pathGlob} answers ${status}`, weak: false };
    }
    case "http": {
      const what = [
        ...(c.json ?? []).map((a) => (a.op === "exists" ? `${a.path} exists` : `${a.path} ${a.op === "equals" ? "equals" : "includes"} "${a.value ?? ""}"`)),
        ...(c.textIncludes ?? []).map((t) => `the body includes "${t}"`),
        ...(c.status === undefined ? [] : [`it answers ${"class" in c.status ? `${c.status.class}xx` : String(c.status.code)}`]),
      ];
      return { text: `GET ${describeNavigateUrl(c.url)}: ${what.join(", ")}`, weak: false };
    }
  }
}
