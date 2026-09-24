import type { Control, Snapshot } from "../snapshot.js";
import { affordedOp, type Op } from "../actions.js";
import { isSecretLike } from "../feature/boundary-values.js";
import { pickMisuseAction, type MisuseStrategy } from "./misuse.js";
import { valueFor, type InputStrategy } from "./input-strategy.js";

/**
 * Form-aware misuse (#64). Ordinary apps are mostly forms: fields plus a Save / Submit control.
 * The single-step strategies in `misuse.ts` find nothing to do on them (nothing is named "confirm",
 * there is no "previous action" to repeat), so a run never clicks Save. These strategies recognise a
 * form and plan a short EPISODE of actions around submitting it:
 *
 *  - `double-submit`         — edit a field, submit, submit again before the first settled;
 *  - `boundary-submit`       — enter a boundary / invalid value (empty, edge, long, unicode,
 *                              invalid, cycling per round) and submit;
 *  - `edit-cancel-save`      — edit, Cancel, then Save (does a cancelled edit leak into the save?);
 *  - `navigate-away-unsaved` — edit, then reload the page with the edit unsaved;
 *  - `act-while-pending`     — submit, then immediately act again while the request is in flight;
 *  - `exercise-controls`     — act once on the next target control not exercised yet (coverage).
 *
 * Planning is PURE (snapshot in, steps out) and deterministic; every step still goes through the
 * gated `act()` when the mission executes it, so a stale plan never touches the wrong element.
 * Nothing here is specific to an app: forms are found from the DOM's own form ownership and submit
 * semantics, and by generic control names only when a page has no `<form>` element.
 */

export type FormMisuseStrategy = Extract<
  MisuseStrategy,
  "double-submit" | "boundary-submit" | "edit-cancel-save" | "navigate-away-unsaved" | "act-while-pending" | "exercise-controls"
>;

export const FORM_MISUSE_STRATEGIES: readonly FormMisuseStrategy[] = [
  "double-submit",
  "boundary-submit",
  "edit-cancel-save",
  "navigate-away-unsaved",
  "act-while-pending",
  "exercise-controls",
];

/** One action of an episode. `settle` = wait for the page to settle (and check it) afterwards. */
export interface MisuseStep {
  readonly op: Op;
  readonly control: Control | null;
  /** The text to type. For `select`, absent means "any option other than the current one". */
  readonly fillText?: string;
  readonly settle: boolean;
  /** What this step is for, in the transcript (e.g. "second submit before the first settled"). */
  readonly note: string;
  /** The form this step submits, when it is a submit click. */
  readonly submitsForm?: string;
}

export interface MisuseEpisode {
  readonly steps: readonly MisuseStep[];
}

/** A form on the page: editable fields, the control that submits them, and a Cancel if there is one. */
export interface FormModel {
  /** `form#<id>` / `form@<n>` for a `<form>`, or `page` for fields outside any form. */
  readonly key: string;
  readonly fields: readonly Control[];
  readonly submit: Control;
  readonly cancel: Control | null;
}

/** Generic submit-like names, used for pages that do not use `<form>` (and to rank submit buttons). */
const SUBMIT_NAME = /\b(?:save|submit|update|apply|create|confirm|send|publish|register|sign ?(?:in|up)|log ?in)\b/i;
const CANCEL_NAME = /\b(?:cancel|discard|revert|reset|undo)\b/i;
/** Ending the session would end the run's authentication: never a misuse target. */
const SESSION_END = /\b(?:log ?out|sign ?out|log ?off|sign ?off)\b/i;
/**
 * Irreversible actions on a real account: a misuse run against a live app must never click them.
 * Matched on the control's accessible name; a false positive only costs coverage of that control.
 */
export const DESTRUCTIVE = /\b(?:delete|remove|destroy|erase|purge|wipe|drop|deactivate|terminate|revoke|unsubscribe|close (?:my |your |the )?account|cancel (?:my |your |the )?(?:subscription|plan|membership|order))\b/i;

/** A stable key for a control across snapshots (its durable descriptor). */
export function controlKey(c: Pick<Control, "descriptor">): string {
  return JSON.stringify(c.descriptor);
}

/** Is `href` a web destination OUTSIDE the scope? (`javascript:`, `mailto:` … are not destinations.) */
function leavesScope(href: string | null | undefined, inScope: (url: string) => boolean): boolean {
  if (href === null || href === undefined) return false;
  let protocol: string;
  try {
    protocol = new URL(href).protocol;
  } catch {
    return false;
  }
  return (protocol === "http:" || protocol === "https:") && !inScope(href);
}

/**
 * Whether a control counts as a target control a misuse run can (and should) exercise: enabled,
 * not a file input (no fixture), not a secret field, not a session-ending or destructive control
 * (Delete, Remove, Close account…), and not a link
 * that leads out of scope (it is navigation away from the target, not part of it).
 */
export function isExercisable(c: Control, inScope: (url: string) => boolean): boolean {
  if (!c.enabled) return false;
  if (c.inputType === "file" || c.inputType === "password" || isSecretLike(c)) return false;
  if (SESSION_END.test(c.name) || DESTRUCTIVE.test(c.name)) return false;
  return !leavesScope(c.href, inScope);
}

function isEditable(c: Control, inScope: (url: string) => boolean): boolean {
  const op = affordedOp(c);
  return (op === "type" || op === "select") && isExercisable(c, inScope);
}

function isButtonLike(c: Control): boolean {
  return (
    affordedOp(c) === "click" && c.role !== "checkbox" && c.role !== "radio" && c.role !== "link" && !DESTRUCTIVE.test(c.name)
  );
}

function pickSubmit(buttons: readonly Control[]): Control | undefined {
  return (
    buttons.find((b) => b.submits === true && SUBMIT_NAME.test(b.name)) ??
    buttons.find((b) => b.submits === true && !CANCEL_NAME.test(b.name)) ??
    buttons.find((b) => SUBMIT_NAME.test(b.name) && !CANCEL_NAME.test(b.name))
  );
}

/**
 * The forms on a page. Controls are grouped by their owning `<form>`; controls in no form form one
 * implicit `page` group. A group is a form when it has an editable field and a submit control: its
 * own submit button, or — when the Save lives outside the `<form>` element (a toolbar) — a
 * submit-named button outside every form. A disabled submit still counts (many forms enable Save
 * only once something was edited); the gate decides at click time.
 */
export function detectForms(controls: readonly Control[], inScope: (url: string) => boolean = () => true): FormModel[] {
  const groups = new Map<string, Control[]>();
  for (const c of controls) {
    const key = c.form ?? "page";
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [c]);
    else g.push(c);
  }
  const loose = (groups.get("page") ?? []).filter(isButtonLike);
  const forms: FormModel[] = [];
  for (const [key, group] of groups) {
    const fields = group.filter((c) => isEditable(c, inScope));
    if (fields.length === 0) continue;
    const buttons = group.filter(isButtonLike);
    const submit =
      key === "page"
        ? buttons.find((b) => SUBMIT_NAME.test(b.name) && !CANCEL_NAME.test(b.name) && !SESSION_END.test(b.name))
        : (pickSubmit(buttons) ?? loose.find((b) => SUBMIT_NAME.test(b.name) && !CANCEL_NAME.test(b.name)));
    if (submit === undefined) continue;
    const cancel = buttons.find((b) => CANCEL_NAME.test(b.name)) ?? loose.find((b) => CANCEL_NAME.test(b.name)) ?? null;
    forms.push({ key, fields, submit, cancel });
  }
  return forms;
}

/** Boundary / invalid values cycled by `boundary-submit`, one per round (never blind fuzz). */
const BOUNDARY_ORDER: readonly InputStrategy[] = ["empty", "boundary", "long", "unicode", "invalid"];

/** The previous executed step, for the strategies that react to it. */
export interface LastAction {
  readonly op: Op;
  readonly control: Control | null;
  readonly fillText?: string;
}

export interface EpisodeContext {
  readonly snapshot: Snapshot;
  readonly strategy: MisuseStrategy;
  /** How many times this strategy has applied before (rotates forms, fields and values). */
  readonly round: number;
  readonly last: LastAction | null;
  /** Link names `visit-route` already followed. */
  readonly visitedLinks: ReadonlySet<string>;
  /** Keys (`controlKey`) of target controls already exercised. */
  readonly exercised: ReadonlySet<string>;
  /** Is a URL inside the mission's scope? Default: everything is. */
  readonly inScope?: (url: string) => boolean;
  readonly rng: () => number;
}

const at = <T>(xs: readonly T[], i: number): T | undefined => xs[((i % xs.length) + xs.length) % xs.length];

/** The next field to edit: the first one not exercised yet, else rotate by round. */
function pickField(form: FormModel, exercised: ReadonlySet<string>, round: number): Control | undefined {
  return form.fields.find((f) => !exercised.has(controlKey(f))) ?? at(form.fields, round);
}

/** The form to work on: the first with an unexercised field, else rotate by round. */
function pickForm(forms: readonly FormModel[], exercised: ReadonlySet<string>, round: number): FormModel | undefined {
  return forms.find((f) => f.fields.some((c) => !exercised.has(controlKey(c)))) ?? at(forms, round);
}

function edit(field: Control, strategy: InputStrategy, note: string, settle = false): MisuseStep {
  if (affordedOp(field) === "select") return { op: "select", control: field, settle, note };
  return { op: "type", control: field, fillText: valueFor(strategy, field), settle, note };
}

function submit(form: FormModel, note: string, settle: boolean): MisuseStep {
  return { op: "click", control: form.submit, settle, note, submitsForm: form.key };
}

function planForm(strategy: Exclude<FormMisuseStrategy, "exercise-controls">, ctx: EpisodeContext): MisuseEpisode | null {
  const inScope = ctx.inScope ?? (() => true);
  const forms = detectForms(ctx.snapshot.controls, inScope);
  const form = pickForm(forms, ctx.exercised, ctx.round);
  if (form === undefined) return null;
  const field = pickField(form, ctx.exercised, ctx.round);
  if (field === undefined) return null;
  switch (strategy) {
    case "double-submit":
      return {
        steps: [
          edit(field, "normal", "edit a field"),
          submit(form, "submit", false),
          submit(form, "submit again before the first submit settled", true),
        ],
      };
    case "boundary-submit": {
      const value = at(BOUNDARY_ORDER, ctx.round) ?? "invalid";
      return { steps: [edit(field, value, `enter a ${value} value`), submit(form, `submit the ${value} value`, true)] };
    }
    case "edit-cancel-save": {
      if (form.cancel === null) return null;
      return {
        steps: [
          edit(field, "normal", "edit a field"),
          { op: "click", control: form.cancel, settle: true, note: "cancel the edit" },
          submit(form, "save after cancelling", true),
        ],
      };
    }
    case "navigate-away-unsaved":
      return {
        steps: [
          edit(field, "normal", "edit a field"),
          { op: "reload", control: null, settle: true, note: "leave the page with the edit unsaved" },
        ],
      };
    case "act-while-pending": {
      const other =
        form.cancel !== null
          ? { op: "click" as const, control: form.cancel, settle: true, note: "cancel while the submit is pending" }
          : (() => {
              const next = form.fields.find((f) => controlKey(f) !== controlKey(field));
              return next === undefined
                ? submit(form, "submit again while the first submit is pending", true)
                : edit(next, "normal", "edit another field while the submit is pending", true);
            })();
      return { steps: [edit(field, "normal", "edit a field"), submit(form, "submit", false), other] };
    }
  }
}

/** The next target control not exercised yet, acted on once by its afforded op. */
function planExercise(ctx: EpisodeContext): MisuseEpisode | null {
  const inScope = ctx.inScope ?? (() => true);
  const next = ctx.snapshot.controls.find((c) => isExercisable(c, inScope) && !ctx.exercised.has(controlKey(c)));
  if (next === undefined) return null;
  const op = affordedOp(next);
  if (op === "type") return { steps: [edit(next, "normal", "exercise a field", true)] };
  if (op === "select") return { steps: [{ op: "select", control: next, settle: true, note: "exercise a choice" }] };
  return {
    steps: [
      {
        op: "click",
        control: next,
        settle: true,
        note: "exercise a control",
        ...(next.submits === true && next.form !== undefined && next.form !== null ? { submitsForm: next.form } : {}),
      },
    ],
  };
}

const TERMINAL_NAME = /submit|confirm|pay|complete|checkout|send|save/i;
const OPPOSING_NAME = /cancel|back|reject|decline/i;

function isFormStrategy(s: MisuseStrategy): s is FormMisuseStrategy {
  return (FORM_MISUSE_STRATEGIES as readonly string[]).includes(s);
}

/**
 * Plans the next episode for `strategy` on the current page, or null when the strategy finds
 * nothing to do here. The single-step strategies of `misuse.ts` become one-step episodes; the ones
 * that react to the previous action resolve its control by descriptor on THIS page (never by a
 * stale index from an earlier snapshot).
 */
export function planMisuseEpisode(ctx: EpisodeContext): MisuseEpisode | null {
  const { snapshot, strategy } = ctx;
  const inScope = ctx.inScope ?? (() => true);
  if (isFormStrategy(strategy)) return strategy === "exercise-controls" ? planExercise(ctx) : planForm(strategy, ctx);
  const find = (c: Control | null): Control | undefined =>
    c === null ? undefined : snapshot.controls.find((x) => controlKey(x) === controlKey(c));
  switch (strategy) {
    case "repeat-rapid": {
      if (ctx.last === null) return null;
      const control = ctx.last.control === null ? null : (find(ctx.last.control) ?? null);
      if (ctx.last.control !== null && control === null) return null;
      return {
        steps: [
          {
            op: ctx.last.op,
            control,
            ...(ctx.last.fillText === undefined ? {} : { fillText: ctx.last.fillText }),
            settle: true,
            note: "repeat the previous action at once",
          },
        ],
      };
    }
    case "contradictory-actions": {
      const last = ctx.last?.control === null || ctx.last === null ? undefined : find(ctx.last.control);
      if (last === undefined || !TERMINAL_NAME.test(last.name)) return null;
      const opposing = snapshot.controls.find((c) => OPPOSING_NAME.test(c.name) && c.enabled);
      return opposing === undefined
        ? null
        : { steps: [{ op: "click", control: opposing, settle: true, note: "contradict the previous action" }] };
    }
    case "visit-route": {
      // Scope-contained: only links that stay on the target (a link out of scope is never followed).
      const link = snapshot.controls.find(
        (c) => c.role === "link" && c.enabled && c.name !== "" && !ctx.visitedLinks.has(c.name) && !leavesScope(c.href, inScope),
      );
      return link === undefined ? null : { steps: [{ op: "click", control: link, settle: true, note: "follow a link" }] };
    }
    default: {
      const d = pickMisuseAction({ snapshot, strategy, rng: ctx.rng });
      if (d === null) return null;
      const control = d.targetIndex === undefined ? null : (snapshot.controls.find((c) => c.index === d.targetIndex) ?? null);
      return {
        steps: [
          {
            op: d.op,
            control,
            ...(d.fillText === undefined ? {} : { fillText: d.fillText }),
            settle: true,
            note: "",
            ...(control?.submits === true && control.form !== undefined && control.form !== null ? { submitsForm: control.form } : {}),
          },
        ],
      };
    }
  }
}
