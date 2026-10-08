/**
 * What the next decision sees (#90, #122, #123, #158, #168, #188, #207, #223, #242, #272): the
 * candidate controls (minus the withheld ones), the conversation and form bookkeeping, the page's
 * text and fields as grounding evidence, and the read-only guard's blocked writes. Moved out of
 * `explore.ts` unchanged (#232).
 */

import { descriptorToLocator } from "@jevitate/recorder";
import { controlFields } from "../answer.js";
import { readPageHeadings, readPageText } from "../conversation.js";
import { coveredByInterceptors } from "../occlusion.js";
import { monitorFor } from "../page-monitor.js";
import { redactText } from "../redact.js";
import { readEditableText } from "../rich-text.js";
import type { Control } from "../snapshot.js";
import { requestsStartedSince } from "../stuck-actions.js";
import type { RunContext } from "./context.js";
import { isActionOrChromeName, keyOf, safePath, stateBesides } from "./helpers.js";
import type { Perceived, StepInput } from "./step.js";

/** The decision's inputs besides the page itself. */
export type PageView = Pick<StepInput, "modelControls" | "keys" | "offered" | "unsubmitted" | "visibleText">;

/** Builds the page view the next decision is made on (and records what the read-only guard blocked). */
export async function viewPage(ctx: RunContext, step: Perceived): Promise<PageView> {
  const { perception, snap } = step;
  // #90 — an interceptor proven by a real click failure stays blocked only while the page it was
  // proven on is still up; a re-render/navigation may have removed or moved it.
  if (ctx.blockedSinceSignature !== null && snap.signature !== ctx.blockedSinceSignature) {
    ctx.blockedInterceptors = [];
    ctx.blockedSinceSignature = null;
  }
  let modelControls = snap.controls;
  if (ctx.blockedInterceptors.length > 0) {
    const covered = new Set<number>();
    for (const c of snap.controls) {
      const loc = descriptorToLocator(ctx.page, c.descriptor);
      const hit = await loc.evaluate(coveredByInterceptors, ctx.blockedInterceptors).catch(() => false);
      if (hit) covered.add(c.index);
    }
    if (covered.size > 0) modelControls = snap.controls.filter((c) => !covered.has(c.index));
  }
  // #168 — a control the safety policy already refused this run is withheld from now on (never
  // re-offered, so the model cannot re-choose it and burn another action on the same refusal).
  if (ctx.refusedKeys.size > 0) modelControls = modelControls.filter((c) => !ctx.refusedKeys.has(keyOf(c)));
  // #272 / #294 — a target whose action failed twice as covered / unreachable is withheld until
  // an action succeeds (the model was told why).
  {
    const withheld = ctx.failedActs.withheld();
    if (withheld.size > 0) modelControls = modelControls.filter((c) => !withheld.has(keyOf(c)));
  }

  // Conversation bookkeeping (independent code). A navigation takes any typed text with it;
  // a field that left the page took its text too.
  const path = safePath(snap.url);
  if (ctx.lastPath !== null && path !== ctx.lastPath) {
    ctx.failedActs.succeeded();
    ctx.unsent.submitted();
    ctx.valueLog.submitted();
    ctx.save.reset();
  }
  ctx.lastPath = path;
  // #366: a text field that left the page and came back empty (a dialog reopened) is a new instance.
  ctx.valueLog.observe(
    snap.controls
      .filter((c) => c.tag === "input" || c.tag === "textarea" || c.richText === true)
      .map((c) => ({ label: c.name || c.summary, value: c.value })),
  );
  if (ctx.listsSeveral && ctx.prevSignature !== null && ctx.prevSignature !== snap.signature) {
    const next = ctx.nextFrom.get(snap.signature);
    if (next !== undefined) {
      ctx.history.push(
        `this page is in the same state as earlier, where you went on with: ${next.join(", ")} — the goal lists several items: if one is still to do, the same steps apply to it`,
      );
    }
  }
  ctx.prevSignature = snap.signature;
  const keys = new Map<string, Control>(snap.controls.map((c) => [keyOf(c), c]));
  // #242: what the last plain `type` did besides setting its own field's value.
  if (ctx.typeProbe !== null) {
    const p = ctx.typeProbe;
    ctx.typeProbe = null;
    const sent = requestsStartedSince(monitorFor(ctx.page), p.at, p.background);
    const stateSame = stateBesides(snap, p.key) === p.state;
    if (sent.length === 0 && stateSame) {
      // A held credit whose endpoints turned out to be background polling: that type changed
      // nothing either — the streak goes on (it and this one), never restarts.
      const credit = ctx.typeCredit?.key === p.key && ctx.typeCredit.endpoints.every((e) => p.background.has(e)) ? ctx.typeCredit : null;
      ctx.typeCredit = null;
      const count: number = credit !== null ? credit.count + 2 : ctx.typeNoEffect?.key === p.key ? ctx.typeNoEffect.count + 1 : 1;
      ctx.typeNoEffect = { key: p.key, count };
      ctx.history.push(
        `typing into ${p.label} changed nothing but its own value (no request, nothing else on the page changed) — ` +
          "submit it (its form's button, or Enter) or do something else; typing it again will not help",
      );
    } else {
      // Only requests, nothing else on the page: held until the next type tells polling apart.
      ctx.typeCredit = stateSame ? { key: p.key, count: ctx.typeNoEffect?.key === p.key ? ctx.typeNoEffect.count : 0, endpoints: sent } : null;
      ctx.typeNoEffect = null;
    }
  }
  ctx.unsent.retain(new Set(keys.keys()));
  if (ctx.offerBaseline !== null) {
    const before = ctx.offerBaseline;
    ctx.offeredKeys = new Set([...keys.keys()].filter((k) => !before.has(k)));
    ctx.offerBaseline = null;
  }
  const offered = new Set(snap.controls.filter((c) => ctx.offeredKeys.has(keyOf(c))).map((c) => c.index));
  const unsubmitted = new Set(snap.controls.filter((c) => ctx.unsent.wouldRepeat(keyOf(c))).map((c) => c.index));

  // #207: a form field's current value is page content too (grounded as such, never as page text).
  const visibleText = await readPageText(ctx.page, ctx.secrets);
  // #223: a rich-text (contenteditable) control's text is its value too, groundable like an input's.
  const richFields: { label: string; value: string }[] = [];
  for (const c of snap.controls.filter((x) => x.richText === true).slice(0, 5)) {
    const t = (await readEditableText(ctx.page, c))?.trim() ?? "";
    if (t !== "") richFields.push({ label: c.name.trim() || c.role || c.tag, value: redactText(t, ctx.secrets) });
  }
  try {
    ctx.chrome.observe(new URL(snap.url).pathname, snap.controls);
  } catch {
    // an unparsable URL: no chrome evidence from it
  }
  ctx.observed.add(snap.url, visibleText, [...controlFields(snap.controls), ...richFields], {
    ...(await readPageHeadings(ctx.page, ctx.secrets)),
    // #223: the action / label names (a quote made only of them is a label, not an answer) and
    // the document's status (an answer on a 404 page is no answer). A link that is page content
    // (in the main content, a list, a table, a card) is NOT one: its text may be the answer.
    controlNames: snap.controls.filter((c) => isActionOrChromeName(c, ctx.chrome)).map((c) => c.name),
    // #229: the content links' text, in page order (a list's entries: "the first item").
    contentLinks: snap.controls.filter((c) => !isActionOrChromeName(c, ctx.chrome)).map((c) => c.name),
    // #238: where the page's navigation leads — the first page's is the absence-answer coverage floor.
    navLinks: snap.controls
      .filter((c) => c.role === "link" && (c.landmark === "navigation" || c.landmark === "banner"))
      .flatMap((c) => (typeof c.href === "string" && c.href !== "" ? [c.href] : [])),
    ...(ctx.documentStatus.has(ctx.docKey(ctx.page.url())) ? { status: ctx.documentStatus.get(ctx.docKey(ctx.page.url()))! } : {}),
  });
  ctx.noteReplyText(snap.url, visibleText);
  // #424: the run's depth — every page state the loop decides on.
  ctx.depth.noteState(snap.signature, snap.url);

  // #158 — the write requests the read-only guard aborted since the last decision: recorded
  // (jevitate's own refusal) and told to the model.
  {
    const blocked = ctx.readOnly?.drain() ?? [];
    if (blocked.length > 0) {
      const what = [...new Set(blocked.map((b) => `${b.method} ${b.path}`))].join(", ");
      // #194: a blocked write off the --allow origins says how to declare or exempt it.
      const hints = [...new Set(blocked.flatMap((b) => (b.hint === undefined ? [] : [b.hint])))];
      const note =
        `blocked write request(s) ${redactText(what, ctx.secrets)}: ${
          ctx.readOnly?.mode === "no-destructive"
            ? "a destructive write needs --allow-writes on a goal with no success check — report what you found instead"
            : "this find-out goal is read-only — find the answer without changing anything"
        }` +
        (hints.length === 0 ? "" : ` (${redactText(hints.join("; "), ctx.secrets)})`);
      ctx.history.push(note);
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "read-only",
        actOk: false,
        reason: note,
        origin: "engine",
        snapshot: snap,
        timing: perception.timing,
      });
    }
  }
  return { modelControls, keys, offered, unsubmitted, visibleText };
}
