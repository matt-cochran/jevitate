/**
 * Options-aware `select` (J-5, #273): the generator sees the real options and code selects only an
 * option the page actually has — never the one already selected, never a placeholder unless the goal
 * asks to clear the field. The goal loop's select handler, moved out of `explore.ts` unchanged (#232).
 */

import { act } from "../act.js";
import type { Decision } from "../decide.js";
import { matchOption } from "../fill.js";
import { CLEARS_FIELD, isPlaceholderOption } from "../select-choice.js";
import type { RunContext } from "./context.js";
import { firstLine, keyOf, quote } from "./helpers.js";
import type { ActStep, Flow } from "./step.js";

export async function handleSelectOption(ctx: RunContext, step: ActStep, op: Decision["op"]): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, record, control, at } = step;
  // The caller checked that the control has options (`control.options.length > 0`).
  const options = control.options as readonly string[];
  // Options-aware select (J-5): the generator sees the real options, and code selects only an
  // option the page actually has — never a guessed value.
  // #273: never the option already selected (a no-op), never a placeholder ("—", "Select…")
  // unless the goal asks to clear the field.
  const current = control.selected ?? null;
  const clearing = CLEARS_FIELD.test(cfg.goal);
  const choices = options.filter((o) => o !== current && (clearing || !isPlaceholderOption(o)));
  const untried = (): string => choices.map((o) => quote(o, 60)).join(", ");
  if (choices.length === 0) {
    const reason = `no other option to choose in ${control.name || control.summary}${current === null ? "" : ` (${quote(current, 60)} is already selected)`}`;
    ctx.history.push(`select refused: ${reason}`);
    record(false, reason, { origin: "engine" });
    ctx.lastActedOp = op;
    return "continue";
  }
  let text: string | null;
  try {
    ({ text } = await ctx.fillHelper.valueFor({
      fieldLabel: control.name || control.summary,
      goal: cfg.goal,
      visibleContext: snap.controls.map((c) => c.summary).join("; "),
      history: ctx.history,
      secrets: ctx.secrets,
      options: choices,
    }));
  } catch (e) {
    const reason = `value generation unavailable: ${firstLine(e)}`;
    ctx.history.push(`select skipped: ${reason}`);
    record(false, reason, { origin: "engine" });
    ctx.lastActedOp = op;
    return "continue";
  }
  const named = text === null ? null : matchOption(text, options);
  if (named !== null && !choices.includes(named)) {
    // The current option (or a placeholder) again: never acted — the page would not change.
    ctx.fillHelper.commit();
    const why = named === current ? `${quote(named, 60)} is already selected` : `${quote(named, 60)} is a placeholder, not a choice`;
    const reason = `select refused: ${why} in ${control.name || control.summary} — options not tried: ${untried()}`;
    ctx.history.push(reason);
    record(false, reason, { origin: "engine", value: named });
    ctx.lastActedOp = op;
    return "continue";
  }
  const option = named;
  if (option === null) {
    ctx.fillHelper.commit();
    const reason = `no valid option chosen for ${control.name} (fail-closed) — wanted ${text === null ? "nothing" : quote(text, 60)}; options: ${options.map((o) => quote(o, 60)).join(", ")}`;
    ctx.blockers.failClosed = `no valid option for field ${quote(control.name || control.summary, 80)} (fail-closed)`;
    ctx.history.push(`select failed: ${reason}`);
    record(false, reason, { origin: "engine" });
    ctx.lastActedOp = op;
    return "continue";
  }
  const r = await act(cfg.actor, { op: "select", control, value: option });
  if (r.ok) {
    ctx.recorder.select(control.descriptor, option, at);
    ctx.noteMutation(`select ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value: option });
    ctx.tracker.countAction();
    ctx.fillHelper.commit();
    ctx.history.push(`selected ${quote(option, 80)} in ${control.name}`);
    ctx.cleared(control);
  } else {
    ctx.history.push(`select failed: ${ctx.failNote(r.reason, control)}`);
  }
  record(r.ok, r.ok ? r.reason : ctx.failNote(r.reason, control), { value: option });
  ctx.lastActedOp = op;
  if (!r.ok && (await ctx.noteFailedAct(control, r.reason))) return "stop";
  return "continue";
}
