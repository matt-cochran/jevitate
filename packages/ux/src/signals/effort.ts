// effort.ts — avoidable effort the run itself measured (#642). No model: it reads the steps the run
// took and the screens it saw.
//
//   repeated advance — 3+ consecutive successful clicks of the same advance control (Continue /
//                      Next / Confirm / OK…) on one route, with no input between them, each moving
//                      the page on (its text changed): a flow that makes the user confirm the same
//                      thing again and again. It slows the job; it never blocks it, so it is never
//                      a defect.
import { routeOf } from "../route.js";
import type { UxFinding } from "../types.js";
import { makeSignalFinding } from "./finding.js";
import { labelOf } from "./shared.js";
import type { RunSignalCapture, SignalScreen, SignalStep } from "./types.js";

/** The fewest consecutive advance clicks reported as avoidable steps. */
export const REPEATED_ADVANCE_MIN = 3;

/** The name of a control that only moves a flow on. */
const ADVANCE_NAME = /^(continue|next|next step|confirm|ok|okay|proceed|yes|go on)$/i;

/** Ops that enter or change something — a step between advances that does real work. */
const INPUT_OPS = new Set(["type", "select", "send", "upload", "fill", "edit_text", "check", "uncheck"]);

/** Ops that neither act nor enter anything (looking around does not break a streak). */
const PASSIVE_OPS = new Set(["wait", "scroll_down", "scroll_up"]);

interface Advance {
  readonly step: SignalStep;
  readonly after: SignalScreen;
}

function advanced(capture: RunSignalCapture, s: SignalStep): SignalScreen | undefined {
  const before = capture.screens.filter((x) => x.step === s.step).pop();
  const after = capture.screens.find((x) => x.step > s.step);
  if (before === undefined || after === undefined || routeOf(after.url) !== routeOf(before.url)) return undefined;
  return after.visibleText !== before.visibleText ? after : undefined;
}

/** Streaks of the same advance control clicked again and again on one route, each moving the page on. */
export function detectRepeatedAdvances(capture: RunSignalCapture): UxFinding[] {
  const streaks: Advance[][] = [];
  let current: Advance[] = [];
  let key: string | null = null;
  const close = (): void => {
    if (current.length >= REPEATED_ADVANCE_MIN) streaks.push(current);
    current = [];
    key = null;
  };
  for (const s of capture.steps) {
    if (s.op !== null && PASSIVE_OPS.has(s.op)) continue;
    const label = s.op === "click" && s.actOk ? labelOf(s) : null;
    const after = label !== null && ADVANCE_NAME.test(label) ? advanced(capture, s) : undefined;
    if (label === null || after === undefined || (s.op !== null && INPUT_OPS.has(s.op))) {
      close();
      continue;
    }
    const k = `${routeOf(s.url)}|${label.toLowerCase()}`;
    if (key !== null && k !== key) close();
    key = k;
    current.push({ step: s, after });
  }
  close();
  return streaks.map((hits) => {
    const label = labelOf(hits[0]!.step) ?? "the advance control";
    const n = hits.length;
    const steps = hits.map((h) => h.step.step);
    const last = hits[n - 1]!;
    return makeSignalFinding({
      kind: "repeated-advance",
      confidence: n >= 5 ? 0.8 : n === 4 ? 0.7 : 0.6,
      url: last.after.url,
      screenId: last.after.signature,
      observation: `The flow needed "${label}" ${n} times in a row (steps ${steps.join(", ")}) with nothing entered between them, each only moving to the next screen.`,
      userImpact: "Every extra confirmation costs the user time and attention without adding a decision; repeated identical steps also read as the page not responding.",
      recommendation: `Fold the repeated "${label}" screens into one step, or let the user confirm once.`,
      controls: [label],
      occurrences: n,
      screenIds: [...new Set(hits.map((h) => h.after.signature))],
      evidence: {
        kind: "repeated-advance",
        steps,
        requests: [],
        ...(last.after.screenshot === undefined ? {} : { screenshot: last.after.screenshot }),
        detail: `${n} consecutive successful "${label}" clicks on ${routeOf(last.after.url)} with no input between them, each changing the page text`,
      },
    });
  });
}
