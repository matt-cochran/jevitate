// ux-evidence.ts — turning snapshots, transcripts and Recordings into UX evidence (#231).
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import { type Snapshot, type Control as ExploreControl } from "@jevitate/explore";
import { type AppContext, type RunSignalCapture, type Control as UxControl, type ScreenRef, type UxEvidence } from "@jevitate/ux";

export const DEFAULT_JUDGMENT_BUDGET = 40;

function emptyBehavior() {
  return { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 } as const;
}

/** explore's live `Control` → ux `Control` (same shape by design; drop `stability`). */
function toUxControl(c: ExploreControl): UxControl {
  return {
    index: c.index,
    role: c.role,
    name: c.name,
    tag: c.tag,
    inputType: c.inputType,
    enabled: c.enabled,
    summary: c.summary,
    descriptor: c.descriptor,
  };
}

/** a11y facts computable from a live snapshot's controls (honest subset). */
function a11yFactsFromControls(controls: readonly UxControl[]) {
  return {
    controls: controls.map((c) => ({
      controlRef: `control:${c.index}`,
      accessibleName: c.name.trim().length > 0 ? c.name : null,
      focusOrder: c.index,
      targetSize: null,
      contrastRatio: null,
    })),
  };
}

/** A live Snapshot (+ extracted page text) → one screen's UxEvidence. */
export function snapshotToEvidence(
  snap: Snapshot,
  visibleText: string,
  appContext: AppContext,
  job: string | undefined,
  history: readonly ScreenRef[],
): UxEvidence {
  const controls = snap.controls.map(toUxControl);
  return {
    screenId: snap.signature,
    url: snap.url,
    controls,
    visibleText,
    appContext,
    ...(job !== undefined ? { job } : {}),
    history,
    behavior: emptyBehavior(),
    a11yFacts: a11yFactsFromControls(controls),
  };
}

function descriptorSummary(d: TargetDescriptor): string {
  const parts = [d.role, d.name ?? d.testId ?? d.text].filter((s): s is string => !!s);
  return parts.join(" ") || "control";
}

function stepTarget(step: Recording["pages"][number]["steps"][number]["step"]): TargetDescriptor | undefined {
  if ("target" in step && step.target) return step.target;
  return undefined;
}

/**
 * Values the run itself typed or selected — a Recording's own `fill`/`select` steps whose value
 * was NOT redacted (a secret field's value is always `{redacted:true}` and never surfaces here).
 * #85 item 1: feeds the vocabulary/jargon tier (nielsen-2) so a quote/label that is really the
 * user's own content (e.g. a piece title echoed back onto a card) is not mistaken for app copy.
 */
export function extractTypedValues(recording: Recording): string[] {
  const values: string[] = [];
  for (const page of recording.pages) {
    for (const rs of page.steps) {
      const step = rs.step;
      if ((step.kind === "fill" || step.kind === "select") && !("var" in step.value) && !step.value.redacted) {
        values.push(step.value.value);
      }
    }
  }
  return [...new Set(values)];
}

/**
 * The minimal shape of a mission transcript entry `recordingToEvidence` needs — duck-typed against
 * `@jevitate/explore`'s `TranscriptEntry` (this file already imports plenty from there; kept
 * separate so `recordingToEvidence` itself stays decoupled from the live explore-control shape).
 */
export interface MissionTranscriptEntryLike {
  readonly step?: number;
  readonly op?: string | null;
  readonly target?: string | null;
  readonly actOk: boolean;
  readonly reason?: string;
  readonly url: string;
  readonly signature?: string;
  readonly descriptor?: TargetDescriptor;
  readonly value?: string;
  readonly message?: string;
  readonly reply?: { readonly received?: boolean; readonly text?: string };
  readonly screenshot?: string;
}

/**
 * #134: the run-signal capture a transcript ALONE supports (no visible text, no requests) — enough
 * for the journey friction (retries, dead ends, waits, backtracks, abandoned fields) and repeated
 * replies, NOT for the oracles that need requests or page text (they would misfire on the blanks).
 */
export function captureFromTranscript(transcript: readonly MissionTranscriptEntryLike[]): RunSignalCapture {
  const steps = transcript.map((t, i) => ({
    step: t.step ?? i + 1,
    op: t.op ?? null,
    target: t.target ?? null,
    actOk: t.actOk,
    url: t.url,
    ...(t.descriptor === undefined ? {} : { descriptor: t.descriptor }),
    ...(t.reason === undefined ? {} : { reason: t.reason }),
    ...(t.value === undefined ? {} : { value: t.value }),
    ...(t.message === undefined ? {} : { message: t.message }),
    ...(t.reply?.text === undefined || t.reply.received === false ? {} : { reply: t.reply.text }),
  }));
  const screens = transcript.map((t, i) => ({
    index: i,
    step: t.step ?? i + 1,
    at: 0,
    url: t.url,
    signature: t.signature ?? `step:${t.step ?? i + 1}`,
    visibleText: "",
    busy: false,
    ...(t.screenshot === undefined ? {} : { screenshot: t.screenshot }),
  }));
  return { steps, requests: [], screens, endedAt: 0 };
}

const ACTIONABLE_OPS = new Set(["click", "type", "select"]);

/**
 * Blocked/disabled-target controls derived from a mission transcript (#85 item 2), grouped by the
 * page url they were observed on. A failed action is never recorded as a Recording step (see #81:
 * `RunRecorder` records only successful actions), so this is the only source that gives offline
 * `jevitate ux` the same evidence a LIVE usability run sees for free via `Control.enabled` on its
 * snapshot — e.g. a "Pay" button that stayed disabled.
 */
function blockedControlsByUrl(transcript: readonly MissionTranscriptEntryLike[], startIndex: number): Map<string, UxControl[]> {
  const byUrl = new Map<string, UxControl[]>();
  const seen = new Set<string>();
  let idx = startIndex;
  for (const t of transcript) {
    if (t.actOk || t.descriptor === undefined || !t.op || !ACTIONABLE_OPS.has(t.op)) continue;
    const key = `${t.url}|${JSON.stringify(t.descriptor)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = t.descriptor;
    const list = byUrl.get(t.url) ?? [];
    list.push({
      index: idx++,
      role: d.role ?? "",
      name: d.name ?? d.testId ?? d.text ?? "",
      tag: "",
      inputType: null,
      enabled: false,
      summary: `${descriptorSummary(d)} (blocked: ${t.reason ?? "action did not succeed"})`,
      descriptor: d,
    });
    byUrl.set(t.url, list);
  }
  return byUrl;
}

/**
 * A saved Recording → per-page UxEvidence. A Recording is deterministic and
 * thin: it carries the CONTROLS the user touched (via each step's descriptor)
 * and the page url, but NOT the full visible text or a11y geometry. So offline
 * analysis is honestly partial — items needing `visibleText`/`a11yFacts` Skip,
 * and coverage reports it. (The live mode carries the rich per-screen snapshot.)
 *
 * `missionTranscript` (#85 item 2, optional) adds blocked/disabled-target controls the Recording
 * itself cannot carry, on whichever screen(s) share the blocked action's url — the same evidence a
 * live usability run gets from its snapshot. `typedValues` (every screen's own #85 item 1 input)
 * is always derived from the Recording, with or without a transcript.
 */
export function recordingToEvidence(
  recording: Recording,
  appContext: AppContext,
  job?: string,
  missionTranscript?: readonly MissionTranscriptEntryLike[],
): UxEvidence[] {
  const screens: UxEvidence[] = [];
  const history: ScreenRef[] = [];
  const typedValues = extractTypedValues(recording);
  const blockedByUrl = blockedControlsByUrl(missionTranscript ?? [], recording.pages.reduce((n, p) => n + p.steps.length, 0) + 1000);
  for (let i = 0; i < recording.pages.length; i++) {
    const page = recording.pages[i];
    const controls: UxControl[] = [];
    let idx = 0;
    const seen = new Set<string>();
    for (const rs of page.steps) {
      const d = stepTarget(rs.step);
      if (!d) continue;
      const key = JSON.stringify(d);
      if (seen.has(key)) continue;
      seen.add(key);
      controls.push({
        index: idx++,
        role: d.role ?? "",
        name: d.name ?? d.testId ?? d.text ?? "",
        tag: "",
        inputType: null,
        enabled: true,
        summary: descriptorSummary(d),
        descriptor: d,
      });
    }
    for (const blocked of blockedByUrl.get(page.url) ?? []) controls.push(blocked);
    const screenId = `${page.url}#${i}`;
    screens.push({
      screenId,
      url: page.url,
      controls,
      visibleText: "",
      appContext,
      ...(job !== undefined ? { job } : {}),
      history: [...history],
      behavior: emptyBehavior(),
      a11yFacts: { controls: [] },
      ...(typedValues.length > 0 ? { typedValues } : {}),
    });
    history.push({ screenId, url: page.url });
  }
  return screens;
}
