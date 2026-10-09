import type { Step, TargetDescriptor } from "@jevitate/recording";
import type { ChangeEvidence, ChangeEvidenceKind, ChangeScope } from "./change-scope.js";

/**
 * #453: does the change scope EXPLAIN a broken step? Pure and deterministic — no model decides it
 * (Jev may only rank candidates, advisory). A break is explained when some anchor value on the step
 * (its target's testId / name / label / text, a css `#id`/`.class` token, the same on a `container`,
 * or a navigate URL's path) equals an evidence `before` — whole string, case-insensitive,
 * whitespace-normalised — of a compatible kind, or a free-text change note mentions it literally.
 * Each matching evidence with an `after` yields a deterministic retarget candidate: the step with
 * that one field set to `after`, everything else (its proof) untouched. `inserted-ui` evidence is
 * reported, never healed (0.9.0), so it never explains a break.
 */

/** One deterministic retarget a change evidence implies. */
export interface RetargetCandidate {
  readonly step: Step;
  /** The anchor changed: `testId`, `container.label`, `css#save`, `url`, … */
  readonly field: string;
  readonly before: string;
  readonly after: string;
  readonly evidence: ChangeEvidence;
  /** e.g. `label 'Create New' → 'Create' (src/ui/Toolbar.tsx:42)`. */
  readonly hypothesis: string;
}

export interface BreakExplanation {
  readonly explained: boolean;
  readonly reason: string;
  /** The evidence that explains the break (matching anchors and literal note mentions). */
  readonly evidence: readonly ChangeEvidence[];
  readonly candidates: readonly RetargetCandidate[];
}

export type ExplainsBreak = (step: Step, scope: ChangeScope) => BreakExplanation;

type AnchorKind = "testId" | "text" | "css" | "url";

interface Anchor {
  readonly field: string;
  readonly kind: AnchorKind;
  readonly value: string;
  readonly set: (after: string) => Step | null;
}

const COMPATIBLE: Readonly<Record<AnchorKind, ReadonlySet<ChangeEvidenceKind>>> = {
  testId: new Set(["test-id", "note"]),
  text: new Set(["accessible-name", "label", "copy", "note"]),
  css: new Set(["test-id", "note"]),
  url: new Set(["route", "redirect", "note"]),
};

const CSS_TOKEN = /([#.])([A-Za-z_][\w-]*)/g;
const CSS_IDENT = /^[A-Za-z_][\w-]*$/;

/** Whitespace-collapsed, trimmed, lower-cased: the form two anchor values are compared in. */
export function normalizeAnchor(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizePath(p: string): string {
  const n = normalizeAnchor(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

function targetAnchors(t: TargetDescriptor, prefix: string, rebuild: (t: TargetDescriptor) => Step): Anchor[] {
  const out: Anchor[] = [];
  const field = (k: "testId" | "name" | "label" | "text", kind: AnchorKind): void => {
    const v = t[k];
    if (v === undefined || v.trim() === "") return;
    out.push({ field: `${prefix}${k}`, kind, value: v, set: (after) => rebuild({ ...t, [k]: after }) });
  };
  field("testId", "testId");
  field("name", "text");
  field("label", "text");
  field("text", "text");
  if (t.css !== undefined) {
    const css = t.css;
    for (const m of css.matchAll(CSS_TOKEN)) {
      const [whole, sigil, ident] = m as unknown as [string, string, string];
      const at = m.index ?? 0;
      out.push({
        field: `${prefix}css${sigil}${ident}`,
        kind: "css",
        value: ident,
        set: (after) => (CSS_IDENT.test(after) ? rebuild({ ...t, css: css.slice(0, at) + sigil + after + css.slice(at + whole.length) }) : null),
      });
    }
  }
  if (t.container !== undefined) {
    const container = t.container;
    out.push(...targetAnchors(container, `${prefix}container.`, (c) => rebuild({ ...t, container: c })));
  }
  return out;
}

function urlParts(url: string): { head: string; path: string; tail: string } {
  const abs = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(url);
  const head = abs?.[1] ?? "";
  const rest = abs === null ? url : (abs[2] ?? "");
  const cut = rest.search(/[?#]/);
  return cut < 0 ? { head, path: rest, tail: "" } : { head, path: rest.slice(0, cut), tail: rest.slice(cut) };
}

/** Every anchor a step is located by, with how to rebuild the step with that one anchor changed. */
export function stepAnchors(step: Step): Anchor[] {
  if (step.kind === "navigate") {
    const { head, path, tail } = urlParts(step.url);
    if (path === "") return [];
    return [{ field: "url", kind: "url", value: path, set: (after) => (after.startsWith("/") ? { ...step, url: `${head}${after}${tail}` } : null) }];
  }
  if (step.kind === "forEach") return targetAnchors(step.items, "items.", (items) => ({ ...step, items }));
  if ("target" in step) return targetAnchors(step.target, "", (target) => ({ ...step, target }) as Step);
  return [];
}

function cite(e: ChangeEvidence): string {
  if (e.file === undefined) return e.kind === "note" ? "change note" : e.kind;
  return e.line === undefined ? e.file : `${e.file}:${e.line}`;
}

function matches(a: Anchor, beforeValue: string): boolean {
  return a.kind === "url" ? normalizePath(a.value) === normalizePath(beforeValue) : normalizeAnchor(a.value) === normalizeAnchor(beforeValue);
}

/** The deterministic default `ExplainsBreak`. */
export const explainsBreak: ExplainsBreak = (step, scope) => {
  const anchors = stepAnchors(step);
  if (scope.evidence.length === 0) {
    return { explained: false, reason: "no change context: the change scope holds no evidence", evidence: [], candidates: [] };
  }
  if (anchors.length === 0) {
    return { explained: false, reason: `a ${step.kind} step has no target or URL a change could have renamed`, evidence: [], candidates: [] };
  }
  const evidence: ChangeEvidence[] = [];
  const candidates: RetargetCandidate[] = [];
  const seen = new Set<string>();
  for (const e of scope.evidence) {
    if (e.kind === "inserted-ui") continue;
    let explainedByThis = false;
    for (const a of anchors) {
      if (!COMPATIBLE[a.kind].has(e.kind)) continue;
      if (e.before !== undefined && e.before.trim() !== "" && matches(a, e.before)) {
        explainedByThis = true;
        if (e.after === undefined || e.after.trim() === "" || matches(a, e.after)) continue;
        const next = a.set(e.after.trim());
        if (next === null) continue;
        const key = JSON.stringify(next);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          step: next,
          field: a.field,
          before: a.value,
          after: e.after.trim(),
          evidence: e,
          hypothesis: `${a.field} '${a.value}' → '${e.after.trim()}' (${cite(e)})`,
        });
      } else if (e.kind === "note" && e.before === undefined && e.note !== undefined) {
        // An unparsable note explains by literal mention only — it implies no candidate.
        if (normalizeAnchor(e.note).includes(normalizeAnchor(a.value))) explainedByThis = true;
      }
    }
    if (explainedByThis) evidence.push(e);
  }
  if (evidence.length === 0) {
    const shown = anchors.map((a) => `${a.field} '${a.value}'`).join(", ");
    return { explained: false, reason: `no change evidence names the step's ${shown}`, evidence: [], candidates: [] };
  }
  const reason =
    candidates.length === 0
      ? `change evidence ${evidence.map((e) => e.id).join(", ")} names the step's anchor but implies no replacement`
      : `change evidence ${evidence.map((e) => e.id).join(", ")} renamed the step's anchor`;
  return { explained: true, reason, evidence, candidates };
};

/** Every anchor value of a step, normalised — to tell whether a model candidate's anchor is one a change introduced. */
export function anchorValues(step: Step): string[] {
  return stepAnchors(step).map((a) => (a.kind === "url" ? normalizePath(a.value) : normalizeAnchor(a.value)));
}

/** True when the candidate's anchors that differ from the broken step's all appear as some evidence `after`. */
export function newAnchorsInChange(broken: Step, candidate: Step, scope: ChangeScope): boolean {
  const old = new Set(anchorValues(broken));
  const fresh = anchorValues(candidate).filter((v) => !old.has(v));
  if (fresh.length === 0) return false;
  const afters = new Set(
    scope.evidence.flatMap((e) => (e.after === undefined || e.kind === "inserted-ui" ? [] : [normalizeAnchor(e.after), normalizePath(e.after)])),
  );
  return fresh.every((v) => afters.has(v));
}
