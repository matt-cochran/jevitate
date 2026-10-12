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
export type AnchorSuggestionKind = "write" | "new-page" | "form-valid" | "job-end";

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
  "job-end": ["back/reload", "a second tab"],
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

interface WriteEvidence {
  readonly method: string;
  readonly path: string;
  readonly line: string;
}

/**
 * #506: write requests an older recording kept only as page timing (`timing.page.requests.slowest`,
 * no action delta): classified by the same write classifier, and only when the request did not fail.
 */
function timingWrites(recorded: RecordedStep, classify: ReturnType<typeof writeClassifier>): WriteEvidence[] {
  const out: WriteEvidence[] = [];
  for (const r of recorded.timing?.page?.requests.slowest ?? []) {
    if (r.status !== null && r.status >= 400) continue;
    const m = /^(\S+)\s+(\S+)/.exec(r.endpoint.trim());
    const method = m?.[1] ?? "";
    const path = m !== null ? pathOf(m[2]!) : pathOf(r.url);
    if (method === "" || !classify({ method, path })) continue;
    out.push({ method, path, line: `${method} ${path}${r.status === null ? "" : ` → ${r.status}`}` });
  }
  return out;
}

/** Does the Journey's end state name this write (a `requestMade` / `responseStatus` check on it)? */
function endStateNames(journey: Journey, w: WriteEvidence): boolean {
  return (journey.metadata.endState ?? []).some((c) => (c.kind === "requestMade" || c.kind === "responseStatus") && c.method.toUpperCase() === w.method.toUpperCase() && globMatches(c.pathGlob, w.path));
}

function globMatches(glob: string, value: string): boolean {
  const src = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${src}$`, "i").test(value);
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

  // New-page evidence per step. A change with no recorded url delta is credited to the LAST step of
  // the previous page segment — the action that navigated — not the first step of the next one.
  const reachedAt = new Map<number, string>();
  {
    let before: string | undefined;
    let beforePage = -1;
    flat.forEach(({ index, page, recorded }) => {
      const segmentPath = pathOf(journey.recording.pages[page]!.url);
      const stepUrl = recorded.step.kind === "navigate" ? recorded.step.url : undefined;
      const deltaUrl = recorded.delta?.url?.after;
      const path = deltaUrl !== undefined ? pathOf(deltaUrl) : stepUrl !== undefined ? pathOf(stepUrl) : segmentPath;
      const segmentChange = page !== beforePage && beforePage >= 0;
      const changed = before !== undefined && (segmentChange ? segmentPath !== before : path !== before);
      if (changed) {
        const at = segmentChange && deltaUrl === undefined && stepUrl === undefined ? index - 1 : index;
        if (!reachedAt.has(at)) reachedAt.set(at, `navigates from ${before} to ${path}`);
      }
      before = path;
      beforePage = page;
    });
  }

  flat.forEach(({ index, recorded }) => {
    const anchored = (recorded.stepId !== undefined && anchoredIds.has(recorded.stepId)) || anchoredSteps.has(index + 1);

    const deltaWrites = (recorded.delta?.requests ?? []).flatMap((line) => {
      const m = /^(\S+)\s+(\S+)/.exec(line.trim());
      return m !== null && classify({ method: m[1]!, path: m[2]!, }) ? [{ method: m[1]!, path: m[2]!, line: line.trim() }] : [];
    });
    const writes = deltaWrites.length > 0 ? deltaWrites : timingWrites(recorded, classify);
    const declared = (recorded.expectRequests ?? []).filter((c) => classify({ method: c.method, path: c.pathGlob }));
    const next = flat[index + 1]?.recorded;
    const formValid =
      FILL_KINDS.has(recorded.step.kind) &&
      (/\benabled\b|\bvalid\b/i.test((recorded.delta?.changes ?? []).join(" ")) || (next !== undefined && !FILL_KINDS.has(next.step.kind) && isSubmitControl(next)));

    if (anchored) return;
    if (writes.length > 0) {
      const w = writes[0]!;
      const seg = lastSegment(pathOf(w.path));
      push(index, "write", seg === "" ? "write-done" : `${slug(seg)}-written`, `${w.line} completed here${endStateNames(journey, w) ? " (named by the end state)" : ""}`);
    } else if (declared.length > 0) {
      const c = declared[0]!;
      const seg = lastSegment(pathOf(c.pathGlob.replace(/\*/g, "")));
      push(index, "write", seg === "" ? "write-done" : `${slug(seg)}-written`, `the step expects a ${c.method.toUpperCase()} ${c.pathGlob} write`);
    } else if (reachedAt.has(index)) {
      const reason = reachedAt.get(index)!;
      const seg = lastSegment(reason.slice(reason.lastIndexOf(" to ") + 4));
      push(index, "new-page", seg === "" ? "home-page" : `${slug(seg)}-page`, reason);
    } else if (formValid) {
      const submit = next !== undefined && isSubmitControl(next) ? controlName(next) : "";
      push(index, "form-valid", submit === "" ? "form-valid" : `${slug(submit)}-ready`, submit === "" ? "a change enabled the form" : `the form is filled and ready for '${submit}'`);
    }
  });
  const lastIndex = flat.length - 1;
  if (out.length === 0 && journey.metadata.job !== undefined && lastIndex >= 0) {
    const last = flat[lastIndex]!.recorded;
    const anchored = (last.stepId !== undefined && anchoredIds.has(last.stepId)) || anchoredSteps.has(lastIndex + 1);
    if (!anchored) push(lastIndex, "job-end", `${journey.metadata.job}-done`, `fallback: nothing else changed state, so the last step is proposed as the end of job '${journey.metadata.job}'`);
  }
  return out;
}

/** The CLI command that accepts a suggestion. */
export function anchorAddCommand(journeyId: string, s: AnchorSuggestion): string {
  const probes = s.probes.map((p) => ` --probe '${p}'`).join("");
  return `jevitate journey anchor add ${journeyId} --name ${s.name} --step ${s.stepId ?? s.step}${probes}`;
}
