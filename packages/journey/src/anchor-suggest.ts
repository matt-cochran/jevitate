import type { RecordedStep } from "@jevitate/recording";
import { writeClassifier } from "@jevitate/recording";
import { ANCHOR_NAME_RULE_RE, suggestAnchorName } from "./anchor-rules.js";
import { flatJourneySteps } from "./intent.js";
import type { Journey } from "./journey.js";

/**
 * #487 part 2: proposes anchors where a recorded flow changes state. Advisory and pure — it reads
 * what the recording captured (step kinds, targets, the action delta's url/requests/changes) and
 * writes nothing; `journey anchor add` is how a person accepts one.
 */

/** What changed at the step: a write request completed, a new page was reached, or a form became valid. */
export type AnchorSuggestionKind = "write" | "new-page" | "form-valid";

export interface AnchorSuggestion {
  /** Satisfies `ANCHOR_NAME_RULE_RE` and collides with no existing or earlier-suggested anchor. */
  readonly name: string;
  /** 1-based step number the anchor would follow. */
  readonly step: number;
  /** The step's stable id; absent when the recording has none yet (`anchor add` mints it). */
  readonly stepId?: string;
  readonly kind: AnchorSuggestionKind;
  /** One line: why this step is a state change. */
  readonly reason: string;
  /** Default adversarial probes for the kind. */
  readonly probes: readonly string[];
}

export interface AnchorSuggestOptions {
  /** Read patterns for the write classifier (`--read-rpc`, target config `safety.readRequests`). */
  readonly readRequests?: readonly string[];
}

const PROBES: Record<AnchorSuggestionKind, readonly string[]> = {
  write: ["double submit", "back/reload", "replay the write", "a second tab"],
  "new-page": ["back/reload", "a second tab"],
  "form-valid": ["double submit", "back/reload"],
};

const SUBMIT_WORDS = /\b(submit|save|send|place|pay|purchase|buy|continue|next|confirm|create|add|sign ?up|sign ?in|log ?in|register|apply|book|checkout|finish|done|post)\b/i;
const FILL_KINDS: ReadonlySet<string> = new Set(["fill", "select", "upload", "editText"]);

function pathOf(url: string): string {
  try {
    return new URL(url, "http://x.invalid").pathname || "/";
  } catch {
    return url.split(/[?#]/)[0] || "/";
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter((p) => p !== "" && !/^[0-9a-f-]{8,}$|^[0-9]+$/i.test(p));
  return parts[parts.length - 1] ?? "";
}

function controlName(r: RecordedStep): string {
  const s = r.step;
  if ("target" in s && s.target !== undefined) return (s.target.name ?? s.target.label ?? s.target.testId ?? "").trim();
  return (s.label ?? "").trim();
}

function isSubmitControl(r: RecordedStep): boolean {
  if (r.step.kind === "press") return /^enter$/i.test(r.step.key);
  return r.step.kind === "click" && SUBMIT_WORDS.test(`${controlName(r)} ${r.step.label ?? ""}`);
}

/**
 * Anchors worth adding to `journey`, in step order, one per step (a write wins over a new page, a
 * new page over a valid form). Steps already carrying an anchor (by id or number) are skipped.
 */
export function suggestAnchors(journey: Journey, opts: AnchorSuggestOptions = {}): AnchorSuggestion[] {
  const classify = writeClassifier({ readRequests: opts.readRequests });
  const flat = flatJourneySteps(journey);
  const anchors = journey.metadata.anchors ?? [];
  const taken = new Set(anchors.map((a) => a.name));
  const anchoredIds = new Set(anchors.flatMap((a) => (a.stepId === undefined ? [] : [a.stepId])));
  const anchoredSteps = new Set(anchors.map((a) => a.step));
  const out: AnchorSuggestion[] = [];

  const uniqueName = (base: string): string => {
    const root = suggestAnchorName(base);
    let name = root;
    for (let n = 2; taken.has(name) || !ANCHOR_NAME_RULE_RE.test(name); n++) name = `${root.slice(0, 60)}-${n}`;
    taken.add(name);
    return name;
  };
  const push = (index: number, kind: AnchorSuggestionKind, base: string, reason: string): void => {
    const recorded = flat[index]!.recorded;
    out.push({ name: uniqueName(base), step: index + 1, ...(recorded.stepId === undefined ? {} : { stepId: recorded.stepId }), kind, reason, probes: PROBES[kind] });
  };

  let prevPath: string | undefined;
  let prevPage = -1;
  flat.forEach(({ index, page, recorded }) => {
    const segmentPath = pathOf(journey.recording.pages[page]!.url);
    const stepUrl = recorded.step.kind === "navigate" ? recorded.step.url : undefined;
    const path = recorded.delta?.url !== undefined ? pathOf(recorded.delta.url.after) : stepUrl !== undefined ? pathOf(stepUrl) : segmentPath;
    const pageChanged = page !== prevPage && prevPage >= 0 ? segmentPath !== prevPath : path !== prevPath;
    const reached = prevPath !== undefined && pageChanged;
    const beforePath = prevPath;
    prevPath = path;
    prevPage = page;

    const anchored = (recorded.stepId !== undefined && anchoredIds.has(recorded.stepId)) || anchoredSteps.has(index + 1);

    const writes = (recorded.delta?.requests ?? []).flatMap((line) => {
      const m = /^(\S+)\s+(\S+)/.exec(line.trim());
      return m !== null && classify({ method: m[1]!, path: m[2]! }) ? [{ method: m[1]!, path: m[2]!, line: line.trim() }] : [];
    });
    const declared = (recorded.expectRequests ?? []).filter((c) => classify({ method: c.method, path: c.pathGlob }));
    const next = flat[index + 1]?.recorded;
    const formValid =
      FILL_KINDS.has(recorded.step.kind) &&
      (/\benabled\b|\bvalid\b/i.test((recorded.delta?.changes ?? []).join(" ")) || (next !== undefined && !FILL_KINDS.has(next.step.kind) && isSubmitControl(next)));

    if (anchored) return;
    if (writes.length > 0) {
      const w = writes[0]!;
      const seg = lastSegment(pathOf(w.path));
      push(index, "write", seg === "" ? "write-done" : `${slug(seg)}-written`, `${w.line} completed here`);
    } else if (declared.length > 0) {
      const c = declared[0]!;
      const seg = lastSegment(pathOf(c.pathGlob.replace(/\*/g, "")));
      push(index, "write", seg === "" ? "write-done" : `${slug(seg)}-written`, `the step expects a ${c.method.toUpperCase()} ${c.pathGlob} write`);
    } else if (reached) {
      const seg = lastSegment(path);
      push(index, "new-page", seg === "" ? "home-page" : `${slug(seg)}-page`, `navigates from ${beforePath} to ${path}`);
    } else if (formValid) {
      const submit = next !== undefined && isSubmitControl(next) ? controlName(next) : "";
      push(index, "form-valid", submit === "" ? "form-valid" : `${slug(submit)}-ready`, submit === "" ? "a change enabled the form" : `the form is filled and ready for '${submit}'`);
    }
  });
  return out;
}

/** The CLI command that accepts a suggestion. */
export function anchorAddCommand(journeyId: string, s: AnchorSuggestion): string {
  const probes = s.probes.map((p) => ` --probe '${p}'`).join("");
  return `jevitate journey anchor add ${journeyId} --name ${s.name} --step ${s.stepId ?? s.step}${probes}`;
}
