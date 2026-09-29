import type { TargetDescriptor } from "@jevitate/recording";

/** One request the run observed. */
export interface SignalRequest {
  /** Stable index within the capture (the `request:<id>` evidence ref). */
  readonly id: number;
  readonly method: string;
  /** `METHOD /normalized/path`. */
  readonly endpoint: string;
  /** Redacted URL. */
  readonly url: string;
  /** Playwright resource type (`fetch`, `xhr`, `document`, …). */
  readonly resourceType: string;
  readonly startedAt: number;
  /** When it finished or failed; `null` = still pending when the run ended. */
  readonly endedAt: number | null;
  readonly status: number | null;
  readonly failed?: boolean;
  /** The step whose action it followed (`0` = before the first decision). */
  readonly step: number;
  /** The REQUEST's content type, when it sent one (tells a gRPC-web/Connect read, #110). */
  readonly contentType?: string;
  /**
   * #131: a one-way digest of the request's (redacted) body with volatile keys (ids, timestamps,
   * nonces) dropped — two creates with the same key sent the same payload. Never the body itself.
   */
  readonly payloadKey?: string;
}

/** One screen the run observed (the state a step was decided on). */
export interface SignalScreen {
  readonly index: number;
  /** The step decided on this screen. */
  readonly step: number;
  readonly at: number;
  readonly url: string;
  readonly signature: string;
  /** Redacted visible text. */
  readonly visibleText: string;
  /** A progress/busy/status indicator was on screen (aria-busy, progressbar, role=status…). */
  readonly busy: boolean;
  /** Where this screen's screenshot was written, if one was. */
  readonly screenshot?: string;
  /** #131: the page's main heading (first h1, else the document title), redacted. */
  readonly heading?: string;
}

/** One transcript step (the fields the oracles need). */
export interface SignalStep {
  readonly step: number;
  readonly op: string | null;
  readonly target: string | null;
  readonly actOk: boolean;
  readonly url: string;
  readonly descriptor?: TargetDescriptor;
  /** The transcript's reason for the step (e.g. the run's own refusal to repeat a side effect, #92). */
  readonly reason?: string;
  /** The acted control's resolved `href`, when it was a link (#127: a same-page nav link is not inert). */
  readonly href?: string | null;
  /** The acted control's raw `aria-current` attribute, or null (#127). */
  readonly ariaCurrent?: string | null;
  /** #131: the (redacted) value a `type`/`select` step entered. */
  readonly value?: string;
  /** #131: the (redacted) message a `send` step sent. */
  readonly message?: string;
  /** #131: the (redacted) conversational reply awaited after a sent message. */
  readonly reply?: string;
}

export interface RunSignalCapture {
  readonly steps: readonly SignalStep[];
  readonly requests: readonly SignalRequest[];
  readonly screens: readonly SignalScreen[];
  /** When the run ended (a still-pending request's duration runs to here). */
  readonly endedAt: number;
  /** Values the run typed itself: an id it typed is its own content, not a leak. */
  readonly typedValues?: readonly string[];
}

export interface SignalOptions {
  /** A request is hung past this multiple of the run's typical (p50) request time. Default 10. */
  readonly hungFactor?: number;
  /** …and never below this floor (ms). Default 15 000. */
  readonly hungFloorMs?: number;
  /** Extra read-request patterns for the write classifier (`--read-rpc`, #110). */
  readonly readRequests?: readonly string[];
  /** #131: a started job is stuck past this multiple of the run's typical request time. Default 10. */
  readonly stuckFactor?: number;
  /** …and never below this floor (ms). Default 30 000. */
  readonly stuckFloorMs?: number;
  /** #131: the same assistant reply this many times is a finding (error/fallback copy: 2). Default 3. */
  readonly repeatedReplyMin?: number;
}

export type SignalKind =
  | "hung-request"
  | "duplicate-write"
  | "internal-id"
  | "inert-control"
  | "stuck-job"
  | "repeated-reply"
  | "duplicate-create"
  | "failed-submit"
  | "url-mismatch"
  /**
   * Horizontal page overflow (#149): pure DOM geometry
   * (`@jevitate/explore`'s `detectOverflow`), computed live during the run — unlike every other
   * signal kind here, it is never derived from the captured request/screen/step timeline, since it
   * needs the live page. `runUsabilityMission` (ux-api.ts) constructs it directly with
   * `makeSignalFinding` and merges it in alongside `detectSignals`'s output.
   */
  | "horizontal-overflow";

/** The evidence a signal finding cites — what a reader checks to verify it. */
export interface SignalEvidence {
  readonly kind: SignalKind;
  /** The transcript step(s) the signal was observed at. */
  readonly steps: readonly number[];
  readonly requests: readonly {
    readonly id: number;
    readonly method: string;
    readonly url: string;
    readonly status: number | null;
    readonly durationMs: number;
    readonly pending: boolean;
    readonly step: number;
  }[];
  /** The on-screen text the signal is about (an id's line), if any. */
  readonly text?: string;
  /** The screenshot of the screen the signal was observed on, if one was written. */
  readonly screenshot?: string;
  /** The measurement behind the finding, and how its confidence was derived. */
  readonly detail: string;
}
