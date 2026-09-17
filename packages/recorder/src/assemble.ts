import {
  RecordingSchema,
  type Assertion,
  type PageSegment,
  type RecordedStep,
  type Recording,
  type Step,
  type StepTiming,
  type TargetDescriptor,
} from "@doit/recording";
import type {
  ActionCaptureEvent,
  CaptureEvent,
  CapturedActionPayload,
  ResolutionFailureCause,
} from "./recorder.js";

/**
 * Translation: a buffer of captured events → a schema-valid `Recording`.
 *
 * This module is **pure**. Every DOM question was already answered at capture
 * time (`Recorder` resolves each action's descriptor the moment it arrives,
 * while the element still exists); assembly only rearranges what is in the
 * buffer. That split is what makes a multi-page recording possible at all — by
 * the time `stop()` runs, the elements of every earlier page are gone.
 *
 * RxD design §5c, realized here:
 *  - **Auto-inserted postconditions**: every acting step gets an `expect`
 *    (a `handback` gets a `resume`), inferred from the observed change.
 *  - **Exclusions**: all fill/select values are redacted; a secret field
 *    becomes a `handback` rather than a `fill`, which is how A.1's closed step
 *    vocabulary spells "human-only" — it has no separate boolean flag.
 */

/** Matches `golden-replay.test.ts`'s convention. */
export const RECORDING_VERSION = "1.0.0";

/**
 * The prompts a human sees when the run hands back. Neither states nor implies
 * the value: the first names only the *kind* of field (which the descriptor in
 * `resume` already reveals), never its contents.
 */
const SECRET_PROMPT =
  "This field holds a secret (a password or one-time code). Its value was never captured, " +
  "so it cannot be replayed: enter it in the browser yourself, then the run continues.";

/**
 * One wording per cause. A human taking over mid-run is owed the actual reason
 * — "the page changed before I could describe this" and "this element has
 * nothing stable to identify it by" call for different judgements from them,
 * and they are the difference between a recording worth re-taking and one worth
 * fixing. Every wording ends the same way, because the required action is
 * always the same.
 */
const UNDESCRIBABLE_PROMPTS: Readonly<Record<ResolutionFailureCause, string>> = {
  "sub-frame":
    "This action happened inside an embedded frame, which the recorder cannot describe yet",
  "document-replaced":
    "This action loaded a new page before the recorder could describe what was acted on",
  "element-gone":
    "The element acted on here had already left the page before the recorder could describe it",
  "not-identifiable":
    "Nothing about this element identifies it reliably enough to find it again on a later run",
};

const UNDESCRIBABLE_SUFFIX =
  ", so it cannot be replayed: perform it in the browser yourself, then the run continues.";

const undescribablePrompt = (cause: ResolutionFailureCause): string =>
  UNDESCRIBABLE_PROMPTS[cause] + UNDESCRIBABLE_SUFFIX;

/** Event kinds that never become a `Step` (design ruling: see `translate`). */
const NON_STEP_KINDS: ReadonlySet<string> = new Set(["keydown", "submit"]);

/**
 * `input`/`change` on these `<input type=…>` values is ignored: the user's
 * actual gesture was the *click* on the box, which is captured as its own
 * event, and a `fill` with the browser's synthetic `"on"` value would be both
 * a duplicate and a lie about what happened.
 */
const CLICK_DRIVEN_INPUT_TYPES: ReadonlySet<string> = new Set(["checkbox", "radio"]);

export interface AssembleOptions {
  readonly site: string;
  readonly version?: string;
  readonly startedAtIso?: string;
  readonly intent?: string;
  readonly retro?: string;
}

/**
 * The path a URL contributes to the recording: `pathname` and **nothing else**,
 * matching `golden-replay.test.ts`'s `"/login"` / `"/thread/t-1"` convention
 * (and `NavigateUrlSchema`, which requires a leading `/`).
 *
 * The query string is dropped deliberately, and it is a redaction decision
 * rather than a formatting one. A magic link, a password-reset link or a
 * session hand-off puts its credential in the query — `?token=…` — and this
 * value is persisted verbatim into `PageSegment.url`, into the leading
 * `navigate.url`, and into every `urlIncludes` assertion inferred from it.
 * Keeping the query would route exactly the class of secret the recorder
 * refuses to read out of a password field straight back into the artifact
 * through the URL. The cost is that two pages distinguished only by their
 * query (`/search?q=a` vs `/search?q=b`) record the same `url` string; they
 * are still separate `PageSegment`s, because segmentation follows navigation
 * events rather than URL equality.
 *
 * Returns `null` for anything that is not http(s) — `about:blank`,
 * `chrome-error://…`, `data:` — because such a URL has no meaningful path
 * (`new URL("about:blank").pathname` is the bare string `"blank"`, which would
 * fail `NavigateUrlSchema`) and is never a page of a recorded journey.
 */
export function pathOf(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.pathname;
}

/** `pathOf`, degrading to the raw URL — for `PageSegment.url`/`urlIncludes`, which accept any string. */
export function pathOrRaw(rawUrl: string): string {
  return pathOf(rawUrl) ?? rawUrl;
}

/** Page-side `ts` is authoritative for actions; navigations only have a Node-side time. */
function timeOf(event: CaptureEvent): number {
  return event.type === "action" ? event.payload.ts : event.receivedAt;
}

/** Rewrites a step's postcondition, whatever the step calls it. */
function setPostcondition(step: Step, assertion: Assertion): void {
  if (step.kind === "handback") {
    step.resume = assertion;
    return;
  }
  if ("expect" in step) step.expect = assertion;
}

const visible = (descriptor: TargetDescriptor): Assertion => ({
  kind: "visible",
  // Cloned: `expect.target` and `step.target` must not alias one object, so a
  // later consumer editing one does not silently edit the other.
  target: { ...descriptor },
});

const isValueEvent = (payload: CapturedActionPayload): boolean =>
  payload.kind === "input" || payload.kind === "change";

/**
 * Turns the buffer into a `Recording` and **validates it before returning**.
 * A buffer that assembles into something `RecordingSchema` rejects is a bug in
 * this module, and throwing is the only honest answer: a recording that does
 * not parse cannot be replayed, reviewed or stored.
 */
export function assembleRecording(events: readonly CaptureEvent[], opts: AssembleOptions): Recording {
  const pages: PageSegment[] = [];
  const t0 = events.length > 0 ? timeOf(events[0]!) : 0;

  let current: PageSegment | null = null;
  /** The most recently emitted step: a navigation folds into *its* postcondition. */
  let lastStep: RecordedStep | null = null;
  /**
   * The step a *further* navigation (with no action in between) should rewrite
   * — how a redirect chain collapses to its final URL instead of emitting a
   * `PageSegment` per hop. `null` once an action has intervened.
   */
  let collapseTarget: RecordedStep | null = null;
  let navSinceStep = false;
  let prevStepTime: number | null = null;
  /**
   * Steps already emitted for a value-carrying element, keyed by its `eid`.
   * One field produces many `input` events (one per keystroke) plus a `change`
   * on blur, and those are *not* necessarily consecutive — a `change` fires
   * when focus moves, which can be after another field's events. Keying by
   * `eid` (unique per document, so this is cleared on every main-frame
   * navigation) folds them all into the single step they describe.
   */
  let valueSteps = new Map<string, { readonly recorded: RecordedStep; readonly firstTime: number }>();

  const timingFor = (time: number, durationMs = 0): StepTiming => ({
    // Clamped: page-side and Node-side clocks are the same wall clock, but
    // mixing them (actions report their own `ts`, navigations a Node time)
    // could in principle produce a value a millisecond in the past, and a
    // negative elapsed time is never the truth we want to record.
    atMs: Math.max(0, time - t0),
    durationMs,
    gapBeforeMs: prevStepTime === null ? 0 : Math.max(0, time - prevStepTime),
  });

  const emit = (segment: PageSegment, step: Step, time: number): RecordedStep => {
    const recorded: RecordedStep = { step, timing: timingFor(time) };
    segment.steps.push(recorded);
    lastStep = recorded;
    collapseTarget = null;
    navSinceStep = false;
    prevStepTime = time;
    return recorded;
  };

  const onNavigation = (path: string, time: number): void => {
    if (current === null) {
      // The first main-frame navigation is BOTH pages[0].url and an explicit
      // leading `navigate` step, so the recording starts from a known URL
      // rather than from whatever the browser happened to be showing.
      const step: Step = { kind: "navigate", url: path, expect: { kind: "urlIncludes", text: path } };
      current = { url: path, steps: [] };
      pages.push(current);
      collapseTarget = emit(current, step, time);
      navSinceStep = true;
      valueSteps = new Map();
      return;
    }
    if (navSinceStep) {
      // A navigation with no action since the last one: a redirect hop, or
      // about:blank → the real page. Collapse onto the final URL instead of
      // leaving an empty PageSegment behind for every hop.
      current.url = path;
      if (collapseTarget !== null) {
        if (collapseTarget.step.kind === "navigate") collapseTarget.step.url = path;
        setPostcondition(collapseTarget.step, { kind: "urlIncludes", text: path });
      }
      valueSteps = new Map();
      return;
    }
    // A navigation that directly follows an action: that action *caused* it, so
    // it becomes the action's postcondition rather than a step of its own, and
    // it starts the next PageSegment.
    if (lastStep !== null) setPostcondition(lastStep.step, { kind: "urlIncludes", text: path });
    collapseTarget = lastStep;
    current = { url: path, steps: [] };
    pages.push(current);
    navSinceStep = true;
    valueSteps = new Map();
  };

  const onAction = (event: ActionCaptureEvent): void => {
    const payload = event.payload;
    // `submit` adds nothing: the click on the submit control already recorded
    // the gesture. `keydown` exists only for a future typing model, and this
    // schema has no field to carry it.
    if (NON_STEP_KINDS.has(payload.kind)) return;

    const isValue = isValueEvent(payload);
    if (isValue && CLICK_DRIVEN_INPUT_TYPES.has(payload.typeAttr ?? "")) return;

    if (isValue) {
      const existing = valueSteps.get(payload.eid);
      if (existing !== undefined) {
        // A later keystroke or the blur-time `change` for a field already
        // recorded: update the value in place, and let the elapsed time become
        // the step's duration.
        updateValue(existing.recorded.step, payload);
        existing.recorded.timing = {
          ...existing.recorded.timing!,
          durationMs: Math.max(0, payload.ts - existing.firstTime),
        };
        return;
      }
    }

    if (current === null) {
      // Recording attached to an already-loaded page: no navigation was
      // observed, so the frame's own URL names the segment.
      current = { url: pathOrRaw(event.frameUrl), steps: [] };
      pages.push(current);
    }

    const recorded = emit(current, buildStep(event), payload.ts);
    if (isValue) valueSteps.set(payload.eid, { recorded, firstTime: payload.ts });
  };

  for (const event of events) {
    if (event.type === "navigation") {
      // Sub-frame navigations (an iframe loading, an ad refreshing) are not
      // pages of the journey.
      if (!event.isMainFrame) continue;
      const path = pathOf(event.url);
      if (path === null) continue;
      onNavigation(path, event.receivedAt);
      continue;
    }
    onAction(event);
  }

  const recording: Recording = {
    version: opts.version ?? RECORDING_VERSION,
    site: opts.site,
    pages,
    ...(opts.startedAtIso === undefined ? {} : { startedAtIso: opts.startedAtIso }),
    ...(opts.intent === undefined ? {} : { intent: opts.intent }),
    ...(opts.retro === undefined ? {} : { retro: opts.retro }),
  };
  return RecordingSchema.parse(recording);
}

/**
 * One captured action → one `Step`, with its postcondition provisionally set to
 * "the element I acted on is visible". A navigation arriving before the next
 * action overwrites that with `urlIncludes`; those are the only two inferences
 * made here. (The design also mentions detecting some *other* newly-revealed
 * element, which needs before/after DOM snapshots — deliberately out of scope.)
 */
function buildStep(event: ActionCaptureEvent): Step {
  const payload = event.payload;
  const resolution = event.resolution;

  if (resolution === undefined || !resolution.ok) {
    // No descriptor: the element could not be proven identifiable, or the
    // action happened in a sub-frame. There is nothing honest to put in a
    // `visible` target, so `resume` falls back to the one assertion that is
    // always constructible — the URL the action happened on. Inventing a
    // plausible-looking descriptor would be strictly worse: it would replay,
    // and it would act on the wrong element.
    // A missing resolution means the description was never attempted at all
    // (no recording was running when the event arrived), which is the same
    // predicament for the human as an element that had already gone.
    const text = resolution === undefined ? pathOrRaw(event.frameUrl) : resolution.resumePath;
    const cause = resolution === undefined ? "element-gone" : resolution.cause;
    return {
      kind: "handback",
      prompt: undescribablePrompt(cause),
      resume: { kind: "urlIncludes", text },
    };
  }

  const target = { ...resolution.descriptor };
  if (!isValueEvent(payload)) {
    return { kind: "click", target, expect: visible(resolution.descriptor) };
  }

  if (payload.rawText === undefined) {
    // Task 3's contract: `rawText` is absent *only* for a password or
    // one-time-code field. The action is still recorded — as a `handback`, not
    // a `fill`. A `fill` would need a `ValueOrVar`, and every variant of that
    // union says something about the value (even `{redacted:true,length}`
    // leaks its length), so the step carries no value shape at all.
    return { kind: "handback", prompt: SECRET_PROMPT, resume: visible(resolution.descriptor) };
  }

  // All fill/select values are redacted, always — design §5c, "all fill values
  // redacted by default". Never `{redacted:false, value}`, not even for an
  // obviously harmless field: the recorder is not the component that gets to
  // decide a value is harmless.
  const value = { redacted: true as const, length: payload.rawText.length };
  const expect = visible(resolution.descriptor);
  return payload.tag === "select"
    ? { kind: "select", target, value, expect }
    : { kind: "fill", target, value, expect };
}

/** Re-redacts an already-emitted value step from a later event on the same field. */
function updateValue(step: Step, payload: CapturedActionPayload): void {
  if (step.kind !== "fill" && step.kind !== "select") return; // a handback carries no value to update
  if (payload.rawText === undefined) return;
  step.value = { redacted: true, length: payload.rawText.length };
}
