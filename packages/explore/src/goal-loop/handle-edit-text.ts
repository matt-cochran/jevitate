/**
 * `edit_text` (#148): an edit INSIDE rich text — the generator proposes an anchored edit, code
 * validates it (see ../rich-text.ts) and the shared page function performs it, never a whole retype.
 * The goal loop's edit handler, moved out of `explore.ts` unchanged (#232).
 */

import { describeTextEdit } from "@jevitate/interpreter";
import { act } from "../act.js";
import { planTextEdit, readEditableText } from "../rich-text.js";
import { boundSecretField } from "../secret-fields.js";
import type { RunContext } from "./context.js";
import { firstLine } from "./helpers.js";
import type { ActStep, Flow } from "./step.js";

export async function handleEditText(ctx: RunContext, step: ActStep): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, decision, record, control, at } = step;
  const planned =
    boundSecretField(control, cfg.secretFields) !== null
      ? { refused: "a bound secret field is never edited as rich text" }
      : await readEditableText(ctx.page, control).then((currentText) =>
          currentText === null
            ? { refused: "the element's text could not be read" }
            : planTextEdit(cfg.gen, { goal: cfg.goal, control, currentText, history: ctx.history, secrets: ctx.secrets }),
        ).catch((e: unknown) => ({ refused: `edit generation unavailable: ${firstLine(e)}` }));
  if ("refused" in planned) {
    ctx.history.push(`edit in ${control.name || control.summary} refused: ${planned.refused}`);
    record(false, planned.refused, { origin: "engine" });
  } else {
    const r = await act(cfg.actor, { op: "edit_text", control, edit: planned.edit });
    const what = describeTextEdit(planned.edit);
    if (r.ok) {
      ctx.recorder.editText(control.descriptor, planned.edit, at);
      ctx.noteMutation(`edit ${control.name}`, control.descriptor, snap.signature, at);
      ctx.tracker.countAction();
      ctx.history.push(`${what} in ${control.summary.slice(0, 80)}`);
      ctx.cleared(control);
    } else {
      ctx.history.push(`edit failed: ${ctx.failNote(r.reason, control)}`);
    }
    record(r.ok, r.ok ? what : ctx.failNote(r.reason, control), planned.edit.value === undefined ? {} : { value: planned.edit.value });
    if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) {
      ctx.lastActedOp = decision.op;
      return "stop";
    }
  }
  ctx.lastActedOp = decision.op;
  return "continue";
}
