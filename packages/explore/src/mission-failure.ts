import type { Page } from "playwright";
import type { GenerationPort } from "@jevitate/ai-core";
import type { MissionFailure } from "@jevitate/domain";

/**
 * The mission-side half of "a mission's outcome is a typed result, never a throw":
 *
 *  - `CrashWatch` notices a page crash / page close / browser disconnect as it happens, so an
 *    engine failure can be classified from EVIDENCE (not guessed from an error message);
 *  - `describeFailure` turns whatever was thrown into a `MissionFailure` (crash signals win);
 *  - `tryTriage` makes the defect explanation a HELPER step: when it cannot be generated the
 *    defect is still recorded, with the explanation marked `unavailable` and the reason.
 */

/** A defect's explanation — available, or explicitly unavailable with why. */
export type Triage =
  | { readonly status: "available"; readonly summary: string; readonly likelyCause: string }
  | { readonly status: "unavailable"; readonly reason: string };

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

/**
 * Generates the triage narrative from an already-redacted failure summary + URL (guardrail #3:
 * never raw form state). A generation failure is DATA: `{ status: "unavailable", reason }`.
 */
export async function tryTriage(
  generation: GenerationPort,
  input: { readonly failureSummary: string; readonly url: string },
): Promise<Triage> {
  try {
    const r = await generation.generate("triage.narrative", input);
    return { status: "available", summary: r.output.summary, likelyCause: r.output.likelyCause };
  } catch (e) {
    return { status: "unavailable", reason: `triage generation failed: ${messageOf(e)}` };
  }
}

/** Crash evidence observed on a page during a run. */
export interface CrashSignals {
  readonly pageCrashed: boolean;
  readonly pageClosed: boolean;
  readonly browserDisconnected: boolean;
}

/**
 * Watches one page for engine-level failures: Playwright's `crash` (renderer died — e.g. OOM),
 * `close`, and the browser's `disconnected`. Listeners attach at construction.
 */
export class CrashWatch {
  #pageCrashed = false;
  #pageClosed = false;
  #browserDisconnected = false;

  constructor(page: Page) {
    page.on("crash", () => {
      this.#pageCrashed = true;
    });
    page.on("close", () => {
      this.#pageClosed = true;
    });
    const browser = page.context().browser();
    browser?.on("disconnected", () => {
      this.#browserDisconnected = true;
    });
  }

  signals(): CrashSignals {
    return {
      pageCrashed: this.#pageCrashed,
      pageClosed: this.#pageClosed,
      browserDisconnected: this.#browserDisconnected,
    };
  }
}

/**
 * Classifies an engine failure. Crash EVIDENCE wins over the thrown message: a renderer crash
 * surfaces in Playwright as a generic "Target crashed"/"page closed" error, and the evidence is
 * what attribution needs.
 */
export function describeFailure(e: unknown, signals: CrashSignals): MissionFailure {
  const message = messageOf(e);
  const stack = e instanceof Error && e.stack !== undefined ? e.stack : undefined;
  const kind: MissionFailure["kind"] = signals.pageCrashed
    ? "page-crash"
    : signals.browserDisconnected
      ? "browser-disconnected"
      : signals.pageClosed
        ? "page-closed"
        : "exception";
  return { kind, message, ...(stack === undefined ? {} : { stack }) };
}
