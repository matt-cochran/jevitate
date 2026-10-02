/**
 * Fields code types itself (#72, #111, #281): an empty bound secret field before its form is
 * submitted, a chosen `type` into a bound secret field (the real value, never shown), and a field
 * bound to a type fixture (the file's exact text). Moved out of `explore.ts` unchanged (#232).
 */

import { act } from "../act.js";
import { redactText } from "../redact.js";
import {
  boundSecretField,
  secretFieldNeedsValue,
  secretFieldValue,
  secretFieldsToFill,
  secretPlaceholder,
} from "../secret-fields.js";
import { boundTypeFixture, typeFixturePlaceholder } from "../type-fixtures.js";
import type { RunContext } from "./context.js";
import { keyOf, submitsAForm } from "./helpers.js";
import type { ActStep, Flow } from "./step.js";

export async function handleCodeTypedField(ctx: RunContext, step: ActStep): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, decision, record, control, at } = step;
  // An EMPTY bound secret field (#111) is typed by code on its own — before a submit of its form,
  // or once a validation message names it: the model cannot see the value and was seen never
  // choosing `type` on it (a signup stuck on "Password: Please fill out this field"). Same
  // guarantees as the chosen-`type` path below: placeholder only, Recording `{ redacted: true }`.
  {
    const submitting = decision.op === "click" && submitsAForm(control) ? control : null;
    const due = secretFieldsToFill(snap.controls, cfg.secretFields, {
      submitting,
      status: ctx.status,
      exclude: decision.op === "type" ? control : null,
    });
    for (const { control: field, field: binding, why } of due) {
      if (!ctx.tracker.mayAct() || !(await secretFieldNeedsValue(ctx.page, field))) continue;
      const t = ctx.now();
      const value = secretFieldValue(binding, t);
      const placeholder = secretPlaceholder(binding);
      const r = await act(cfg.actor, { op: "type", control: field, value });
      const cause = why === "submit" ? `before submitting with ${control.name || control.summary}` : "a validation message names it";
      if (r.ok) {
        ctx.recorder.fill(field.descriptor, { redacted: true, length: value.length }, t);
        ctx.noteMutation(`type ${field.name}`, field.descriptor, snap.signature, t);
        ctx.tracker.countAction();
        ctx.history.push(`typed ${placeholder} into the empty ${field.name} (bound secret, typed by code — ${cause})`);
      } else {
        ctx.history.push(`type into ${field.name} failed: ${(r.reason ?? "?").split(value).join(placeholder)}`);
      }
      record(r.ok, r.ok ? `typed ${placeholder} (bound secret, typed by code — ${cause})` : (r.reason ?? "").split(value).join(placeholder), {
        op: "type",
        control: field,
        strategy: "secret-field",
        value: placeholder,
      });
    }
  }

  // A bound secret field (#72): code types the real value (a TOTP code is computed now); the model,
  // history and transcript see only the placeholder, the Recording `{ redacted: true }`.
  const bound = decision.op === "type" ? boundSecretField(control, cfg.secretFields) : null;
  if (bound !== null) {
    const value = secretFieldValue(bound, at);
    const placeholder = secretPlaceholder(bound);
    const r = await act(cfg.actor, { op: "type", control, value });
    if (r.ok) {
      ctx.recorder.fill(control.descriptor, { redacted: true, length: value.length }, at);
      ctx.noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value });
      ctx.tracker.countAction();
      ctx.history.push(`typed ${placeholder} into ${control.name} (bound secret, typed by code)`);
    } else {
      ctx.history.push(`type failed: ${(r.reason ?? "?").split(value).join(placeholder)}`);
    }
    record(r.ok, r.ok ? `typed ${placeholder} (bound secret, typed by code)` : (r.reason ?? "").split(value).join(placeholder), {
      value: placeholder,
    });
    ctx.lastActedOp = decision.op;
    if (!r.ok && (await ctx.noteFailedAct(control, (r.reason ?? "").split(value).join(placeholder)))) return "stop";
    return "continue";
  }

  // #281: a field bound to a type fixture — code types the file's exact text (line breaks kept,
  // never capped, never generated). The Recording keeps it so a Journey replays it exactly,
  // unless it holds a registered run secret (then `{ redacted: true }`, like a bound secret).
  const fixtureBinding = decision.op === "type" ? boundTypeFixture(control, cfg.typeFixtures) : null;
  if (fixtureBinding !== null) {
    const value = fixtureBinding.text;
    const placeholder = typeFixturePlaceholder(fixtureBinding);
    const holdsSecret = ctx.secrets.some((sec) => sec !== "" && value.includes(sec));
    const r = await act(cfg.actor, { op: "type", control, value });
    if (r.ok) {
      ctx.recorder.fill(control.descriptor, holdsSecret ? { redacted: true, length: value.length } : value, at);
      ctx.valueLog.typed(control.name || control.summary, value);
      ctx.save.noteTyped(control.name || control.summary, value);
      ctx.observed.noteOwnInput(value);
      ctx.noteMutation(`type ${control.name}`, control.descriptor, snap.signature, at, { field: keyOf(control), value });
      ctx.tracker.countAction();
      ctx.cleared(control);
      ctx.history.push(`typed ${placeholder} into ${control.name} (type fixture, typed verbatim by code)`);
    } else {
      ctx.history.push(`type failed: ${redactText((r.reason ?? "?").split(value).join(placeholder), ctx.secrets)}`);
    }
    record(r.ok, r.ok ? `typed ${placeholder} (type fixture, typed verbatim by code)` : redactText((r.reason ?? "").split(value).join(placeholder), ctx.secrets), {
      value: placeholder,
    });
    ctx.lastActedOp = decision.op;
    return "continue";
  }
  return "next";
}
