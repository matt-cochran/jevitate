import type { Assertion, NetworkCheck, RecordedStep, Recording, Step, StatusSpec, TargetDescriptor } from "@jevitate/recording";
import { writeClassifier, type WriteClassifier } from "@jevitate/recording";
import { isOwnTargetVisible } from "@jevitate/journey";
import { REDACTION_MASK } from "@jevitate/ai-core";
import { normalizeRoute } from "../adversarial/defect-fingerprint.js";
import { expectedResultFromDelta } from "../replay-deltas.js";

/**
 * #400 — a step's `expect` comes from what the step CHANGED, never from its own target. Reads what
 * the discovery take recorded beside each step (a measurement, never a guess):
 *
 *  - a WRITE it sent (a non-read request answered 2xx/3xx, from its action delta's requests or, when
 *    no delta was taken, its page timing) → `expectRequests: responseStatus:<METHOD> <path>=<class>`;
 *    id segments become `*` so the check holds for the next record the replay creates;
 *  - a `relevant-change` delta (#303) → `expect` on what it added or changed on the page: a named
 *    element (`visible role+name`) or the new text (`visible textContains`), skipping volatile
 *    (digit-bearing), redacted and summarised lines and the target's own name;
 *  - a fill of a constant value → `valueEquals` of that value (a parameter fill has no fixed value);
 *  - a navigation postcondition (`urlIncludes`, set by the recorder) is kept as is.
 *
 * A click/type/select step left with nothing to claim gets the explicit "no claim" `count … min 0`
 * (always true; the lint #401 reads it as "no assertion here") — never `visible` of its own target,
 * which holds before and after the action and so proves nothing.
 *
 * #400: when the step has a delta, its blank `expectedResult` (RecordedStep, #246) is filled from
 * `expectedResultFromDelta` so the reviewer sees, in words, what the step is supposed to prove.
 */
export function deriveStepExpectations(recording: Recording, opts: { readonly readRequests?: readonly string[] } = {}): Recording {
  const isWrite = writeClassifier(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests });
  return {
    ...recording,
    pages: recording.pages.map((page) => ({ ...page, steps: page.steps.map((r) => deriveOne(r, isWrite)) })),
  };
}

function deriveOne(recorded: RecordedStep, isWrite: WriteClassifier): RecordedStep {
  const writes = writeChecks(recorded, isWrite);
  const step = withDerivedExpect(recorded);
  const expectedResult = derivedExpectedResult(recorded);
  return {
    ...recorded,
    step,
    ...(expectedResult === undefined ? {} : { expectedResult }),
    ...(writes.length === 0 ? {} : { expectRequests: mergeChecks(recorded.expectRequests ?? [], writes) }),
  };
}

/** #400: the prose `expectedResult` code drafts from a step's delta, when it has none yet. */
function derivedExpectedResult(recorded: RecordedStep): string | undefined {
  if (recorded.delta === undefined) return undefined;
  const existing = recorded.expectedResult;
  if (existing !== undefined && existing.trim() !== "") return undefined;
  const draft = expectedResultFromDelta(recorded.delta);
  return draft === null || draft.trim() === "" ? undefined : draft;
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────────

/** `POST /api/items → 201` (an action delta's request line). */
const DELTA_REQUEST = /^([A-Z]+) (\S+) → (\S+)$/;

function writeChecks(recorded: RecordedStep, isWrite: WriteClassifier): NetworkCheck[] {
  const seen: Array<{ method: string; path: string; status: number | null }> = [];
  const lines = recorded.delta?.requests;
  if (lines !== undefined) {
    for (const line of lines) {
      const m = DELTA_REQUEST.exec(line);
      if (m === null) continue;
      const status = /^\d{3}$/.test(m[3]!) ? Number(m[3]) : null;
      seen.push({ method: m[1]!, path: m[2]!, status });
    }
  } else {
    for (const q of recorded.timing?.page?.requests.slowest ?? []) {
      const sp = q.endpoint.indexOf(" ");
      if (sp <= 0) continue;
      seen.push({ method: q.endpoint.slice(0, sp), path: pathOf(q.url), status: q.status });
    }
  }
  const out: NetworkCheck[] = [];
  for (const r of seen) {
    if (r.status === null || r.status < 200 || r.status >= 400) continue;
    if (!isWrite({ method: r.method, path: r.path })) continue;
    if (r.path.includes(REDACTION_MASK)) continue;
    const pathGlob = normalizeRoute(r.path).replace(/:id\b/g, "*");
    out.push({ kind: "responseStatus", method: r.method.toUpperCase(), pathGlob, status: { class: Math.floor(r.status / 100) as 2 | 3 } satisfies StatusSpec });
  }
  return mergeChecks([], out);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function mergeChecks(a: readonly NetworkCheck[], b: readonly NetworkCheck[]): NetworkCheck[] {
  const out: NetworkCheck[] = [];
  const keys = new Set<string>();
  for (const c of [...a, ...b]) {
    const k = JSON.stringify(c);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(c);
  }
  return out;
}

// ── Page expectation ────────────────────────────────────────────────────────────────────────────

function noClaim(target: TargetDescriptor): Assertion {
  return { kind: "count", target: { ...target }, min: 0 };
}

function withDerivedExpect(recorded: RecordedStep): Step {
  const step = recorded.step;
  if (!("expect" in step) || !("target" in step)) return step;
  // The recorder already replaced a provisional postcondition with what held (a navigation).
  if (step.expect.kind === "urlIncludes" && step.expect.text !== "") return step;
  const derived = step.kind === "fill" ? fillExpect(step) : recorded.delta?.verdict === "relevant-change" ? fromDelta(recorded.delta.changes, step.target) : null;
  if (derived !== null) return { ...step, expect: derived };
  return isOwnTargetVisible(step) ? { ...step, expect: noClaim(step.target) } : step;
}

function fillExpect(step: Extract<Step, { kind: "fill" }>): Assertion | null {
  const v = step.value;
  if ("var" in v || v.redacted) return null;
  return { kind: "valueEquals", target: { ...step.target }, value: v.value };
}

/** An aria-snapshot line: `role "name" [attrs]: text` (name, attrs and text each optional). */
const ARIA_LINE = /^([a-z][a-z-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::\s*(.*))?$/;
/** Roles that never identify what an action produced on their own. */
const GENERIC_ROLES = new Set(["generic", "none", "presentation", "group", "list", "listitem", "row", "cell", "img"]);
/** Form controls: a change of their value is the typed input, not an outcome. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "checkbox", "radio", "switch", "option"]);

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Text worth asserting: present, bounded, no digits (a count, a time, an id is volatile), unredacted. */
function usable(text: string | undefined): text is string {
  if (text === undefined) return false;
  const t = text.trim();
  return t.length >= 2 && t.length <= 120 && !/\d/.test(t) && !t.includes(REDACTION_MASK) && !t.includes("…");
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/** The first change line (closest to the action first, as the delta lists them) that names an outcome. */
function fromDelta(changes: readonly string[], own: TargetDescriptor): Assertion | null {
  for (const line of changes) {
    const a = changeAssertion(line, own);
    if (a !== null) return a;
  }
  return null;
}

function changeAssertion(line: string, own: TargetDescriptor): Assertion | null {
  const ownName = own.name ?? own.text ?? own.label;
  const textCheck = (t: string): Assertion | null =>
    usable(t) && !sameName(t, ownName) ? { kind: "visible", target: { text: t.trim(), textMatch: "contains" } } : null;
  if (line.startsWith("+ ")) {
    const m = ARIA_LINE.exec(line.slice(2).trim());
    if (m === null) return null;
    const [, role, rawName, , rawText] = m;
    if (role === undefined || VALUE_ROLES.has(role)) return null;
    const name = rawName === undefined ? undefined : unquote(`"${rawName}"`);
    if (name !== undefined && !GENERIC_ROLES.has(role) && role !== "text" && usable(name) && !sameName(name, ownName)) {
      return { kind: "visible", target: { role, name } };
    }
    return rawText === undefined ? null : textCheck(unquote(rawText));
  }
  if (line.startsWith("~ ")) {
    const body = line.slice(2);
    const arrow = body.lastIndexOf(" → ");
    const colon = body.indexOf(": ");
    if (arrow < 0 || colon < 0 || colon > arrow) return null;
    const head = ARIA_LINE.exec(body.slice(0, colon).trim());
    if (head === null || head[1] === undefined || VALUE_ROLES.has(head[1])) return null;
    return textCheck(unquote(body.slice(arrow + 3)));
  }
  return null;
}
