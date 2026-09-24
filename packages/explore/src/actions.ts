import type { Control } from "./snapshot.js";

/**
 * The action vocabulary shared by every mission (goal/usability explore, adversarial,
 * induction/coverage, feature): the ops, which of them need a target, the single interaction a
 * control AFFORDS, and the complete candidate actions a page offers.
 *
 * Missions differ in HOW they pick among candidates (the model for the goal loop, a misuse
 * strategy for adversarial, a frontier for the coverage missions) — never in how a control maps to
 * an op. Keeping that mapping here means an incoherent pair (e.g. `upload` on a button, `type` into
 * a link) is inexpressible everywhere.
 */

export type Op =
  | "click"
  | "type"
  | "send"
  | "select"
  | "upload"
  /**
   * An edit INSIDE a rich-text (`contenteditable`) control (#148): replace / insert at / format a
   * quoted part of its text, keeping the rest — never a whole-element retype.
   */
  | "edit_text"
  | "scroll_up"
  | "scroll_down"
  | "wait"
  /** Reload the current page — proves whether what the page shows survived (persistence). */
  | "reload"
  | "done"
  /**
   * End a find-out / understand goal with its answer (#101): the answer is generated from the
   * observed page text and accepted only when code finds every claim's quote on the pages seen.
   */
  | "report"
  | "blocked";

export const OPS: readonly Op[] = [
  "click",
  "type",
  "send",
  "select",
  "upload",
  "edit_text",
  "scroll_up",
  "scroll_down",
  "wait",
  "reload",
  "done",
  "report",
  "blocked",
];

/**
 * The ops that act on a chosen control. `send` = type a message into a text field AND submit it
 * (Enter, else the field's Send/Submit control) — one action, so a chat composer is never left
 * holding typed text the app never receives. It is never a control's `affordedOp`; the goal loop
 * offers it alongside `type` for message-shaped fields (see `sendable`).
 */
export type TargetOp = "click" | "type" | "send" | "select" | "upload" | "edit_text";

/** The ops that require a chosen control; every other op is target-free. */
export const OPS_NEEDING_TARGET: ReadonlySet<Op> = new Set<Op>(["click", "type", "send", "select", "upload", "edit_text"]);

/** Text-entry `<input>` types: typing is their interaction. Anything else (checkbox, radio, range, color…) is clicked. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "",
  "text",
  "email",
  "search",
  "tel",
  "url",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Roles whose interaction is text entry, whatever element carries them. */
const TEXT_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "spinbutton"]);

/**
 * The single interaction a control affords, by its kind — the chooser picks WHAT to act on and
 * this derives HOW. File inputs upload, text fields type, native selects select, everything else
 * (buttons, links, checkboxes, radios, custom `role=combobox` widgets…) is clicked.
 */
export function affordedOp(c: Pick<Control, "tag" | "inputType" | "role">): TargetOp {
  if (c.tag === "input" && c.inputType === "file") return "upload";
  if (c.tag === "select") return "select";
  if (c.tag === "textarea") return "type";
  if (c.tag === "input" && TEXT_INPUT_TYPES.has(c.inputType ?? "")) return "type";
  if (TEXT_ROLES.has(c.role)) return "type";
  return "click";
}

/** Free-text input types a message can be written into (not passwords, numbers, dates, emails…). */
const MESSAGE_INPUT_TYPES: ReadonlySet<string> = new Set(["", "text", "search"]);

/**
 * True when a control can take a typed-and-submitted message (`send`): a message-shaped (see
 * `MESSAGE_FIELD`) textarea, free-text input, or `textbox` role (contenteditable composers).
 * Structured and form fields are never offered it.
 */
export function sendable(c: Pick<Control, "tag" | "inputType" | "role" | "enabled" | "name">): boolean {
  if (!c.enabled || !MESSAGE_FIELD.test(c.name)) return false;
  if (c.tag === "textarea") return true;
  if (c.tag === "input") return MESSAGE_INPUT_TYPES.has(c.inputType ?? "");
  return c.role === "textbox";
}

/**
 * A field whose text is a message to someone (a chat/inquiry composer: "Type a reply", "Ask…",
 * "Start a new inquiry"), not a form value ("Rationale", "Your name"). Only these are offered `send`
 * and written by `chat.reply` — a form field keeps `type` + its form's own submit.
 */
export const MESSAGE_FIELD = /\b(reply|message|ask|chat|inquiry|prompt|say|talk|conversation)\b/i;

/** One complete action on the current page: an op plus (for target ops) its control. */
export type CandidateAction =
  | { readonly id: string; readonly op: TargetOp; readonly control: Control; readonly description: string }
  | { readonly id: string; readonly op: Exclude<Op, TargetOp>; readonly control: null; readonly description: string };

/** Target-free actions, always offered to the goal loop, with what each means. */
export const TARGET_FREE_ACTIONS: ReadonlyArray<{ readonly op: Exclude<Op, TargetOp>; readonly description: string }> = [
  { op: "wait", description: "wait for the page to finish updating" },
  { op: "scroll_down", description: "scroll down to reveal more of the page" },
  { op: "scroll_up", description: "scroll up" },
  {
    op: "reload",
    description: "reload the page (shows whether what was saved actually persisted; unsaved edits are discarded)",
  },
  { op: "done", description: "the goal is achieved on the current page" },
  {
    op: "report",
    description:
      "the goal asks to find out / understand something and the pages seen show the answer: end the run by reporting it",
  },
  { op: "blocked", description: "the goal cannot be advanced from here" },
];

export function describeAction(op: TargetOp, summary: string): string {
  switch (op) {
    case "upload":
      return `upload the mission's file into ${summary}`;
    case "type":
      return `type into ${summary}`;
    case "send":
      return `type a message into ${summary} and submit it (Enter / its Send button)`;
    case "select":
      return `choose an option in ${summary}`;
    case "edit_text":
      return `edit part of the text inside ${summary} (replace, insert at, or format a quoted piece; the rest stays)`;
    case "click":
      return `click ${summary}`;
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

/** The stable per-snapshot id of a target action: `<op>:<controlIndex>`. */
export function candidateId(op: TargetOp, control: Pick<Control, "index">): string {
  return `${op}:${control.index}`;
}

export interface TargetCandidateOptions {
  /** The target ops this mission may issue. Default: every afforded op (never `send`). */
  readonly ops?: ReadonlySet<TargetOp>;
  /** Skip disabled controls (they can never be acted on). Default false. */
  readonly enabledOnly?: boolean;
}

/**
 * The complete TARGET actions a page affords: one per control, with the control's afforded op,
 * filtered to the ops this mission may issue (e.g. `upload` only while a fixture is available;
 * the coverage missions never upload). Descriptions are page-derived — callers that send them to a
 * model must redact them.
 */
export function targetCandidates(
  controls: readonly Control[],
  opts: TargetCandidateOptions = {},
): Array<Extract<CandidateAction, { op: TargetOp }>> {
  const out: Array<Extract<CandidateAction, { op: TargetOp }>> = [];
  for (const control of controls) {
    if (opts.enabledOnly === true && !control.enabled) continue;
    const op = affordedOp(control);
    if (opts.ops !== undefined && !opts.ops.has(op)) continue;
    out.push({ id: candidateId(op, control), op, control, description: describeAction(op, control.summary) });
  }
  return out;
}

/**
 * The `send` actions a page affords: one per message-shaped field (see `sendable`). Offered by the
 * goal loop next to `type`, so "write a message and send it" is a single choice.
 */
export function sendCandidates(controls: readonly Control[]): Array<Extract<CandidateAction, { op: TargetOp }>> {
  return controls
    .filter((c) => affordedOp(c) === "type" && sendable(c))
    .map((control) => ({
      id: candidateId("send", control),
      op: "send" as const,
      control,
      description: describeAction("send", control.summary),
    }));
}

/**
 * The `edit_text` actions a page affords (#148): one per enabled rich-text (`contenteditable`)
 * control. Offered next to the control's own action, so "change one word mid-paragraph" is a single
 * choice — never a retype of the whole element.
 */
export function editCandidates(controls: readonly Control[]): Array<Extract<CandidateAction, { op: TargetOp }>> {
  return controls
    .filter((c) => c.richText === true && c.enabled)
    .map((control) => ({
      id: candidateId("edit_text", control),
      op: "edit_text" as const,
      control,
      description: describeAction("edit_text", control.summary),
    }));
}
