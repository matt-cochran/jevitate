/** `createRunContext`: the page-changing action note and the first navigation's network evidence (#128) (#500: moved verbatim out of `context.ts`). */
import type { MutableRunContext } from "./types.js";

export function initMutation(ctx: MutableRunContext): void {
  ctx.noteMutation = (
    label: string,
    descriptor: unknown,
    before: string,
    at: number,
    input?: { readonly field: string; readonly value: string },
    linkFromRoute: string | null = null,
    clickFromRoute: string | null = null,
  ): void => {
    // An input change (type/select/send/upload) makes a repeat send something new — unless it set
    // the same value again (#123): the guard compares the values.
    if (!label.startsWith("click ")) ctx.sideEffects.inputChanged(input?.field, input?.value);
    ctx.deltas?.acted({ label, recordIndex: ctx.recorder.stepCount - 1, step: ctx.transcript.nextStep, ...(input === undefined ? {} : { value: input.value }) });
    ctx.failedActs.succeeded();
    if (!label.startsWith("type ")) {
      ctx.typeNoEffect = null;
      ctx.typeCredit = null;
    }
    ctx.track.lastMutation = { at, before, seenBefore: new Set(ctx.seen), label, recordIndex: ctx.recorder.stepCount - 1, sawNewState: false, linkFromRoute, clickFromRoute };
    ctx.refusedSinceMutation = 0;
    ctx.scrollsSinceMutation = 0;
    ctx.track.lastRecordedTarget = JSON.stringify(descriptor);
    ctx.statusAfter = label;
  };

  // #128: real network evidence for the FIRST navigation, preferred over whatever `page.goto`
  // itself reports — a refused connection can still surface as a bare navigation timeout.
  ctx.firstNavNetError = null;
  ctx.onFirstNavRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
    const text = req.failure()?.errorText;
    if (text !== undefined) ctx.firstNavNetError = text;
  };
  ctx.firstNavFailed = false;
}
