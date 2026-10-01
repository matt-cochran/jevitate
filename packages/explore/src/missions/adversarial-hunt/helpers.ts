/**
 * Pure helpers of the adversarial hunt (`runAdversarialHunt`), moved out of `adversarial.ts`
 * unchanged (#232): the per-step finding / advisory shapes and their freezing, the transcript-reason
 * join, and the live page reads a planned step is checked with. Not part of the public API.
 */

import { descriptorToLocator } from "@jevitate/recorder";
import type { Recording } from "@jevitate/recording";
import type { Page } from "playwright";
import { deltaRecord, type ActionDelta } from "../../action-delta.js";
import { advisoryTitle, signalFingerprint } from "../../adversarial/defect-fingerprint.js";
import type { DefectSignal } from "../../adversarial/defect-oracle.js";
import { FORM_MISUSE_STRATEGIES } from "../../adversarial/form-misuse.js";
import type { MisuseStrategy } from "../../adversarial/misuse.js";
import type { InvariantViolation } from "../../declared-invariants.js";
import type { Triage } from "../../mission-failure.js";
import type { PageMonitor } from "../../page-monitor.js";
import { WRITE_METHODS } from "../../side-effects.js";
import type { Control } from "../../snapshot.js";
import type { AdversarialDefect, AdvisorySignal, DefectRepro, MarkupInjection } from "../adversarial.js";

/** The hunt's default time budget (ms); `adversarial.ts` exports it as `DEFAULT_ADVERSARIAL_TIME_BUDGET_MS`. */
export const DEFAULT_TIME_BUDGET_MS = 10 * 60_000;

export const MAX_LISTED_DEPARTURES = 50;

export const FORM_STRATEGY: ReadonlySet<MisuseStrategy> = new Set(FORM_MISUSE_STRATEGIES);

/**
 * A failed act whose reason names a timeout, or a target this gate refused as not actionable (a
 * visually-hidden skip link, an occluded target) — never re-chosen for the rest of the run (#161,
 * mirroring induction.ts's own `isUnactionableFailure`, #75).
 */
export function isUnactionableFailure(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  return /timeout|not actionable|no longer present/i.test(reason);
}

/** A defect as seen on ONE step, before it is folded into the deduped set. */
export interface StepFinding {
  readonly fingerprint: string;
  readonly related: readonly string[];
  readonly kind: AdversarialDefect["kind"];
  readonly title: string;
  readonly route: string;
  readonly url: string;
  readonly signals: DefectSignal[];
  readonly invariantReason?: string;
  readonly invariant?: InvariantViolation;
  readonly markupInjection?: MarkupInjection;
}

export interface MutableDefect extends Omit<StepFinding, "related"> {
  readonly related: Set<string>;
  /** The recording segment (0 = before any reset) the defect was found in. */
  readonly epoch: number;
  readonly firstSeenStep: number;
  readonly occurrenceSteps: number[];
  readonly repro: DefectRepro;
  readonly triage: Triage;
}

/** An advisory (4xx-correlated or third-party-frame console-error) signal as seen on ONE step, before it is deduped. */
export interface StepAdvisory {
  readonly fingerprint: string;
  readonly title: string;
  readonly route: string;
  readonly url: string;
  readonly status?: number;
  readonly detail: string;
  readonly frameUrl?: string;
  readonly thirdPartyFrame?: string;
}

export interface MutableAdvisory extends StepAdvisory {
  readonly firstSeenStep: number;
  readonly occurrenceSteps: number[];
}

export function freezeAdvisory(a: MutableAdvisory): AdvisorySignal {
  return {
    fingerprint: a.fingerprint,
    kind: "console-error",
    title: a.title,
    route: a.route,
    url: a.url,
    ...(a.status === undefined ? {} : { status: a.status }),
    detail: a.detail,
    ...(a.frameUrl === undefined ? {} : { frameUrl: a.frameUrl }),
    ...(a.thirdPartyFrame === undefined ? {} : { thirdPartyFrame: a.thirdPartyFrame }),
    firstSeenStep: a.firstSeenStep,
    occurrences: a.occurrenceSteps.length,
    occurrenceSteps: [...a.occurrenceSteps],
  };
}

/** Builds a step advisory from a console-error signal already confirmed advisory (`isAdvisoryConsoleError`). */
export function stepAdvisory(signal: Extract<DefectSignal, { kind: "console-error" }>, route: string, url: string): StepAdvisory {
  return {
    fingerprint: signalFingerprint(signal),
    title: advisoryTitle(signal),
    route,
    url,
    ...(signal.thirdPartyFrame === undefined && signal.correlatedStatus !== undefined ? { status: signal.correlatedStatus } : {}),
    detail: signal.detail,
    ...(signal.frameUrl === undefined ? {} : { frameUrl: signal.frameUrl }),
    ...(signal.thirdPartyFrame === undefined ? {} : { thirdPartyFrame: signal.thirdPartyFrame }),
  };
}

export function freeze(d: MutableDefect, segments: readonly (Recording | null)[], deltas: ReadonlyMap<number, ActionDelta> = new Map()): AdversarialDefect {
  const delta = deltas.get(d.firstSeenStep);
  const segment = d.epoch === 0 ? null : (segments[d.epoch] ?? null);
  return {
    fingerprint: d.fingerprint,
    related: [...d.related],
    kind: d.kind,
    title: d.title,
    route: d.route,
    url: d.url,
    signals: d.signals,
    ...(d.invariantReason === undefined ? {} : { invariantReason: d.invariantReason }),
    ...(d.invariant === undefined ? {} : { invariant: d.invariant }),
    ...(d.markupInjection === undefined ? {} : { markupInjection: d.markupInjection }),
    firstSeenStep: d.firstSeenStep,
    occurrences: d.occurrenceSteps.length,
    occurrenceSteps: [...d.occurrenceSteps],
    repro: segment === null ? d.repro : { ...d.repro, recording: segment },
    triage: d.triage,
    ...(delta === undefined ? {} : { actionDelta: deltaRecord(delta) }),
  };
}

/** Joins the non-empty parts of a transcript reason; undefined when there are none. */
export function joinReasons(parts: ReadonlyArray<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => p !== undefined && p !== "");
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * A cheap, read-only LIVE check (never `act()`'s own gate — that one is a different agent's to
 * change): resolves the control right now and reports whether it is currently disabled. False on
 * anything else (not unique, detached, vanished) — that is `act()`'s gate's call to make, not
 * this one's; this check only ever exists to SKIP an attempt it already knows is doomed.
 */
export async function isDisabledNow(page: Page, control: Control): Promise<boolean> {
  try {
    const locator = descriptorToLocator(page, control.descriptor);
    if ((await locator.count()) !== 1) return false;
    return !(await locator.isEnabled());
  } catch {
    return false;
  }
}

/**
 * Whether the click that just fired sent a request attributable to it (#155): a write
 * (POST/PUT/PATCH/DELETE) or a navigation, since `sinceMs` (the click's dispatch time). Checked
 * against what the page monitor has ALREADY observed — in flight, or already finished — with no
 * extra wait: the same immediate, synchronous check the "request(s) in flight" evidence above
 * already relies on (the monitor's request events land before this runs).
 */
export function submitRequestSent(monitor: PageMonitor, sinceMs: number): boolean {
  const isSubmitLike = (method: string, resourceType: string): boolean =>
    WRITE_METHODS.has(method.toUpperCase()) || resourceType === "document";
  if (monitor.pending().some((r) => r.startedAt >= sinceMs && isSubmitLike(r.method, r.resourceType))) return true;
  if (monitor.completedSince(sinceMs).some((r) => r.startedAt >= sinceMs && isSubmitLike(r.method, r.resourceType))) return true;
  return false;
}

/**
 * The browser's own native-validation message for a blocked submit (#155): the first field whose
 * constraint validation currently fails. Read live (never `status.ts`'s stateful `invalid`-event
 * tracking, which only catches events after ITS listener is installed — too late for the very
 * first blocked submit of a run): the click that was just refused ran the browser's own validation
 * a moment ago, so a `checkValidity()` read right now names exactly what blocked it.
 */
export async function nativeValidationMessage(page: Page): Promise<string | undefined> {
  return page
    .evaluate(() => {
      const fields = Array.from(document.querySelectorAll("input,select,textarea")) as Array<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >;
      for (const f of fields) {
        if (typeof f.checkValidity === "function" && !f.checkValidity()) return f.validationMessage || null;
      }
      return null;
    })
    .then((m) => m ?? undefined)
    .catch(() => undefined);
}

/** A native select's first enabled option other than the current one (null: none, or not a select). */
export async function otherOption(page: Page, control: Control): Promise<string | null> {
  try {
    return await descriptorToLocator(page, control.descriptor).evaluate((el) => {
      if (!(el instanceof HTMLSelectElement)) return null;
      const other = Array.from(el.options).find((o) => !o.disabled && o.value !== el.value);
      return other === undefined ? null : other.value;
    });
  } catch {
    return null;
  }
}
