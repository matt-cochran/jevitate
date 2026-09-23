import {
  RecordingSchema,
  type Assertion,
  type PageSegment,
  type RecordedStep,
  type Recording,
  type Step,
  type StepTiming,
  type PageTimingRecord,
  type TargetDescriptor,
  type ValueOrVar,
} from "@jevitate/recording";
import { assertNoSecretInPayload, redactText, redactUrl } from "@jevitate/ai-core";
import type { PageTiming } from "./timing.js";

/**
 * record: accumulate executed steps into a schema-valid, deterministically
 * replayable `Recording`.
 *
 * Two disciplines from the design (plan Task 8):
 *  - **Record BEFORE re-observing.** The loop appends the step it just executed
 *    (`action`/`navigate`) with a provisional postcondition, and only THEN
 *    re-observes the page and calls `observed(url)` — which, if the URL changed,
 *    rewrites that step's postcondition to `urlIncludes` (the action caused a
 *    navigation) and starts the next page segment. This mirrors
 *    `@jevitate/recorder`'s assembly, so the emitted artifact replays.
 *  - **Value redaction.** A recorded `fill`/`select` value is a `ValueOrVar`.
 *    Jev never types a user secret (a secret field is never a `type` target),
 *    so the values recorded here are model-authored, non-secret synthetic text,
 *    recorded as `{ redacted:false, value }` so the `Recording` is
 *    self-contained and replays without external variable bindings. A caller
 *    that wants a value kept out of the artifact passes `{ redacted:true, ... }`
 *    or a `{ var }` reference instead.
 *
 * Jev drives by index; this records by durable descriptor — the snapshot is the
 * bridge, so the emitted `Recording` is index-free.
 */

/**
 * Reduces any URL to the path convention the recorder/interpreter use, then
 * applies the shared URL redaction rule (a non-absolute input keeps its query,
 * so a `?token=…` there must not reach the Recording).
 */
export function toPath(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return redactUrl(u.pathname || "/");
  } catch {
    // not absolute — fall through
  }
  return redactUrl(raw.startsWith("/") || /^https?:\/\//.test(raw) ? raw : `/${raw}`);
}

function setExpect(step: Step, assertion: Assertion): void {
  if ("expect" in step) step.expect = assertion;
}

const visible = (d: TargetDescriptor): Assertion => ({ kind: "visible", target: { ...d } });

/**
 * Passes every free-text field of a target descriptor (page labels, names,
 * text, selectors — recursively through `container`) through the shared
 * redaction seam, so a registered secret rendered on the page never lands in
 * the Recording. `frameUrl` also gets the URL rule.
 */
function redactDescriptor(d: TargetDescriptor, secrets: readonly string[]): TargetDescriptor {
  const r = (v: string): string => redactText(v, secrets);
  const out: TargetDescriptor = {};
  if (d.testId !== undefined) out.testId = r(d.testId);
  if (d.role !== undefined) out.role = r(d.role);
  if (d.name !== undefined) out.name = r(d.name);
  if (d.label !== undefined) out.label = r(d.label);
  if (d.text !== undefined) out.text = r(d.text);
  if (d.css !== undefined) out.css = r(d.css);
  if (d.frameUrl !== undefined) out.frameUrl = r(redactUrl(d.frameUrl));
  if (d.ordinal !== undefined) out.ordinal = d.ordinal;
  if (d.container !== undefined) out.container = redactDescriptor(d.container, secrets);
  return out;
}

export class RunRecorder {
  #pages: PageSegment[] = [];
  #current: PageSegment | null = null;
  #pendingSegmentUrl: string | null = null;
  #lastStep: RecordedStep | null = null;
  /** Whether `observed` already ran for the last step (only the FIRST observation after a step counts). */
  #lastStepObserved = false;
  #t0: number | null = null;
  #prevTime: number | null = null;

  readonly #secrets: readonly string[];
  readonly #listener: ((recording: Recording) => void) | undefined;
  #steps = 0;

  /**
   * `secrets` are the run's registered secret values: every label/descriptor,
   * path, intent and retro recorded is scrubbed of them, and `finish` proves the
   * whole Recording clean via `assertNoSecretInPayload` (fail closed — a
   * survivor, e.g. in a plain fill value, throws rather than being written).
   */
  constructor(
    readonly site: string,
    private readonly version = "1.0.0",
    secrets: readonly string[] = [],
    /**
     * Incremental-flush seam: receives the (validated, secret-free) Recording after every recorded
     * step, so a run that dies mid-way still leaves its Recording up to the failure on disk. A
     * snapshot that cannot be validated is simply not emitted (the final `finish` still fails
     * closed).
     */
    listener?: (recording: Recording) => void,
  ) {
    this.#secrets = secrets;
    this.#listener = listener;
  }

  /** Number of steps recorded so far — a step's flat replay index is its count minus one. */
  get stepCount(): number {
    return this.#steps;
  }

  #path(url: string): string {
    return redactText(toPath(url), this.#secrets);
  }

  #target(d: TargetDescriptor): TargetDescriptor {
    return redactDescriptor(d, this.#secrets);
  }

  #pageTiming(t: PageTiming): PageTimingRecord {
    const r = (v: string): string => redactText(v, this.#secrets);
    return {
      route: r(t.route),
      kind: t.kind,
      ...(t.navigation === undefined ? {} : { navigation: { ...t.navigation } }),
      ...(t.settleMs === undefined ? {} : { settleMs: t.settleMs }),
      settled: t.settled,
      requests: {
        count: t.requests.count,
        pending: t.requests.pending,
        slowest: t.requests.slowest.map((q) => ({ endpoint: r(q.endpoint), url: r(q.url), status: q.status, durationMs: q.durationMs })),
      },
      ...(t.lcpMs === undefined ? {} : { lcpMs: t.lcpMs }),
    };
  }

  #timing(atMs: number, durationMs = 0): StepTiming {
    if (this.#t0 === null) this.#t0 = atMs;
    const timing: StepTiming = {
      atMs: Math.max(0, atMs - this.#t0),
      durationMs,
      gapBeforeMs: this.#prevTime === null ? 0 : Math.max(0, atMs - this.#prevTime),
    };
    this.#prevTime = atMs;
    return timing;
  }

  #openSegment(url: string): void {
    this.#current = { url, steps: [] };
    this.#pages.push(this.#current);
    this.#pendingSegmentUrl = null;
  }

  #ensureSegment(url: string): void {
    if (this.#pendingSegmentUrl !== null) {
      this.#openSegment(this.#pendingSegmentUrl);
      return;
    }
    if (this.#current === null) this.#openSegment(this.#path(url));
  }

  #append(step: Step, atMs: number, durationMs = 0): void {
    const recorded: RecordedStep = { step, timing: this.#timing(atMs, durationMs) };
    const segment = this.#current;
    if (segment === null) throw new Error("RunRecorder: no page segment is open");
    segment.steps.push(recorded);
    this.#lastStep = recorded;
    this.#lastStepObserved = false;
    this.#steps += 1;
    this.#emit();
  }

  #emit(): void {
    if (this.#listener === undefined) return;
    const partial = this.tryFinish();
    if (partial.ok) this.#listener(partial.recording);
  }

  /** Record a navigation to `url`. Opens the segment for it. */
  navigate(url: string, atMs: number): void {
    const path = this.#path(url);
    if (this.#current === null || this.#current.url !== path) this.#openSegment(path);
    this.#append({ kind: "navigate", url: path, expect: { kind: "urlIncludes", text: path } }, atMs);
  }

  /** Record a click on a control. Provisional postcondition: target visible. */
  click(rawDescriptor: TargetDescriptor, atMs: number, durationMs = 0): void {
    this.#ensureSegment("/");
    const descriptor = this.#target(rawDescriptor);
    this.#append({ kind: "click", target: { ...descriptor }, expect: visible(descriptor) }, atMs, durationMs);
  }

  /**
   * Record a fill. `value` is a non-secret, model-authored string recorded as
   * `{ redacted:false, value }` by default (self-contained replay). Pass an
   * explicit `ValueOrVar` to keep the value out of the artifact.
   */
  fill(rawDescriptor: TargetDescriptor, value: string | ValueOrVar, atMs: number, durationMs = 0): void {
    this.#ensureSegment("/");
    const descriptor = this.#target(rawDescriptor);
    const v: ValueOrVar = typeof value === "string" ? { redacted: false, value } : value;
    this.#append({ kind: "fill", target: { ...descriptor }, value: v, expect: visible(descriptor) }, atMs, durationMs);
  }

  /** Record a select. Same value discipline as `fill`. */
  select(rawDescriptor: TargetDescriptor, value: string | ValueOrVar, atMs: number, durationMs = 0): void {
    this.#ensureSegment("/");
    const descriptor = this.#target(rawDescriptor);
    const v: ValueOrVar = typeof value === "string" ? { redacted: false, value } : value;
    this.#append({ kind: "select", target: { ...descriptor }, value: v, expect: visible(descriptor) }, atMs, durationMs);
  }

  /**
   * Record an upload of the mission fixture. `file` follows the same
   * `ValueOrVar` discipline as `fill`: a plain path is recorded as
   * `{ redacted:false, value }` so replay re-attaches that same file; pass a
   * `{ redacted:true, ... }` (a path containing a secret) or `{ var }` instead
   * to keep it out of the artifact.
   */
  upload(rawDescriptor: TargetDescriptor, file: string | ValueOrVar, atMs: number, durationMs = 0): void {
    this.#ensureSegment("/");
    const descriptor = this.#target(rawDescriptor);
    const f: ValueOrVar = typeof file === "string" ? { redacted: false, value: file } : file;
    // Provisional postcondition: the input is still attached — NOT `visible`,
    // because file inputs are routinely visually hidden behind a styled label.
    const attached: Assertion = { kind: "count", target: { ...descriptor }, min: 1 };
    this.#append({ kind: "upload", target: { ...descriptor }, file: f, expect: attached }, atMs, durationMs);
  }

  /**
   * Called AFTER re-observing. If the URL changed since the current segment,
   * the last recorded step caused the navigation: rewrite its postcondition to
   * `urlIncludes` and queue the next segment (materialized on the next step).
   */
  observed(url: string, _atMs: number, timing?: PageTiming, opts?: { readonly lastTargetStillPresent?: boolean }): void {
    // The first observation after a step carries how the page got there (a measurement, never a
    // postcondition): it is attached to that step's timing, redacted like everything else.
    if (timing !== undefined && this.#lastStep !== null && this.#lastStep.timing !== undefined && this.#lastStep.timing.page === undefined) {
      this.#lastStep.timing.page = this.#pageTiming(timing);
    }
    const path = this.#path(url);
    if (this.#current !== null && path !== this.#current.url && this.#lastStep !== null) {
      setExpect(this.#lastStep.step, { kind: "urlIncludes", text: path });
      this.#pendingSegmentUrl = path;
      this.#emit();
    } else if (
      opts?.lastTargetStillPresent === false &&
      this.#lastStep !== null &&
      !this.#lastStepObserved &&
      "expect" in this.#lastStep.step &&
      this.#lastStep.step.expect.kind !== "urlIncludes"
    ) {
      // An in-place action whose target is gone afterwards (an SPA step that swaps the view): the
      // provisional "target visible" postcondition did NOT hold in this run, so it must not be
      // recorded — the page's URL is what held, and a replay checks that instead.
      setExpect(this.#lastStep.step, { kind: "urlIncludes", text: path });
      this.#emit();
    }
    this.#lastStepObserved = true;
  }

  /**
   * Emit the schema-valid `Recording`. Throws if assembly produced anything
   * invalid, or if any registered secret survived into it (fail closed).
   */
  /**
   * `finish` as DATA: the Recording, or why it could not be produced (never throws). Used when a
   * run is being wound down after a failure, where a second exception would lose the evidence.
   */
  tryFinish(
    opts?: { intent?: string; retro?: string; startedAtIso?: string },
  ): { ok: true; recording: Recording } | { ok: false; reason: string } {
    try {
      return { ok: true, recording: this.finish(opts) };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e) };
    }
  }

  finish(opts?: { intent?: string; retro?: string; startedAtIso?: string }): Recording {
    const recording: Recording = {
      version: this.version,
      site: this.site,
      pages: this.#pages,
      ...(opts?.startedAtIso ? { startedAtIso: opts.startedAtIso } : {}),
      ...(opts?.intent ? { intent: redactText(opts.intent, this.#secrets) } : {}),
      ...(opts?.retro ? { retro: redactText(opts.retro, this.#secrets) } : {}),
    };
    const parsed = RecordingSchema.parse(recording);
    assertNoSecretInPayload(parsed, this.#secrets);
    return parsed;
  }
}

/** A schema-valid, step-free Recording whose retro says why the real one is unavailable. */
export function emptyRecording(site: string, reason: string): Recording {
  return { version: "1.0.0", site, pages: [], retro: `recording unavailable: ${reason}` };
}

/**
 * A copy of `recording` whose step at flat index `index` asserts nothing about its outcome (an
 * always-true `urlIncludes ""`). Used when replaying a finding's repro to OBSERVE what the app does
 * after that step — the check that follows (a defect signal, a hang) is the verdict, and a fixed
 * app that now behaves differently after the step must not turn the replay into a failure.
 * Every earlier step keeps its postcondition, so the replay still proves it reached the same place.
 */
export function observeAfterStep(recording: Recording, index: number): Recording {
  const copy: Recording = structuredClone(recording);
  let i = 0;
  for (const page of copy.pages) {
    for (const recorded of page.steps) {
      if (i === index && "expect" in recorded.step) {
        recorded.step.expect = { kind: "urlIncludes", text: "" };
        return copy;
      }
      i += 1;
    }
  }
  return copy;
}
