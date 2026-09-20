import type { BrowserSession } from "@jevitate/playwright";
import { spliceRecording, type Recording, type SpliceAt } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { Recorder } from "./recorder.js";

/**
 * Record-a-patch orchestration (RxD Phase A.3b, Task 4).
 *
 * Composes three existing pieces against a *live* browser session:
 *
 *  1. `RecordingInterpreter.runToCheckpoint` drives `browser` through `base`
 *     up to (and including) `checkpoint` — a flat, 0-based step index, in the
 *     same order `@jevitate/interpreter`'s internal `flatten()` concatenates
 *     `base.pages[*].steps` in.
 *  2. The `Recorder` is *armed* (`install()`) before that drive begins, so
 *     its `page.addInitScript` listener is already present in whatever
 *     document the checkpoint lands on — `addInitScript` only takes effect
 *     on documents that load *after* it is registered, so installing any
 *     later would silently miss every action on an already-loaded checkpoint
 *     page. `start()` then clears everything buffered during the drive to
 *     the checkpoint and begins capturing fresh, on that same already-loaded
 *     page, for `demonstrate` to act on. Because nothing navigates the page
 *     between `start()` and the first captured action, this is the
 *     recorder's start-from-state capture path (A.2 §5c; see `assemble.ts`'s
 *     `onAction`, `current === null` branch): the resulting `segment` names
 *     its first page from the *current* URL rather than emitting a leading
 *     `navigate` step, which is what keeps it a delimited supplement instead
 *     of a re-record of the journey up to that point.
 *  3. `spliceRecording(base, at, segment, "insert")` splices `segment` in
 *     immediately after the checkpoint step, re-flowing page segmentation
 *     (including merging the split with `segment`'s first page when they
 *     share a URL — commit 8b3a959).
 */
export interface RecordPatchOptions {
  /** The recording to patch. Never mutated. */
  readonly base: Recording;
  /**
   * Flat, 0-based index (into `base.pages[*].steps` concatenated in page
   * order) of the last step that must have already run before the patch is
   * demonstrated. Matches `RecordingInterpreter.runToCheckpoint`'s
   * `stepIndex` exactly.
   */
  readonly checkpoint: number;
  /**
   * The live session driven to the checkpoint and then recorded from. Owned
   * by the caller: `recordPatch` neither opens nor closes it.
   */
  readonly browser: BrowserSession;
  /**
   * Performs the supplemental action(s) to capture, once `browser` has been
   * driven to the checkpoint and the recorder is armed. Real Playwright
   * gestures against `browser.page` only — the same discipline the Recorder
   * itself requires (no `page.evaluate`-synthesized events).
   */
  readonly demonstrate: (browser: BrowserSession) => Promise<void>;
  /** Forwarded to the `BrowseTheWeb` ability used for `runToCheckpoint`. */
  readonly allowedOrigins?: readonly string[];
  /** `Recording.intent` for the captured segment (not `base`'s). */
  readonly intent?: string;
  /** `Recording.retro` for the captured segment (not `base`'s). */
  readonly retro?: string;
}

export async function recordPatch(opts: RecordPatchOptions): Promise<Recording> {
  const { base, checkpoint, browser, demonstrate } = opts;

  // Armed BEFORE the drive to the checkpoint: `Recorder.install()`'s
  // `page.addInitScript` only reaches documents that load after it is
  // registered, and the checkpoint page is loaded by `runToCheckpoint`
  // below. Installing after that drive would leave the checkpoint page's
  // already-loaded document with no listener at all, and `demonstrate`'s
  // action would go uncaptured with no error to show for it.
  const recorder = new Recorder(browser, base.site);
  await recorder.install();

  const actor = CastActor.named("record-patch-checkpoint").whoCan(
    new BrowseTheWeb(browser, [...(opts.allowedOrigins ?? [])]),
  );
  const checkpointResult = await new RecordingInterpreter().runToCheckpoint(actor, base, checkpoint);
  if (checkpointResult.outcome !== "completed") {
    throw new Error(
      `recordPatch: could not drive the live session to checkpoint ${checkpoint} on the base recording ` +
        `(outcome: ${JSON.stringify(checkpointResult)})`,
    );
  }

  // Computed before recording starts: it describes coordinates in `base`,
  // never in the about-to-be-captured `segment`.
  const at = checkpointToSpliceAt(base, checkpoint);

  // `start()` drops everything buffered during the drive to the checkpoint
  // (navigations, and any stray events) and begins capturing fresh from here.
  await recorder.start(opts.intent);
  await demonstrate(browser);
  const segment = await recorder.stop(opts.retro);

  return spliceRecording(base, at, segment, "insert");
}

/**
 * Translates a flat `runToCheckpoint` step index into `spliceRecording`'s
 * `{page, step}` coordinates, pointed *just after* that step so the captured
 * segment lands following it rather than before it (the checkpoint step has
 * already run by the time the segment is captured).
 *
 * Walks `base.pages` in exactly the order `@jevitate/interpreter`'s internal
 * `flatten(rec)` (`rec.pages.flatMap(p => p.steps)`) concatenates them —
 * this must never diverge from that function, or the splice lands at the
 * wrong step.
 */
export function checkpointToSpliceAt(base: Recording, checkpoint: number): SpliceAt {
  if (checkpoint < 0) {
    throw new Error(`checkpointToSpliceAt: checkpoint must be >= 0, got ${checkpoint}`);
  }
  let remaining = checkpoint;
  for (let page = 0; page < base.pages.length; page++) {
    const len = base.pages[page]!.steps.length;
    if (remaining < len) return { page, step: remaining + 1 };
    remaining -= len;
  }
  const total = base.pages.reduce((n, p) => n + p.steps.length, 0);
  throw new Error(
    `checkpointToSpliceAt: checkpoint ${checkpoint} is out of range for a ${total}-step base recording`,
  );
}
