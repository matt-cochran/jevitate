/**
 * `type` / `select` of a form value (#71, #123, #242, #281): the value generator supplies the text
 * (a HELPER — when it is unavailable the step fails and the run goes on), a type that changed nothing
 * else is probed, and a search-like field is submitted once retyping fired nothing. The goal loop's
 * fill handler, moved out of `explore.ts` unchanged (#232).
 */

import { act } from "../act.js";
import { sendable } from "../actions.js";
import { isCredentialField } from "../auth-completion.js";
import { capFormText } from "../fill.js";
import { monitorFor } from "../page-monitor.js";
import { redactContext } from "../redact.js";
import { backgroundEndpoints } from "../stuck-actions.js";
import type { RunContext } from "./context.js";
import { MAX_TYPE_NO_EFFECT, firstLine, keyOf, quote, searchLike, stateBesides } from "./helpers.js";
import { FORM_TEXT_MAX_CHARS } from "./limits.js";
import type { Flow } from "./step.js";
import { type ActStep } from "./step.js";

export async function handleFill(ctx: RunContext, step: ActStep): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, decision, record, control, at } = step;
  // The generator supplies the text/option (never the model's choice head). It is a HELPER:
  // when it is unavailable the step fails (recorded, visible to the model) and the run goes on.
  let text: string | null;
  let rejected: string | undefined;
  let source: "goal" | "model" | undefined;
  try {
    ({ text, rejected, source } = await ctx.fillHelper.valueFor({
      fieldLabel: control.name || control.summary,
      goal: cfg.goal,
      visibleContext: snap.controls.map((c) => c.summary).join("; "),
      history: ctx.history,
      secrets: ctx.secrets,
      // A text field's value is field-scoped and checked before it is typed (#71); in an
      // add-another flow it is the next item, not one already submitted into this field (#123).
      ...(decision.op === "type"
        ? {
            field: { tag: control.tag, inputType: control.inputType },
            alreadyUsed: ctx.valueLog.used(control.name || control.summary),
            // #366: only a repeat into this same live field is refused (a reopened dialog's field is new),
            // and never a literal the field's own prompt asks for ("Type CONFIRM to continue").
            liveUsed: ctx.valueLog.liveUsed(control.name || control.summary),
            prompt: [control.scope, control.heading, step.visibleText].filter((t): t is string => typeof t === "string" && t !== "").join("\n"),
          }
        : {}),
    }));
  } catch (e) {
    const reason = `value generation unavailable: ${firstLine(e)}`;
    ctx.history.push(`${decision.op} skipped: ${reason}`);
    record(false, reason, { origin: "engine" });
    ctx.lastActedOp = decision.op;
    return "continue";
  }
  if (rejected !== undefined) {
    // Not a value for this one field (an essay, a JSON map, a `Label:` echo…): a failed act the
    // model sees in its history, never typed.
    const reason = `typed value rejected: ${rejected}`;
    ctx.history.push(`type into ${control.name} failed: ${reason} — the value must be only what goes in this one field`);
    record(false, reason, { origin: "engine" });
    ctx.lastActedOp = decision.op;
    return "continue";
  }
  if (text === null) {
    // The generator will not honestly supply a required value → never guess.
    ctx.blockers.failClosed = `no value for field ${quote(control.name || control.summary, 80)} (the value generator returned none)`;
    record(false, "no value available (fail-closed)", { origin: "engine" });
    ctx.stop = "blocked";
    return "stop";
  }
  // Free-text form values are bounded too (dogfood: 2–3k-char markdown essays in "Rationale").
  // #281: a value the goal states verbatim is typed as stated (its line breaks kept), never capped.
  if (decision.op === "type" && source !== "goal" && (control.tag === "textarea" || control.inputType === "text" || control.inputType === "")) {
    text = capFormText(text, FORM_TEXT_MAX_CHARS, control.tag === "textarea");
  }
  // #242: retyping a field whose last type(s) changed nothing else — a search-like field is
  // submitted this time (it searches on Enter); any other field ends the run once it is stuck.
  const retypes = decision.op === "type" && ctx.typeNoEffect?.key === keyOf(control) ? ctx.typeNoEffect.count : 0;
  if (retypes >= MAX_TYPE_NO_EFFECT) {
    const reason = `stuck: typed into ${quote(control.name || control.summary, 60)} ${retypes} times in a row: nothing changed but its own value (no request, nothing else on the page)`;
    record(false, reason, { origin: "engine" });
    ctx.incomplete = reason;
    ctx.stop = "no-progress";
    return "stop";
  }
  const submitSearch = retypes >= 1 && searchLike(control);
  const typedAt = ctx.now();
  const typedBackground = decision.op === "type" ? backgroundEndpoints(monitorFor(ctx.page), typedAt) : new Set<string>();
  const typedState = stateBesides(snap, keyOf(control));
  const r = submitSearch
    ? await act(cfg.actor, { op: "send", control, value: text, candidates: snap.controls })
    : await act(cfg.actor, { op: decision.op, control, value: text });
  if (r.ok && submitSearch) {
    ctx.recorder.fill(control.descriptor, text, at);
    const via = r.submittedVia;
    if (via !== undefined && via.kind === "click") ctx.recorder.click(via.control.descriptor, ctx.now());
    else ctx.recorder.press("Enter", control.descriptor, ctx.now());
    ctx.valueLog.typed(control.name || control.summary, text);
    ctx.valueLog.submitted();
    ctx.noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: text });
    ctx.tracker.countAction();
    ctx.fillHelper.commit();
    ctx.typeNoEffect = null;
    ctx.typeCredit = null;
    ctx.history.push(
      `submitted ${quote(control.name || control.summary, 60)} with ${via?.kind === "click" ? `its ${quote(via.control.name, 40)} button` : "Enter"} (typing alone fired nothing) — searched for ${quote(text, 80)}`,
    );
    ctx.cleared(control);
    record(true, "typed and submitted (typing alone fired nothing)", { value: text });
    ctx.lastActedOp = decision.op;
    return "continue";
  }
  if (r.ok) {
    if (decision.op === "type") {
      ctx.typeProbe = { key: keyOf(control), label: quote(control.name || control.summary, 60), at: typedAt, background: typedBackground, state: typedState };
      // A form field (not a message composer) is submitted with its form's own button; retyping
      // it is a correction, not the chat anti-pattern — so only composers are tracked.
      ctx.recorder.fill(control.descriptor, text, at);
      ctx.valueLog.typed(control.name || control.summary, text);
      if (!ctx.isBound(control) && !isCredentialField(control) && !sendable(control)) {
        ctx.save.noteTyped(control.name || control.summary, text);
        // #239: until a write after it succeeds, the field shows what the run entered — not grounds.
        ctx.observed.noteOwnInput(text);
      }
    } else ctx.recorder.select(control.descriptor, text, at);
    ctx.noteMutation(`${decision.op} ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: text });
    ctx.tracker.countAction();
    ctx.fillHelper.commit();
    ctx.history.push(`${decision.op === "type" ? "typed into" : "selected in"} ${control.name}`);
    ctx.cleared(control);
  } else {
    ctx.history.push(`${decision.op} failed: ${ctx.failNote(r.reason, control)}${attempted(ctx, control, text)}`);
  }
  record(r.ok, r.ok ? r.reason : `${ctx.failNote(r.reason, control)}${attempted(ctx, control, text)}`, { value: text });
  if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) {
    ctx.lastActedOp = decision.op;
    return "stop";
  }
  return "next";
}

/**
 * #332: the value a failed type/select tried, for the history the model sees and the step's reason
 * ("Malformed value" alone hides that `8:00 AM` was typed into a time input). A credential field's
 * value is never shown, and registered secrets are masked.
 */
function attempted(ctx: RunContext, control: ActStep["control"], text: string): string {
  if (isCredentialField(control)) return " (the value is redacted)";
  return ` (tried ${quote(redactContext(text, ctx.secrets), 80)})`;
}
