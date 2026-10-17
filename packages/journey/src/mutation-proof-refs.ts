import { PLACEHOLDER_RE, assertionRefs, encodeUrlParamValue, navigateUrlParams, type Assertion, type AssertionOperand, type Step } from "@jevitate/recording";
import type { Journey } from "./journey.js";
import type { JourneyAssertionSite } from "./assertions.js";
import { secretParamNames } from "./intent.js";

/**
 * #565 — the helpers `journey verify --mutate` uses to prove PARAMETER-RELATIVE checks (an
 * assertion operand that is `{ var }` or carries `${name}`). A param mutation replays the Journey
 * with one non-secret parameter's value altered where the app RECEIVES it (a fill, a navigate URL),
 * while every assertion that names it stays pinned to the value that was supplied — so a check that
 * cannot tell the supplied value from a swapped or truncated one is shown vacuous. A secret
 * parameter is never mutated (its value would land in a mutated copy and in the proof).
 */

/** Keys whose values are a step's own claims, not inputs to its action. */
const CLAIM_KEYS = new Set(["expect", "check", "resume", "waitFor"]);

/** The names a step's ACTION reads (a `{ var }` value, a `${name}` in a navigate URL), each once. */
export function actionRefs(step: Step): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.var === "string" && Object.keys(o).length === 1) {
      out.add(o.var);
      return;
    }
    if (o.kind === "navigate" && typeof o.url === "string") for (const n of navigateUrlParams(o.url)) out.add(n);
    for (const [k, x] of Object.entries(o)) if (!CLAIM_KEYS.has(k)) walk(x);
  };
  walk(step);
  return [...out];
}

/** A site's page assertion (a step's own claim, a `page`/`reloadThen` end-state check), else null. */
export function sitePageAssertion(site: JourneyAssertionSite): Assertion | null {
  if (site.where === "step") return site.check.assertion;
  if (site.where === "end-state" && (site.check.kind === "page" || site.check.kind === "reloadThen")) return site.check.assertion;
  return null;
}

/** The names a site's assertion refers to (`assertionRefs`). */
export function siteRefs(site: JourneyAssertionSite): string[] {
  const a = sitePageAssertion(site);
  return a === null ? [] : assertionRefs(a);
}

/**
 * A parameter a param mutation may alter: declared, not secret, supplied non-blank and without a
 * `${…}` of its own (a `${setup.x}` is bound at run time; a pinned literal must not expand).
 */
export function mutableParamValue(journey: Journey, name: string, params: Readonly<Record<string, string>>): string | null {
  const declared = new Set([...journey.metadata.params, ...(journey.metadata.parameters ?? []).map((p) => p.name)]);
  if (!declared.has(name) || secretParamNames(journey, params).includes(name)) return null;
  const v = params[name];
  if (v === undefined || v.trim() === "" || v.includes("${")) return null;
  return v;
}

type Shape = "email" | "number" | "text";
function shapeOf(v: string): Shape {
  if (/^[^\s@]+@[^\s@]+$/.test(v)) return "email";
  if (/^\d+$/.test(v)) return "number";
  return "text";
}

/** `v` with its last letter or digit changed (same length and shape); `v + "x"` when it has none. */
export function alteredValue(v: string): string {
  for (let i = v.length - 1; i >= 0; i -= 1) {
    const c = v[i]!;
    let r: string | null = null;
    if (c >= "0" && c <= "8") r = String.fromCharCode(c.charCodeAt(0) + 1);
    else if (c === "9") r = "0";
    else if ((c >= "a" && c <= "y") || (c >= "A" && c <= "Y")) r = String.fromCharCode(c.charCodeAt(0) + 1);
    else if (c === "z") r = "a";
    else if (c === "Z") r = "A";
    if (r !== null) return `${v.slice(0, i)}${r}${v.slice(i + 1)}`;
  }
  return `${v}x`;
}

/**
 * A swapped identifier for `name`: another supplied non-secret parameter of the same shape (an email
 * for an email) that neither contains nor equals the value — the record the app might wrongly show —
 * else a deterministic alteration (`alteredValue`). Never a secret's value.
 */
export function swappedValue(journey: Journey, name: string, params: Readonly<Record<string, string>>): string | null {
  const v = mutableParamValue(journey, name, params);
  if (v === null) return null;
  const secret = new Set(secretParamNames(journey, params));
  const other = Object.keys(params)
    .sort()
    .filter((k) => k !== name && !secret.has(k))
    .map((k) => params[k]!)
    .find((o) => o.trim() !== "" && o !== v && !o.includes(v) && !o.includes("${") && shapeOf(o) === shapeOf(v));
  return other ?? alteredValue(v);
}

/** The value with its tail dropped (the first half kept), or null when it is too short to truncate. */
export function truncatedValue(journey: Journey, name: string, params: Readonly<Record<string, string>>): string | null {
  const v = mutableParamValue(journey, name, params);
  if (v === null || v.length < 2) return null;
  return v.slice(0, Math.ceil(v.length / 2));
}

function pinOperand(op: AssertionOperand, name: string, value: string): AssertionOperand {
  if (typeof op !== "string") return op.var === name ? value : op;
  return op.replace(PLACEHOLDER_RE, (whole, n: string) => (n === name ? value : whole));
}

function pinAssertion(a: Assertion, name: string, value: string): Assertion {
  if (!assertionRefs(a).includes(name)) return a;
  switch (a.kind) {
    case "textIncludes":
      return { ...a, text: pinOperand(a.text, name, value) };
    case "valueEquals":
      return { ...a, value: pinOperand(a.value, name, value) };
    case "attr":
      return a.value === undefined ? a : { ...a, value: pinOperand(a.value, name, value) };
    case "urlIncludes": {
      const pinned = pinOperand(a.text, name, encodeUrlParamValue(value));
      return { ...a, text: typeof pinned === "string" ? pinned : a.text };
    }
    default:
      return a;
  }
}

function pinStep(step: Step, name: string, value: string): Step {
  if (step.kind === "assert") return { ...step, check: pinAssertion(step.check, name, value) };
  if (step.kind === "handback") return { ...step, resume: pinAssertion(step.resume, name, value) };
  if (step.kind === "forEach") return { ...step, steps: step.steps.map((s) => pinStep(s, name, value)) };
  return "expect" in step ? ({ ...step, expect: pinAssertion(step.expect, name, value) } as Step) : step;
}

/**
 * A copy of the Journey whose every assertion naming `name` expects exactly `value` (the supplied,
 * non-secret value) — so a replay with `name` altered still judges against what was supplied.
 */
export function pinAssertionRefs(journey: Journey, name: string, value: string): Journey {
  const copy = structuredClone(journey);
  for (const page of copy.recording.pages) for (const r of page.steps) r.step = pinStep(r.step, name, value);
  if (copy.metadata.endState !== undefined) {
    copy.metadata.endState = copy.metadata.endState.map((c) => (c.kind === "page" || c.kind === "reloadThen" ? { ...c, assertion: pinAssertion(c.assertion, name, value) } : c));
  }
  return copy;
}
