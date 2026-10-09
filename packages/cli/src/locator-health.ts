import type { Recording, RecordedStep, Step, TargetDescriptor } from "@jevitate/recording";
import { looksGenerated } from "@jevitate/recorder";
import type { LocatorHealth, LocatorHealthStep, LocatorRung } from "./check-types.js";

/**
 * #470 — locator health, the pure core: for every step that acts on a target, the selector rung it
 * resolves by, how robust that rung is, WHY it is brittle, and the fix for the app under test. A step
 * is `stable` only when it resolves by a test id from the team's convention (`testIdAttributes`;
 * `data-tflow-id` never counts, #468) that does not look generated; anything else is `brittle` and
 * gets a suggestion — a work list for the codebase, de-duplicated by element.
 *
 * Static (a Journey's recorded descriptors) or dynamic (a run's `resolved` — the rung that actually
 * matched at replay, `@jevitate/interpreter` `StepResolution`). No I/O: `locator-health-api.ts` loads
 * Journeys, results and config; check/report/the review sheet call these helpers.
 */

/** The ladder's own grade for a rung (the recorder's `Stability`): how likely it is to survive change. */
export type LocatorLevel = "high" | "medium" | "low";

/** Why a step's locator is brittle — the stable vocabulary (machine-readable `code`, human `text`). */
export type BrittleReasonCode =
  | "no-test-id"
  | "test-id-not-in-convention"
  | "tflow-id-not-a-test-id"
  | "generated-value"
  | "no-accessible-name"
  | "duplicate-name"
  | "positional-css"
  | "text-copy";

/** A run's resolution of one step (structurally `@jevitate/interpreter` `StepResolution`). */
export interface ResolvedStepInput {
  readonly index: number;
  readonly stepId?: string;
  readonly rung: string;
  readonly testIdAttr?: string;
  readonly ordinal?: number;
  readonly candidates?: number;
}

/** One step's verdict, in detail (a `LocatorHealthStep`, plus what the reports and the review sheet show). */
export interface LocatorHealthStepDetail extends LocatorHealthStep {
  readonly kind: Step["kind"];
  /** The ladder grade of the rung used. */
  readonly level: LocatorLevel;
  /** `recorded`: from the Journey's descriptor; `resolved`: the rung that matched at replay. */
  readonly source: "recorded" | "resolved";
  /** The route (path) of the page the step acts on, when known. */
  readonly route?: string;
  /** How the step finds its target, e.g. `role=button name="Save"`, `css=main > div:nth-of-type(2)`. */
  readonly locator: string;
  readonly reasonCodes: readonly BrittleReasonCode[];
  /** The key of this step's suggestion (`LocatorSuggestion.key`); absent when stable. */
  readonly suggestion?: string;
}

/** Where a brittle element is used. */
export interface LocatorOccurrence {
  readonly journeyId?: string;
  readonly index: number;
  readonly stepId?: string;
}

/** One actionable fix for the app, per element (route + role + name), however many steps use it. */
export interface LocatorSuggestion {
  /** The de-duplication key: `route|role|name` (or `route|css|selector` for an unnamed element). */
  readonly key: string;
  readonly route?: string;
  readonly role?: string;
  readonly name?: string;
  /** The element in words, e.g. `the "Save" button`. */
  readonly element: string;
  /** A short outerHTML excerpt, when the caller had one (a live page); never a field's value. */
  readonly html?: string;
  /** The attribute the fix adds (the convention's first). */
  readonly attribute: string;
  /** The suggested test id (kebab-case, from the name and route). */
  readonly testId: string;
  /** The fix, e.g. `add data-testid="save-contact" to the "Save" button on /contacts/new`. */
  readonly fix: string;
  readonly reasons: readonly string[];
  readonly occurrences: readonly LocatorOccurrence[];
}

export interface LocatorLevels {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

/** A Journey's (or a run's) locator health in detail — a `LocatorHealth` with the levels, line and fixes. */
export interface LocatorHealthDetail extends LocatorHealth {
  readonly steps: readonly LocatorHealthStepDetail[];
  readonly levels: LocatorLevels;
  /** e.g. `7/9 steps on stable locators; 2 brittle (high 7 · medium 1 · low 1)`. */
  readonly line: string;
  readonly suggestions: readonly LocatorSuggestion[];
}

export interface AnalyzeOptions {
  /** The team's test-id convention (project config `testIdAttributes`). */
  readonly testIdAttributes: readonly string[];
  /** Tags each suggestion's occurrences (a multi-Journey report). */
  readonly journeyId?: string;
  /** A run's resolutions: the rung that actually matched, per step (overrides the recorded rung). */
  readonly resolved?: readonly ResolvedStepInput[];
  /** Short outerHTML excerpts by flat step index, when the caller had a live page. */
  readonly html?: ReadonlyMap<number, string>;
}

// === Classification ===

const LEVEL_RANK: Readonly<Record<LocatorLevel, number>> = { low: 0, medium: 1, high: 2 };
/** One notch down: a rung that only resolves with an ordinal (the recorder's `CAPPED_STABILITY`). */
const CAPPED: Readonly<Record<LocatorLevel, LocatorLevel>> = { high: "medium", medium: "low", low: "low" };

const REASON_TEXT: Readonly<Record<BrittleReasonCode, string>> = {
  "no-test-id": "no test id",
  "test-id-not-in-convention": "test id attribute is not in the convention",
  "tflow-id-not-a-test-id": "data-tflow-id is tracking metadata, not a test id",
  "generated-value": "generated-looking id or name",
  "no-accessible-name": "no accessible name",
  "duplicate-name": "duplicate name needs disambiguation (nth)",
  "positional-css": "deep or positional css path",
  "text-copy": "text locator on copy likely to change",
};

/** The target a step acts on, or null (navigate, press, assert, a forEach's items are its own). */
export function stepTarget(step: Step): TargetDescriptor | null {
  switch (step.kind) {
    case "click":
    case "fill":
    case "waitFor":
    case "extract":
    case "select":
    case "upload":
    case "editText":
      return step.target;
    default:
      return null;
  }
}

/** The recorded rung replay tries (an anchor first, as `resolveTarget` does). */
function recordedRung(d: TargetDescriptor): LocatorRung {
  if (d.anchor !== undefined && d.testId === undefined && (d.anchor.id !== undefined || d.anchor.name !== undefined)) return "anchor";
  return ownRung(d);
}

function ownRung(d: TargetDescriptor): LocatorRung {
  if (d.testId) return "testId";
  if (d.role && d.name) return "role+name";
  if (d.label) return "label";
  if (d.text) return "text";
  if (d.css) return "css";
  return d.role ? "role" : "css";
}

function asRung(r: string): LocatorRung {
  return (["testId", "anchor", "role+name", "role", "label", "text", "css"] as const).find((x) => x === r) ?? "css";
}

/** How deep a css path is, and whether it is positional. */
function cssShape(css: string): { depth: number; positional: boolean } {
  return { depth: css.split(">").length, positional: /:nth-(of-type|child)\(|:first-|:last-/.test(css) };
}

function describeLocator(d: TargetDescriptor, rung: LocatorRung): string {
  const nth = d.ordinal === undefined ? "" : ` nth=${d.ordinal}`;
  switch (rung) {
    case "testId":
      return `testId[${d.testIdAttr ?? "data-testid"}]=${d.testId ?? "?"}`;
    case "anchor":
      return d.anchor?.id !== undefined ? `[id=${JSON.stringify(d.anchor.id)}]` : `[name=${JSON.stringify(d.anchor?.name ?? "")}]`;
    case "role+name":
      return `role=${d.role ?? "?"} name=${JSON.stringify(d.name ?? "")}${nth}`;
    case "label":
      return `label=${JSON.stringify(d.label ?? "")}${nth}`;
    case "text":
      return `text=${JSON.stringify(d.text ?? "")}${nth}`;
    default:
      return `css=${d.css ?? "?"}`;
  }
}

interface Verdict {
  readonly rung: LocatorRung;
  readonly level: LocatorLevel;
  readonly codes: BrittleReasonCode[];
}

/**
 * One target's verdict against the convention. `via` (a run's resolution) replaces the recorded rung
 * when present; everything else is read from the descriptor.
 */
export function classifyTarget(d: TargetDescriptor, testIdAttributes: readonly string[], via?: ResolvedStepInput): Verdict {
  const rung = via === undefined ? recordedRung(d) : asRung(via.rung);
  const ordinal = via === undefined ? d.ordinal : via.ordinal;
  const codes: BrittleReasonCode[] = [];
  let level: LocatorLevel;
  switch (rung) {
    case "testId": {
      const attr = (via?.testIdAttr ?? d.testIdAttr ?? "data-testid").toLowerCase();
      const generated = looksGenerated(d.testId ?? "");
      level = generated ? "low" : "high";
      if (attr === "data-tflow-id") codes.push("tflow-id-not-a-test-id");
      else if (!testIdAttributes.includes(attr)) codes.push("test-id-not-in-convention");
      if (generated) codes.push("generated-value");
      break;
    }
    case "anchor":
      // A non-generated id/name attribute (the recorder refuses generated ones): sturdy, but not the convention.
      level = "medium";
      codes.push("no-test-id");
      break;
    case "role+name":
      level = looksGenerated(d.name ?? "") ? "low" : "high";
      codes.push("no-test-id");
      if (level === "low") codes.push("generated-value");
      break;
    case "label":
      level = "medium";
      codes.push("no-test-id");
      break;
    case "text":
      level = "medium";
      codes.push("no-test-id", "text-copy");
      break;
    default: {
      level = "low";
      codes.push("no-test-id");
      const shape = cssShape(d.css ?? "");
      if (shape.positional || shape.depth > 3) codes.push("positional-css");
      if (/#[A-Za-z0-9_-]*\d{4}|[0-9a-fA-F]{8}/.test(d.css ?? "")) codes.push("generated-value");
    }
  }
  if (ordinal !== undefined && rung !== "testId" && rung !== "anchor" && rung !== "css") {
    level = CAPPED[level];
    codes.push("duplicate-name");
  }
  if (rung !== "testId" && !(d.name || d.label)) codes.push("no-accessible-name");
  if (d.tflowId !== undefined && rung !== "testId" && !codes.includes("tflow-id-not-a-test-id")) codes.push("tflow-id-not-a-test-id");
  return { rung, level, codes };
}

// === Suggestions ===

/** `"Save contact"` → `save-contact` (ASCII letters and digits, at most 40 chars). */
export function kebabCase(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** The path of a page URL (`https://x/contacts/new?a=1` → `/contacts/new`); a path is kept as is. */
export function routeOf(url: string | undefined): string | undefined {
  if (url === undefined || url === "") return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    const path = url.split(/[?#]/)[0] ?? url;
    return path.startsWith("/") ? path : `/${path}`;
  }
}

function singular(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/(ss|us)$/.test(word)) return word;
  return word.replace(/s$/, "");
}

/** The route's first meaningful segment (not an id or a verb like `new`/`edit`), singular. */
function routeWords(route: string | undefined): string[] {
  return (route ?? "").split("/").filter((s) => s !== "" && !/^\d+$/.test(s) && !looksGenerated(s) && !/^(new|edit|create|index|view)$/i.test(s));
}

function routeNoun(route: string | undefined): string | undefined {
  const first = routeWords(route)[0];
  return first === undefined ? undefined : singular(kebabCase(first));
}

/**
 * The suggested test id: the element's name in kebab-case, with the route's noun when the name is a
 * single word (`Save` on /contacts/new → `save-contact`); an unnamed element is named by its route
 * and tag (`contacts-div`).
 */
export function suggestTestId(name: string | undefined, route: string | undefined, fallbackTag: string): string {
  const base = name === undefined ? "" : kebabCase(name);
  const noun = routeNoun(route);
  if (base !== "") return !base.includes("-") && noun !== undefined && !base.includes(noun) ? `${base}-${noun}` : base;
  const where = kebabCase(routeWords(route).join("-"));
  return `${where === "" ? "page" : where}-${fallbackTag}`;
}

function lastCssTag(css: string | undefined): string {
  const last = (css ?? "").split(">").pop()?.trim() ?? "";
  return /^([a-z][a-z0-9-]*)/i.exec(last)?.[1]?.toLowerCase() ?? "element";
}

function describeElement(d: TargetDescriptor): string {
  const name = d.name ?? d.label;
  if (d.role && name) return `the ${JSON.stringify(name)} ${d.role}`;
  if (d.label) return `the ${JSON.stringify(d.label)} field`;
  if (d.role) return `the ${d.role}`;
  if (d.text) return `the element with text ${JSON.stringify(d.text.length > 40 ? `${d.text.slice(0, 40)}…` : d.text)}`;
  if (d.testId) return `the element with ${d.testIdAttr ?? "data-testid"}=${JSON.stringify(d.testId)}`;
  return `the element at css ${JSON.stringify(d.css ?? "?")}`;
}

/** The element's identity across steps and runs: route + role + name (else its css). */
export function suggestionKey(d: TargetDescriptor, route: string | undefined): string {
  const name = d.name ?? d.label ?? d.text;
  if (name !== undefined) return `${route ?? ""}|${d.role ?? ""}|${name}`;
  if (d.testId !== undefined) return `${route ?? ""}|testid|${d.testId}`;
  return `${route ?? ""}|css|${d.css ?? ""}`;
}

function fixFor(d: TargetDescriptor, codes: readonly BrittleReasonCode[], attribute: string, testId: string, element: string, route: string | undefined): string {
  const on = route === undefined ? "" : ` on ${route}`;
  const named = codes.includes("no-accessible-name") ? " and give it an accessible name (visible text or aria-label)" : "";
  if (codes.includes("test-id-not-in-convention") && d.testId !== undefined && !looksGenerated(d.testId)) {
    return `use ${attribute}=${JSON.stringify(d.testId)} instead of ${d.testIdAttr ?? "?"} on ${element}${on} (or add ${d.testIdAttr ?? "?"} to testIdAttributes in .jevitate/config.json)`;
  }
  if (d.testId !== undefined && looksGenerated(d.testId)) {
    return `replace the generated ${d.testIdAttr ?? attribute}=${JSON.stringify(d.testId)} on ${element}${on} with a stable ${attribute}=${JSON.stringify(testId)}`;
  }
  return `add ${attribute}=${JSON.stringify(testId)} to ${element}${on}${named}`;
}

function buildSuggestion(d: TargetDescriptor, codes: readonly BrittleReasonCode[], route: string | undefined, attribute: string, html: string | undefined, occurrence: LocatorOccurrence): LocatorSuggestion {
  const name = d.name ?? d.label ?? d.text;
  const testId = suggestTestId(d.testId !== undefined && !looksGenerated(d.testId) ? d.testId : name, route, lastCssTag(d.css));
  const element = describeElement(d);
  return {
    key: suggestionKey(d, route),
    ...(route === undefined ? {} : { route }),
    ...(d.role === undefined ? {} : { role: d.role }),
    ...(name === undefined ? {} : { name }),
    element,
    ...(html === undefined ? {} : { html: html.length > 160 ? `${html.slice(0, 160)}…` : html }),
    attribute,
    testId,
    fix: fixFor(d, codes, attribute, testId, element, route),
    reasons: codes.map((c) => REASON_TEXT[c]),
    occurrences: [occurrence],
  };
}

/** Merges suggestions for the same element (route + role + name): occurrences and reasons combined. */
export function dedupeSuggestions(lists: ReadonlyArray<readonly LocatorSuggestion[]>): LocatorSuggestion[] {
  const byKey = new Map<string, LocatorSuggestion>();
  for (const s of lists.flat()) {
    const prev = byKey.get(s.key);
    if (prev === undefined) {
      byKey.set(s.key, s);
      continue;
    }
    const occ = [...prev.occurrences];
    for (const o of s.occurrences) {
      if (!occ.some((p) => p.journeyId === o.journeyId && p.index === o.index && p.stepId === o.stepId)) occ.push(o);
    }
    byKey.set(s.key, {
      ...prev,
      ...(prev.html === undefined && s.html !== undefined ? { html: s.html } : {}),
      reasons: [...new Set([...prev.reasons, ...s.reasons])],
      occurrences: occ,
    });
  }
  // The elements most steps depend on first: the highest-value fixes lead the work list.
  return [...byKey.values()].sort((a, b) => b.occurrences.length - a.occurrences.length || a.key.localeCompare(b.key));
}

// === Analysis ===

function flatWithRoute(rec: Recording): Array<{ recorded: RecordedStep; route: string | undefined }> {
  return rec.pages.flatMap((p) => p.steps.map((recorded) => ({ recorded, route: routeOf(p.url) })));
}

export function emptyLevels(): LocatorLevels {
  return { high: 0, medium: 0, low: 0 };
}

/** `7/9 steps on stable locators; 2 brittle (high 7 · medium 1 · low 1)`. */
export function healthLine(h: { readonly stable: number; readonly brittle: number; readonly levels: LocatorLevels }): string {
  const total = h.stable + h.brittle;
  if (total === 0) return "no steps act on a target";
  return `${h.stable}/${total} steps on stable locators; ${h.brittle} brittle (high ${h.levels.high} · medium ${h.levels.medium} · low ${h.levels.low})`;
}

/**
 * A recording's locator health: every step with a target (flat index, as the interpreter numbers
 * them), against the convention; with `resolved`, the rung each step actually matched at replay.
 */
export function analyzeRecording(rec: Recording, opts: AnalyzeOptions): LocatorHealthDetail {
  const attribute = opts.testIdAttributes[0] ?? "data-testid";
  const resolvedBy = new Map((opts.resolved ?? []).map((r) => [r.index, r]));
  const steps: LocatorHealthStepDetail[] = [];
  const suggestions: LocatorSuggestion[] = [];
  const levels = { high: 0, medium: 0, low: 0 };
  flatWithRoute(rec).forEach(({ recorded, route }, index) => {
    const d = stepTarget(recorded.step);
    if (d === null) return;
    const via = resolvedBy.get(index);
    const v = classifyTarget(d, opts.testIdAttributes, via);
    const brittle = v.codes.length > 0;
    levels[v.level] += 1;
    const stepId = recorded.stepId ?? via?.stepId;
    let key: string | undefined;
    if (brittle) {
      const occurrence: LocatorOccurrence = { ...(opts.journeyId === undefined ? {} : { journeyId: opts.journeyId }), index, ...(stepId === undefined ? {} : { stepId }) };
      const s = buildSuggestion(d, v.codes, route, attribute, opts.html?.get(index), occurrence);
      suggestions.push(s);
      key = s.key;
    }
    steps.push({
      ...(stepId === undefined ? {} : { stepId }),
      index,
      kind: recorded.step.kind,
      rung: v.rung,
      level: v.level,
      stability: brittle ? "brittle" : "stable",
      source: via === undefined ? "recorded" : "resolved",
      ...(route === undefined ? {} : { route }),
      locator: describeLocator(d, v.rung),
      reasons: v.codes.map((c) => REASON_TEXT[c]),
      reasonCodes: v.codes,
      ...(key === undefined ? {} : { suggestion: key }),
    });
  });
  const stable = steps.filter((s) => s.stability === "stable").length;
  const brittle = steps.length - stable;
  return { stable, brittle, steps, levels, line: healthLine({ stable, brittle, levels }), suggestions: dedupeSuggestions([suggestions]) };
}

/** Totals over several healths (a report, a check): counts, levels and the de-duplicated work list. */
export function combineHealth(healths: readonly LocatorHealthDetail[]): { stable: number; brittle: number; levels: LocatorLevels; line: string; suggestions: LocatorSuggestion[] } {
  const levels = { high: 0, medium: 0, low: 0 };
  let stable = 0;
  let brittle = 0;
  for (const h of healths) {
    stable += h.stable;
    brittle += h.brittle;
    levels.high += h.levels.high;
    levels.medium += h.levels.medium;
    levels.low += h.levels.low;
  }
  return { stable, brittle, levels, line: healthLine({ stable, brittle, levels }), suggestions: dedupeSuggestions(healths.map((h) => h.suggestions)) };
}

// === Gate ===

/** `check --max-brittle-steps <n>`: true when a Journey item's brittle steps exceed the opt-in threshold. */
export function exceedsBrittleSteps(health: Pick<LocatorHealth, "brittle">, maxBrittleSteps: number | undefined): boolean {
  return maxBrittleSteps !== undefined && health.brittle > maxBrittleSteps;
}

// === Trend ===

export interface LocatorTrendStep {
  /** `stepId`, else `#<index>`. */
  readonly key: string;
  readonly from: { readonly rung: LocatorRung; readonly level: LocatorLevel; readonly stability: "stable" | "brittle" };
  readonly to: { readonly rung: LocatorRung; readonly level: LocatorLevel; readonly stability: "stable" | "brittle" };
}

/** Against a baseline: steps whose locator improved / regressed (stability first, then level). */
export interface LocatorHealthTrend {
  readonly improved: number;
  readonly regressed: number;
  readonly unchanged: number;
  /** Steps only in the current (added) or only in the baseline (removed). */
  readonly added: number;
  readonly removed: number;
  readonly brittleDelta: number;
  readonly changes: readonly (LocatorTrendStep & { readonly direction: "improved" | "regressed" })[];
}

type TrendInputStep = Pick<LocatorHealthStep, "stepId" | "index" | "rung" | "stability"> & { readonly level?: LocatorLevel };

function stepKey(s: Pick<LocatorHealthStep, "stepId" | "index">): string {
  return s.stepId ?? `#${s.index}`;
}

function score(s: TrendInputStep): number {
  return (s.stability === "stable" ? 10 : 0) + LEVEL_RANK[s.level ?? (s.stability === "stable" ? "high" : "low")];
}

/**
 * The trend of `current` against `baseline` (a previous report or run of the same Journey), keyed by
 * step id (else index): a Journey re-recorded or healed after the app added test ids shows its
 * improvement; a step that fell back to a brittle rung shows as a regression.
 */
export function compareLocatorHealth(current: { readonly brittle: number; readonly steps: readonly TrendInputStep[] }, baseline: { readonly brittle: number; readonly steps: readonly TrendInputStep[] }): LocatorHealthTrend {
  const before = new Map(baseline.steps.map((s) => [stepKey(s), s]));
  const seen = new Set<string>();
  const changes: Array<LocatorTrendStep & { direction: "improved" | "regressed" }> = [];
  let unchanged = 0;
  let added = 0;
  const shape = (s: TrendInputStep) => ({ rung: s.rung, level: s.level ?? (s.stability === "stable" ? "high" : "low"), stability: s.stability }) as const;
  for (const s of current.steps) {
    const key = stepKey(s);
    seen.add(key);
    const b = before.get(key);
    if (b === undefined) {
      added++;
      continue;
    }
    const delta = score(s) - score(b);
    if (delta === 0) unchanged++;
    else changes.push({ key, from: shape(b), to: shape(s), direction: delta > 0 ? "improved" : "regressed" });
  }
  const removed = [...before.keys()].filter((k) => !seen.has(k)).length;
  return {
    improved: changes.filter((c) => c.direction === "improved").length,
    regressed: changes.filter((c) => c.direction === "regressed").length,
    unchanged,
    added,
    removed,
    brittleDelta: current.brittle - baseline.brittle,
    changes,
  };
}

/** `trend vs baseline: 2 improved, 1 regressed (brittle -1)`. */
export function trendLine(t: LocatorHealthTrend): string {
  const sign = t.brittleDelta > 0 ? `+${t.brittleDelta}` : String(t.brittleDelta);
  return `trend vs baseline: ${t.improved} improved, ${t.regressed} regressed (brittle ${sign})`;
}

// === Compact form (result.json, report, check.json) ===

/** What a run's result.json / a check item carries: counts, the line, levels, per-step verdicts, top fixes. */
export interface CompactLocatorHealth extends LocatorHealth {
  readonly levels: LocatorLevels;
  readonly line: string;
  readonly steps: readonly LocatorHealthStep[];
  readonly suggestions: ReadonlyArray<Pick<LocatorSuggestion, "key" | "element" | "fix" | "reasons"> & { readonly route?: string; readonly steps: number }>;
}

/** The compact form of a detail: per-step rung/stability/reasons, and the top `top` fixes. */
export function compactHealth(h: Pick<LocatorHealthDetail, "stable" | "brittle" | "steps" | "levels" | "line" | "suggestions">, top = 5): CompactLocatorHealth {
  return {
    stable: h.stable,
    brittle: h.brittle,
    levels: h.levels,
    line: h.line,
    steps: h.steps.map((s) => ({
      ...(s.stepId === undefined ? {} : { stepId: s.stepId }),
      index: s.index,
      rung: s.rung,
      stability: s.stability,
      reasons: s.reasons,
      ...("level" in s ? { level: s.level } : {}),
    })),
    suggestions: h.suggestions.slice(0, top).map((s) => ({
      key: s.key,
      element: s.element,
      fix: s.fix,
      reasons: s.reasons,
      ...(s.route === undefined ? {} : { route: s.route }),
      steps: s.occurrences.length,
    })),
  };
}
