import {
  RecordingSchema,
  type Assertion,
  type PageSegment,
  type RecordedStep,
  type Recording,
  type Step,
  type StepTiming,
  type TargetDescriptor,
  type ValueOrVar,
} from "@jevitate/recording";

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

/** Reduces any URL to the path convention the recorder/interpreter use. */
export function toPath(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return u.pathname || "/";
  } catch {
    // not absolute — fall through
  }
  return raw.startsWith("/") || /^https?:\/\//.test(raw) ? raw : `/${raw}`;
}

function setExpect(step: Step, assertion: Assertion): void {
  if ("expect" in step) step.expect = assertion;
}

const visible = (d: TargetDescriptor): Assertion => ({ kind: "visible", target: { ...d } });

export class RunRecorder {
  #pages: PageSegment[] = [];
  #current: PageSegment | null = null;
  #pendingSegmentUrl: string | null = null;
  #lastStep: RecordedStep | null = null;
  #t0: number | null = null;
  #prevTime: number | null = null;

  constructor(
    readonly site: string,
    private readonly version = "1.0.0",
  ) {}

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
    if (this.#current === null) this.#openSegment(toPath(url));
  }

  #append(step: Step, atMs: number, durationMs = 0): void {
    const recorded: RecordedStep = { step, timing: this.#timing(atMs, durationMs) };
    this.#current!.steps.push(recorded);
    this.#lastStep = recorded;
  }

  /** Record a navigation to `url`. Opens the segment for it. */
  navigate(url: string, atMs: number): void {
    const path = toPath(url);
    if (this.#current === null || this.#current.url !== path) this.#openSegment(path);
    this.#append({ kind: "navigate", url: path, expect: { kind: "urlIncludes", text: path } }, atMs);
  }

  /** Record a click on a control. Provisional postcondition: target visible. */
  click(descriptor: TargetDescriptor, atMs: number, durationMs = 0): void {
    this.#ensureSegment("/");
    this.#append({ kind: "click", target: { ...descriptor }, expect: visible(descriptor) }, atMs, durationMs);
  }

  /**
   * Record a fill. `value` is a non-secret, model-authored string recorded as
   * `{ redacted:false, value }` by default (self-contained replay). Pass an
   * explicit `ValueOrVar` to keep the value out of the artifact.
   */
  fill(descriptor: TargetDescriptor, value: string | ValueOrVar, atMs: number, durationMs = 0): void {
    this.#ensureSegment("/");
    const v: ValueOrVar = typeof value === "string" ? { redacted: false, value } : value;
    this.#append({ kind: "fill", target: { ...descriptor }, value: v, expect: visible(descriptor) }, atMs, durationMs);
  }

  /** Record a select. Same value discipline as `fill`. */
  select(descriptor: TargetDescriptor, value: string | ValueOrVar, atMs: number, durationMs = 0): void {
    this.#ensureSegment("/");
    const v: ValueOrVar = typeof value === "string" ? { redacted: false, value } : value;
    this.#append({ kind: "select", target: { ...descriptor }, value: v, expect: visible(descriptor) }, atMs, durationMs);
  }

  /**
   * Called AFTER re-observing. If the URL changed since the current segment,
   * the last recorded step caused the navigation: rewrite its postcondition to
   * `urlIncludes` and queue the next segment (materialized on the next step).
   */
  observed(url: string, _atMs: number): void {
    const path = toPath(url);
    if (this.#current !== null && path !== this.#current.url && this.#lastStep !== null) {
      setExpect(this.#lastStep.step, { kind: "urlIncludes", text: path });
      this.#pendingSegmentUrl = path;
    }
  }

  /** Emit the schema-valid `Recording`. Throws if assembly produced anything invalid. */
  finish(opts?: { intent?: string; retro?: string; startedAtIso?: string }): Recording {
    const recording: Recording = {
      version: this.version,
      site: this.site,
      pages: this.#pages,
      ...(opts?.startedAtIso ? { startedAtIso: opts.startedAtIso } : {}),
      ...(opts?.intent ? { intent: opts.intent } : {}),
      ...(opts?.retro ? { retro: opts.retro } : {}),
    };
    return RecordingSchema.parse(recording);
  }
}
