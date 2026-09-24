import type { Control, Snapshot } from "../snapshot.js";
import { affordedOp, sendable, type Op } from "../actions.js";
import { isSecretLike } from "../feature/boundary-values.js";
import { pickMisuseAction, type MisuseStrategy } from "./misuse.js";
import { valueFor, type InputStrategy } from "./input-strategy.js";
import { DESTRUCTIVE, SESSION_END } from "../safety.js";

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
  /**
   * True for a `type` into a `type=password` field: the typed value is a synthetic boundary/invalid
   * value (never a real secret), but it is still recorded as `{redacted:true}` in the Recording and
   * the transcript — a password field's value is never persisted in the clear, synthetic or not.
   */
  readonly redacted?: boolean;
}

export interface MisuseEpisode {
  readonly steps: readonly MisuseStep[];
}

/** A form on the page: editable fields, the control that submits them, and a Cancel if there is one. */
export interface FormModel {
  /** `form#<id>` / `form@<n>` for a `<form>`, the container key for a form-like container, `page`
   *  for fields outside either, or `composer:<field>` for a chat composer (#121). */
  readonly key: string;
  readonly fields: readonly Control[];
  /**
   * The control that submits the form. For a composer (`isComposer: true`) this is the composer
   * FIELD itself — there is no separate submit control to plan; `act()`'s `send` op types the value
   * and submits it (its own nearest Send control, or Enter) in one gated action.
   */
  readonly submit: Control;
  readonly cancel: Control | null;
  /** Checkboxes belonging to the form (e.g. "I agree to the terms") — set, never toggled, before a submit. */
  readonly checkboxes: readonly Control[];
  /** True for a chat/inquiry composer (a message-shaped field with no `<form>`/container of its own). */
  readonly isComposer?: boolean;
}

/** Generic submit-like names, used for pages that do not use `<form>` (and to rank submit buttons). */
const SUBMIT_NAME = /\b(?:save|submit|update|apply|create|confirm|send|publish|register|sign ?(?:in|up)|log ?in)\b/i;
const CANCEL_NAME = /\b(?:cancel|discard|revert|reset|undo)\b/i;
// Ending the session (it would end the run's authentication) and irreversible actions on a real
// account are never misuse targets: the shared safety policy's own patterns (#116, `../safety.ts`),
// matched on the control's accessible name; a false positive only costs coverage of that control.

/**
 * A control that reveals more UI when clicked (a "Create new key" button opening a dialog with a
 * form, "Review this plan", "Log a … interaction"): a button whose accessible name suggests it, or
 * one that declares `aria-haspopup=dialog`. The adversarial frontier opens these BEFORE giving up on
 * a page that has no form of its own, so a form that lives behind a modal trigger, a disclosure
 * ("Review …"), or a logging action ("Log a … interaction") is still found and exercised (#121
 * widens the name matching past just create/new/add/edit).
 */
const DISCLOSURE_NAME = /\b(?:create|new|add|edit|review|log|start|open|apply|begin)\b/i;
export function isDisclosureControl(c: Control): boolean {
  return c.role !== "link" && (DISCLOSURE_NAME.test(c.name) || c.ariaHasPopup === "dialog");
}

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
 * not a file input (no fixture), not a secret-like field BY NAME (API token, SSN, credit card…) —
 * except a plain `type=password` field, which IS exercisable (typed with a synthetic boundary/
 * invalid value, never read back, always recorded redacted — see `edit`) — and not a
 * session-ending or destructive control (Delete, Remove, Close account…), and not a link that
 * leads out of scope (it is navigation away from the target, not part of it).
 */
export function isExercisable(c: Control, inScope: (url: string) => boolean): boolean {
  if (!c.enabled) return false;
  if (c.inputType === "file") return false;
  if (c.inputType !== "password" && isSecretLike(c)) return false;
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
 * The forms on a page. Controls are grouped by their owning `<form>`, else by the nearest form-like
 * CONTAINER (`Control.container` — a `[role=form]`, `dialog`, `fieldset`, `section`: #121), else
 * into one implicit `page` group. Grouping by container (not just `<form>`) means a page built
 * without `<form>` elements still pairs a field with its OWN submit: a settings section and an
 * unrelated global header search never collapse into the same "page" bucket just because neither
 * uses `<form>` (the bug behind pairing "Semantic search" with an unrelated "Send feedback").
 *
 * A group is a form when it has an editable field and a submit control: its own submit button, or —
 * when the Save lives outside the `<form>`/container element (a toolbar) — a submit-named button
 * outside every form/container. A disabled submit still counts (many forms enable Save only once
 * something was edited); the gate decides at click time.
 */
export function detectForms(controls: readonly Control[], inScope: (url: string) => boolean = () => true): FormModel[] {
  const groups = new Map<string, Control[]>();
  for (const c of controls) {
    const key = c.form ?? c.container ?? "page";
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [c]);
    else g.push(c);
  }
  const loose = (groups.get("page") ?? []).filter(isButtonLike);
  const forms: FormModel[] = [];
  for (const [key, group] of groups) {
    // A chat/inquiry composer field (#121, see below) is never folded into the generic "page"
    // pseudo-form: it is exercised only through its own single-field composer entry, via `send`.
    const fields = group.filter((c) => isEditable(c, inScope) && !(key === "page" && sendable(c)));
    if (fields.length === 0) continue;
    const buttons = group.filter(isButtonLike);
    const submit =
      key === "page"
        ? buttons.find((b) => SUBMIT_NAME.test(b.name) && !CANCEL_NAME.test(b.name) && !SESSION_END.test(b.name))
        : (pickSubmit(buttons) ?? loose.find((b) => SUBMIT_NAME.test(b.name) && !CANCEL_NAME.test(b.name)));
    if (submit === undefined) continue;
    const cancel = buttons.find((b) => CANCEL_NAME.test(b.name)) ?? loose.find((b) => CANCEL_NAME.test(b.name)) ?? null;
    const checkboxes = group.filter((c) => c.role === "checkbox" && isExercisable(c, inScope));
    forms.push({ key, fields, submit, cancel, checkboxes });
  }
  // Chat composers (#121): a message-shaped field with no `<form>` and no form-like container (a
  // textarea + Send button rarely sits in either) is its own single-field "form" — submitted via
  // `act()`'s `send` op (types AND submits: its own nearest Send control, or Enter), never bundled
  // with unrelated page controls, and preferred over repeatedly opening a "+New …" disclosure.
  for (const c of groups.get("page") ?? []) {
    if (isEditable(c, inScope) && sendable(c)) {
      forms.push({ key: `composer:${controlKey(c)}`, fields: [c], submit: c, cancel: null, checkboxes: [], isComposer: true });
    }
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
  const redacted = field.inputType === "password";
  return { op: "type", control: field, fillText: valueFor(strategy, field), settle, note, ...(redacted ? { redacted } : {}) };
}

function submit(form: FormModel, note: string, settle: boolean): MisuseStep {
  return { op: "click", control: form.submit, settle, note, submitsForm: form.key };
}

/**
 * `send` types the misuse value into a composer field AND submits it in one gated action (its own
 * nearest Send control, or Enter — `act()`'s existing `send` handling), so a composer never needs a
 * separately-detected submit control to be exercised (#121).
 */
function sendStep(form: FormModel, field: Control, strategy: InputStrategy, note: string, settle: boolean): MisuseStep {
  return { op: "send", control: field, fillText: valueFor(strategy, field), settle, note, submitsForm: form.key };
}

/**
 * A chat/inquiry composer's episode (#121): the SAME misuse strategies, expressed with `send`
 * instead of a separate edit+click, since a composer has one field and no distinct submit control.
 * `edit-cancel-save` finds nothing (no Cancel on a composer) and falls back to the caller's other
 * planning (a real form, else a disclosure control) exactly as any other form with no Cancel would.
 */
function planComposerEpisode(
  strategy: Exclude<FormMisuseStrategy, "exercise-controls">,
  form: FormModel,
  field: Control,
  ctx: EpisodeContext,
): MisuseEpisode | null {
  switch (strategy) {
    case "double-submit":
      return {
        steps: [
          sendStep(form, field, "normal", "send a message", false),
          sendStep(form, field, "normal", "send again before the first reply settled", true),
        ],
      };
    case "boundary-submit": {
      const value = at(BOUNDARY_ORDER, ctx.round) ?? "invalid";
      return { steps: [sendStep(form, field, value, `send a ${value} value`, true)] };
    }
    case "act-while-pending":
      return {
        steps: [
          sendStep(form, field, "normal", "send a message", false),
          sendStep(form, field, "normal", "send again while the first is pending", true),
        ],
      };
    case "navigate-away-unsaved":
      return {
        steps: [
          edit(field, "normal", "type into the composer"),
          { op: "reload", control: null, settle: true, note: "leave the page with the typed message unsent" },
        ],
      };
    case "edit-cancel-save":
      return null;
  }
}

/**
 * Steps that CHECK any of the form's unchecked checkboxes (e.g. "I agree to the terms") — never
 * unchecks one that is already checked, so a checkbox already in the state that enables submit
 * stays there (never toggled on then off by a later "exercise" pass; see `planExercise`). Planned
 * ahead of a submit-attempting episode's edit/submit steps.
 */
function ensureCheckboxes(form: FormModel, settle: boolean): MisuseStep[] {
  return form.checkboxes
    .filter((c) => c.checked !== true)
    .map((c) => ({ op: "click" as const, control: c, settle, note: `check "${c.name}" so the form can be submitted` }));
}

function planForm(strategy: Exclude<FormMisuseStrategy, "exercise-controls">, ctx: EpisodeContext): MisuseEpisode | null {
  const inScope = ctx.inScope ?? (() => true);
  const forms = detectForms(ctx.snapshot.controls, inScope);
  const form = pickForm(forms, ctx.exercised, ctx.round);
  if (form === undefined) return null;
  const field = pickField(form, ctx.exercised, ctx.round);
  if (field === undefined) return null;
  if (form.isComposer === true) return planComposerEpisode(strategy, form, field, ctx);
  switch (strategy) {
    case "double-submit":
      return {
        steps: [
          ...ensureCheckboxes(form, false),
          edit(field, "normal", "edit a field"),
          submit(form, "submit", false),
          submit(form, "submit again before the first submit settled", true),
        ],
      };
    case "boundary-submit": {
      const value = at(BOUNDARY_ORDER, ctx.round) ?? "invalid";
      return {
        steps: [
          ...ensureCheckboxes(form, false),
          edit(field, value, `enter a ${value} value`),
          submit(form, `submit the ${value} value`, true),
        ],
      };
    }
    case "edit-cancel-save": {
      if (form.cancel === null) return null;
      return {
        steps: [
          ...ensureCheckboxes(form, false),
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
      return {
        steps: [...ensureCheckboxes(form, false), edit(field, "normal", "edit a field"), submit(form, "submit", false), other],
      };
    }
  }
}

/**
 * The next target control not exercised yet, acted on once by its afforded op. A checkbox already
 * CHECKED is never picked: clicking it would toggle it back off, undoing a state a submit strategy
 * may depend on ("keep a checkbox in the state that enables submit", never toggle it on then off).
 */
function planExercise(ctx: EpisodeContext): MisuseEpisode | null {
  const inScope = ctx.inScope ?? (() => true);
  const next = ctx.snapshot.controls.find(
    (c) => isExercisable(c, inScope) && !ctx.exercised.has(controlKey(c)) && !(c.role === "checkbox" && c.checked === true),
  );
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
 * When a form strategy finds nothing to work with on the current page, open a disclosure control (a
 * "Create new key" button, a `aria-haspopup=dialog` trigger…) instead of giving up: the next
 * snapshot then shows whatever it revealed (typically a dialog with its own form), which the SAME
 * strategies apply to on a later round. An UNEXERCISED one is preferred, but this is reached ONLY
 * when nothing else applies (the caller already tried), so a previously-opened one is fair game
 * too — opening it is idempotent, and it is the only way back in after something else (e.g. a
 * `navigate-away-unsaved` reload) closed what it revealed before it could be submitted.
 */
function planDisclosure(ctx: EpisodeContext): MisuseEpisode | null {
  const inScope = ctx.inScope ?? (() => true);
  const candidates = ctx.snapshot.controls.filter((c) => isExercisable(c, inScope) && isDisclosureControl(c));
  const disclosure = candidates.find((c) => !ctx.exercised.has(controlKey(c))) ?? candidates[0];
  if (disclosure === undefined) return null;
  return { steps: [{ op: "click", control: disclosure, settle: true, note: `open "${disclosure.name}" to look for a form` }] };
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
  if (isFormStrategy(strategy)) {
    const direct = strategy === "exercise-controls" ? planExercise(ctx) : planForm(strategy, ctx);
    // Nothing to work with for THIS strategy on THIS page (no form at all, or e.g. `edit-cancel-save`
    // on a form with no Cancel): try opening an unexercised disclosure control instead of giving up —
    // whatever it reveals (typically a dialog with its own form) benefits every strategy from here on.
    return direct ?? planDisclosure(ctx);
  }
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
