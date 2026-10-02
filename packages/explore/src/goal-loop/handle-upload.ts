/**
 * `upload`: the mission fixture into a file field (act fails closed without one; the recorded path
 * goes through the redaction seam). The goal loop's upload handler, moved out of `explore.ts`
 * unchanged (#232).
 */

import type { ValueOrVar } from "@jevitate/recording";
import { act } from "../act.js";
import { redactText } from "../redact.js";
import type { RunContext } from "./context.js";
import type { ActStep, Flow } from "./step.js";

export async function handleUpload(ctx: RunContext, step: ActStep): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, decision, record, control, at } = step;
  // upload — act fails closed without a fixture.
  const r = await act(cfg.actor, { op: "upload", control, fixture: ctx.fixture });
  if (r.ok && ctx.fixture !== null) {
    // The recorded path goes through the shared redaction seam: a path that
    // contains a registered secret is recorded redacted (replay then fails
    // closed) rather than persisting the secret into the artifact.
    const recordedFile: ValueOrVar =
      redactText(ctx.fixture, ctx.secrets) === ctx.fixture
        ? { redacted: false, value: ctx.fixture }
        : { redacted: true, length: ctx.fixture.length };
    ctx.recorder.upload(control.descriptor, recordedFile, at);
  ctx.noteMutation(`upload into ${control.name}`, control.descriptor, snap.signature, at);
    ctx.tracker.countAction();
    ctx.history.push(`uploaded the fixture into ${control.name}`);
    ctx.fixtureAttached = true;
    ctx.cleared(control);
  } else {
    ctx.history.push(`upload failed: ${ctx.failNote(r.reason, control)}`);
  }
  record(r.ok, r.ok ? r.reason : ctx.failNote(r.reason, control));
  if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) {
    ctx.lastActedOp = decision.op;
    return "stop";
  }
  return "next";
}
