import type { Control, Snapshot } from "../snapshot.js";
import { controlKey, detectForms, isExercisable } from "./form-misuse.js";
import { routeOf } from "./scope.js";

/**
 * What an adversarial run actually exercised on its target (#64), and whether that is enough to
 * call a silent run `clean`. A run that found nothing only means something if it tried: a run that
 * never submitted the page's form, or touched a handful of its controls, proved nothing and is
 * reported `inconclusive` with these numbers — never `clean`.
 *
 *  - controls — distinct target controls a run can act on (enabled; not secret, file or
 *    session-ending; not a link out of scope), seen on in-scope pages, and how many were acted on;
 *  - forms    — forms found on the target (per route) and how many were submitted: a submit
 *    control clicked AND that click actually sent a request (a write or a navigation) — #155. A
 *    click the browser blocked with native validation (`required`, `type=email`, `minlength`…)
 *    never reached the server, so it is never counted `submitted`; it is instead recorded
 *    `blocked`, with the browser's own validation message when one is known;
 *  - strategies — per strategy, how often it applied vs found nothing to do;
 *  - out-of-scope steps — steps that landed off the target (never coverage).
 */

export interface CoverageThresholds {
  /** Minimum share of the target's controls a clean run must have exercised (0..1). */
  readonly minControlRatio: number;
  /** When the target has a form, a clean run must have submitted at least one. */
  readonly requireFormSubmit: boolean;
}

/**
 * Defaults: a quarter of the target's controls, and a submitted form when there is one. Whatever
 * the configuration, a clean run must also have exercised at least one target control — a run that
 * acted on nothing is never clean.
 */
export const DEFAULT_COVERAGE_THRESHOLDS: CoverageThresholds = { minControlRatio: 0.25, requireFormSubmit: true };

/** Resolves (and validates) thresholds. Throws on an out-of-range ratio — a setup error. */
export function resolveCoverageThresholds(partial?: Partial<CoverageThresholds>): CoverageThresholds {
  const t: CoverageThresholds = { ...DEFAULT_COVERAGE_THRESHOLDS, ...partial };
  if (!Number.isFinite(t.minControlRatio) || t.minControlRatio < 0 || t.minControlRatio > 1) {
    throw new Error(`coverage threshold minControlRatio must be between 0 and 1, got ${String(t.minControlRatio)}`);
  }
  return t;
}

export interface StrategyCoverage {
  readonly applied: number;
  readonly foundNothing: number;
}

export interface AdversarialCoverage {
  /**
   * `total` is deliberately NOT the raw count of controls a snapshot saw (`transcript[i].controlCount`,
   * or the DOM's own interactive-element count) — it is the count of DISTINCT EXERCISABLE target
   * controls observed across the run (`isExercisable`: enabled; not secret, file or session-ending;
   * not a link out of scope), on in-scope pages only. A page can show far more raw controls than
   * this (hidden/duplicated across steps, disabled, secret-like, out-of-scope links) — this ratio is
   * never expected to equal a single step's `controlCount` (#121).
   */
  readonly controls: { readonly total: number; readonly exercised: number; readonly ratio: number };
  /** `blocked` (#155): submit attempts the browser refused with native validation — never a submit. */
  readonly forms: { readonly found: number; readonly submitted: number; readonly blocked: number };
  /** Actions executed on the target (any op). */
  readonly actionsOnTarget: number;
  readonly strategies: Readonly<Record<string, StrategyCoverage>>;
  readonly outOfScopeSteps: number;
  readonly thresholds: CoverageThresholds;
  /** Whether the run exercised enough of its target for silence to mean `clean`. */
  readonly sufficient: boolean;
  /** Why not, when it did not (empty when sufficient). */
  readonly shortfalls: string[];
}

/** Accumulates a run's coverage. Only in-scope pages are observed; only on-target actions count. */
export class CoverageTracker {
  readonly #inScope: (url: string) => boolean;
  readonly #controls = new Set<string>();
  readonly #exercised = new Set<string>();
  readonly #forms = new Set<string>();
  readonly #submitted = new Set<string>();
  /** route|formKey -> how many attempts the browser blocked, and its last validation message. */
  readonly #blocked = new Map<string, { count: number; message?: string }>();
  readonly #strategies = new Map<string, { applied: number; foundNothing: number }>();
  #actions = 0;

  constructor(inScope: (url: string) => boolean) {
    this.#inScope = inScope;
  }

  /** Keys (`controlKey`) of the target controls acted on so far. */
  get exercisedKeys(): ReadonlySet<string> {
    return this.#exercised;
  }

  /** Notes the controls and forms of a page (ignored when the page is out of scope). */
  observe(snapshot: Snapshot): void {
    if (!this.#inScope(snapshot.url)) return;
    for (const c of snapshot.controls) if (isExercisable(c, this.#inScope)) this.#controls.add(controlKey(c));
    const route = routeOf(snapshot.url);
    for (const f of detectForms(snapshot.controls, this.#inScope)) this.#forms.add(`${route}|${f.key}`);
  }

  /**
   * An action executed on the target page `url` (on `control`, when it had one). A control acted on
   * successfully is always counted exercised — even one `observe()` never saw yet (e.g. it appeared
   * mid-episode, after an earlier step in the SAME episode revealed it) — so `actionsOnTarget` and
   * `controls.exercised` can never disagree about a control that really was acted on.
   *
   * This ONLY counts the control as exercised. A submit click is never inferred "submitted" from
   * the click alone (#155) — call `submitted()` / `blocked()` once the caller knows whether the
   * click actually sent a request.
   */
  acted(url: string, control: Control | null): void {
    if (!this.#inScope(url)) return;
    this.#actions += 1;
    if (control !== null) {
      const key = controlKey(control);
      this.#exercised.add(key);
      if (isExercisable(control, this.#inScope)) this.#controls.add(key);
    }
  }

  /** A submit click on `formKey` (on page `url`) actually sent a request — #155: a write or a navigation. */
  submitted(url: string, formKey: string): void {
    if (!this.#inScope(url)) return;
    this.#submitted.add(`${routeOf(url)}|${formKey}`);
  }

  /**
   * A submit click on `formKey` (on page `url`) was refused by the browser's own native validation
   * (`required`, `type=email`, `minlength`…) — no request ever left the page, so it never counts
   * toward `forms.submitted` (#155). `message` is the browser's own `validationMessage`, when known.
   */
  blocked(url: string, formKey: string, message?: string): void {
    if (!this.#inScope(url)) return;
    const key = `${routeOf(url)}|${formKey}`;
    const cur = this.#blocked.get(key);
    this.#blocked.set(key, { count: (cur?.count ?? 0) + 1, message: message ?? cur?.message });
  }

  /** A strategy's turn: it applied (planned something) or found nothing to do. */
  strategy(name: string, applied: boolean): void {
    const s = this.#strategies.get(name) ?? { applied: 0, foundNothing: 0 };
    if (applied) s.applied += 1;
    else s.foundNothing += 1;
    this.#strategies.set(name, s);
  }

  report(thresholds: CoverageThresholds, outOfScopeSteps: number): AdversarialCoverage {
    const total = this.#controls.size;
    const exercised = [...this.#exercised].filter((k) => this.#controls.has(k)).length;
    const ratio = total === 0 ? 0 : exercised / total;
    const blockedEntries = [...this.#blocked.entries()].filter(([k]) => this.#forms.has(k));
    const blockedCount = blockedEntries.reduce((sum, [, v]) => sum + v.count, 0);
    const blockedMessage = blockedEntries.map(([, v]) => v.message).find((m): m is string => m !== undefined);
    const forms = {
      found: this.#forms.size,
      submitted: [...this.#submitted].filter((k) => this.#forms.has(k)).length,
      blocked: blockedCount,
    };
    const shortfalls: string[] = [];
    if (total === 0) shortfalls.push("the target offered no control to exercise");
    else if (exercised === 0) shortfalls.push("no target control was exercised");
    if (total > 0 && ratio < thresholds.minControlRatio) {
      shortfalls.push(
        `${exercised}/${total} target controls exercised (${pct(ratio)}), below the ${pct(thresholds.minControlRatio)} threshold`,
      );
    }
    if (thresholds.requireFormSubmit && forms.found > 0 && forms.submitted === 0) {
      // #155: a submit the browser refused with native validation never reached the server — it is
      // never silently counted as a submit, and the shortfall says so (with the message, when known).
      shortfalls.push(
        forms.blocked > 0
          ? `form submitted 0 times (${forms.blocked} attempt${forms.blocked === 1 ? "" : "s"} blocked by validation${blockedMessage === undefined ? "" : `: "${blockedMessage}"`})`
          : `no form was submitted (${forms.found} found)`,
      );
    }
    return {
      controls: { total, exercised, ratio },
      forms,
      actionsOnTarget: this.#actions,
      strategies: Object.fromEntries([...this.#strategies].map(([k, v]) => [k, { ...v }])),
      outOfScopeSteps,
      thresholds,
      sufficient: shortfalls.length === 0,
      shortfalls,
    };
  }
}

function pct(r: number): string {
  return `${Math.round(r * 100)}%`;
}
