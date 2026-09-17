import type { Recording, RecordedStep } from "@doit/recording";
import { RecordingSchema } from "@doit/recording";

/**
 * "Always-on recording" (design spec §5b): a `RecordingSink` receives one
 * `RecordedStep` per top-level step the interpreter actually executed, so an
 * automated `RecordingInterpreter.run` can emit a `Recording` describing what
 * it did, in the same shape as a human-authored/`@doit/recorder`-captured
 * one — an apples-to-apples diagnostic artifact.
 *
 * Deliberately ONE method, no page-boundary parameter (per the controller
 * ruling): `RecordingInterpreter` sinks a single flat sequence of steps; see
 * `BufferingSink.toRecording` for how that sequence becomes a `Recording`'s
 * `pages[]`.
 */
export interface RecordingSink {
  step(rec: RecordedStep): void;
}

/** Options for assembling a `BufferingSink`'s collected steps into a `Recording`. */
export interface ToRecordingOptions {
  /** `Recording.site` — the site this run executed against. */
  site: string;
  /** `Recording.version`; defaults to `"1.0"` (matches the recording schema's current version marker). */
  version?: string;
  /**
   * The URL of the single `PageSegment` this sink assembles (see the
   * single-page-segment ruling on `BufferingSink` below). Defaults to
   * `site` when omitted.
   */
   url?: string;
}

/**
 * The concrete, in-memory `RecordingSink`: collects every sunk step and,
 * on demand, assembles them into a schema-valid `Recording`.
 *
 * A.2 ruling: this always produces a SINGLE `PageSegment` containing every
 * sunk step in order, rather than re-segmenting by the input recording's own
 * `pages[]` boundaries. A single page segment is schema-valid and sufficient
 * for the "did the run do what the demo did" diagnostic this task targets;
 * page-boundary-preserving re-segmentation is real but out of scope here.
 */
export class BufferingSink implements RecordingSink {
  private readonly steps: RecordedStep[] = [];

  step(rec: RecordedStep): void {
    this.steps.push(rec);
  }

  /**
   * Assembles the steps collected so far into a `Recording` and validates it
   * against `RecordingSchema` before returning — a `BufferingSink` can never
   * hand back an invalid `Recording`.
   */
  toRecording(opts: ToRecordingOptions): Recording {
    const rec: Recording = {
      version: opts.version ?? "1.0",
      site: opts.site,
      startedAtIso: new Date().toISOString(),
      pages: [
        {
          url: opts.url ?? opts.site,
          steps: this.steps,
        },
      ],
    };
    return RecordingSchema.parse(rec);
  }
}
