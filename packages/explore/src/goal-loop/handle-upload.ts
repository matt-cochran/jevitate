/**
 * `upload`: the mission fixture into a file field (act fails closed without one; the recorded path
 * goes through the redaction seam). The goal loop's upload handler, moved out of `explore.ts`
 * unchanged (#232).
 */

import type { ValueOrVar } from "@jevitate/recording";
import { relative } from "node:path";
import { act } from "../act.js";
import { redactText } from "../redact.js";
import { boundUploadFixture, TypeFixtureSpecError } from "../type-fixtures.js";
import type { RunContext } from "./context.js";
import type { ActStep, Flow } from "./step.js";

export async function handleUpload(ctx: RunContext, step: ActStep): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, decision, record, control, at } = step;
  let fixture = ctx.fixture;
  let boundDescriptor: string | null = null;
  try {
    const bound = boundUploadFixture(control, ctx.uploadFixtures);
    if (bound !== null) {
      if (ctx.attachedUploadFixtures.has(bound.descriptor)) {
        const reason = `upload fixture binding already attached: ${bound.descriptor}`;
        ctx.history.push(`upload failed: ${reason}`);
        record(false, reason);
        return "next";
      }
      fixture = bound.path;
      boundDescriptor = bound.descriptor;
    }
  } catch (err) {
    const reason = err instanceof TypeFixtureSpecError ? err.message : String(err);
    ctx.history.push(`upload failed: ${reason}`);
    record(false, reason);
    return "next";
  }
  // upload — act fails closed without a fixture.
  const r = await act(cfg.actor, { op: "upload", control, fixture, fixtureRoot: ctx.fixtureRoot });
  if (r.ok && fixture !== null) {
    // The recorded path goes through the shared redaction seam: a path that
    // contains a registered secret is recorded redacted (replay then fails
    // closed) rather than persisting the secret into the artifact.
    const recordedPath = relative(ctx.fixtureRoot!, fixture);
    const recordedFile: ValueOrVar =
      redactText(fixture, ctx.secrets) === fixture
        ? { redacted: false, value: recordedPath }
        : { redacted: true, length: fixture.length };
    ctx.recorder.upload(control.descriptor, recordedFile, at);
  ctx.noteMutation(`upload into ${control.name}`, control.descriptor, snap.signature, at);
    ctx.tracker.countAction();
    ctx.history.push(`uploaded the fixture into ${control.name}`);
    ctx.fixtureAttached = true;
    if (boundDescriptor !== null) ctx.attachedUploadFixtures.add(boundDescriptor);
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
