// signals.ts — usability findings from CONCRETE, verifiable run signals (#96).
//
// The rubric tier asks Jev whether a screen violates a principle; this tier asks nothing of a
// model. It reads what the run itself measured — the requests it saw (method, endpoint, status,
// start/end), the screens it observed (url, signature, visible text, a busy indicator) and the
// steps it took — and applies app-agnostic, mechanical oracles:
//
//   - hung request   — a request pending far past the run's own typical settle time while no
//                      screen in that window showed any status (a job that silently hangs);
//   - duplicate write — the same control clicked twice on the same page, and the same write
//                      request (POST/PUT/PATCH/DELETE) succeeded both times (a double launch);
//   - internal id    — a UUID/ObjectId/prefixed-id-shaped string rendered in user-facing text
//                      that the run did not type itself;
//   - inert control  — a successful click after which nothing observable changed: same url,
//                      same screen signature, same visible text, and no request.
//
// Each finding cites its evidence (step, requests, text, screenshot) and carries a confidence
// derived from the strength of that evidence — never from a model. They are UxFindings with tier
// `signal`, so they go through the report's --min-confidence suppression like every other finding
// (they are ungraded, like the objective a11y tier, so the quality policy does not apply).
//
// Inputs arrive ALREADY REDACTED (the capture layer redacts urls/text before they reach here).
import type { TargetDescriptor } from "@jevitate/recording";
import { clamp01, round2 } from "./confidence.js";
import { routeOf } from "./route.js";
import type { AnalysisOutcome, EvidenceRef, UxFinding } from "./types.js";

/** One request the run observed. */
export interface SignalRequest {
  /** Stable index within the capture (the `request:<id>` evidence ref). */
  readonly id: number;
  readonly method: string;
  /** `METHOD /normalized/path`. */
  readonly endpoint: string;
  /** Redacted URL. */
  readonly url: string;
  /** Playwright resource type (`fetch`, `xhr`, `document`, …). */
  readonly resourceType: string;
  readonly startedAt: number;
  /** When it finished or failed; `null` = still pending when the run ended. */
  readonly endedAt: number | null;
  readonly status: number | null;
  readonly failed?: boolean;
  /** The step whose action it followed (`0` = before the first decision). */
  readonly step: number;
}

/** One screen the run observed (the state a step was decided on). */
export interface SignalScreen {
  readonly index: number;
  /** The step decided on this screen. */
  readonly step: number;
  readonly at: number;
  readonly url: string;
  readonly signature: string;
  /** Redacted visible text. */
  readonly visibleText: string;
  /** A progress/busy/status indicator was on screen (aria-busy, progressbar, role=status…). */
  readonly busy: boolean;
  /** Where this screen's screenshot was written, if one was. */
  readonly screenshot?: string;
}

/** One transcript step (the fields the oracles need). */
export interface SignalStep {
  readonly step: number;
  readonly op: string | null;
  readonly target: string | null;
  readonly actOk: boolean;
  readonly url: string;
  readonly descriptor?: TargetDescriptor;
}

export interface RunSignalCapture {
  readonly steps: readonly SignalStep[];
  readonly requests: readonly SignalRequest[];
  readonly screens: readonly SignalScreen[];
  /** When the run ended (a still-pending request's duration runs to here). */
  readonly endedAt: number;
  /** Values the run typed itself: an id it typed is its own content, not a leak. */
  readonly typedValues?: readonly string[];
}

export interface SignalOptions {
  /** A request is hung past this multiple of the run's typical (p50) request time. Default 10. */
  readonly hungFactor?: number;
  /** …and never below this floor (ms). Default 15 000. */
  readonly hungFloorMs?: number;
}

export type SignalKind = "hung-request" | "duplicate-write" | "internal-id" | "inert-control";

/** The evidence a signal finding cites — what a reader checks to verify it. */
export interface SignalEvidence {
  readonly kind: SignalKind;
  /** The transcript step(s) the signal was observed at. */
  readonly steps: readonly number[];
  readonly requests: readonly {
    readonly id: number;
    readonly method: string;
    readonly url: string;
    readonly status: number | null;
    readonly durationMs: number;
    readonly pending: boolean;
    readonly step: number;
  }[];
  /** The on-screen text the signal is about (an id's line), if any. */
  readonly text?: string;
  /** The screenshot of the screen the signal was observed on, if one was written. */
  readonly screenshot?: string;
  /** The measurement behind the finding, and how its confidence was derived. */
  readonly detail: string;
}

const NNG = { source: "Nielsen Norman Group — 10 Usability Heuristics", ref: "nngroup.com/articles/ten-usability-heuristics" } as const;

/** The signal "rubric": id → principle, citation, severity. */
export const SIGNAL_RULES: Readonly<
  Record<SignalKind, { readonly id: string; readonly principle: string; readonly citation: { source: string; ref: string }; readonly severity: UxFinding["severity"] }>
> = {
  "hung-request": { id: "signal-hung-request", principle: "Visibility of system status", citation: NNG, severity: "major" },
  "duplicate-write": { id: "signal-duplicate-write", principle: "Error prevention", citation: NNG, severity: "major" },
  "internal-id": { id: "signal-internal-id", principle: "Match between system and the real world", citation: NNG, severity: "minor" },
  "inert-control": { id: "signal-inert-control", principle: "Visibility of system status", citation: NNG, severity: "minor" },
};

export class SignalFindingError extends Error {
  readonly code = "E_UX_FINDING_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "SignalFindingError";
  }
}

interface SignalFindingInput {
  readonly kind: SignalKind;
  readonly confidence: number;
  readonly url: string;
  readonly screenId: string;
  readonly observation: string;
  readonly userImpact: string;
  readonly recommendation: string;
  readonly controls?: readonly string[];
  readonly quotes?: readonly string[];
  readonly occurrences?: number;
  readonly screenIds?: readonly string[];
  readonly evidence: SignalEvidence;
}

/**
 * The single construction path for a signal finding — the same gate as `makeFinding`: a cited
 * rule, at least one step of evidence, a non-empty observation/impact/recommendation, and a
 * confidence in [0,1].
 */
export function makeSignalFinding(input: SignalFindingInput): UxFinding {
  const rule = SIGNAL_RULES[input.kind];
  if (input.evidence.steps.length === 0) throw new SignalFindingError(`evidence gate: a ${rule.id} finding must cite at least one step`);
  for (const [field, value] of [
    ["observation", input.observation],
    ["userImpact", input.userImpact],
    ["recommendation", input.recommendation],
  ] as const) {
    if (value.trim().length === 0) throw new SignalFindingError(`specificity gate: a ${rule.id} finding must carry a non-empty ${field}`);
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new SignalFindingError(`confidence for '${rule.id}' must be in [0,1], got ${input.confidence}`);
  }
  const refs: EvidenceRef[] = [
    ...input.evidence.steps.map((s) => ({ id: `step:${s}` })),
    ...input.evidence.requests.map((r) => ({ id: `request:${r.id}` })),
    ...(input.evidence.screenshot === undefined ? [] : [{ id: `screenshot:${input.evidence.screenshot}` }]),
  ];
  const finding: UxFinding = {
    rubricItemId: rule.id,
    citation: { ...rule.citation },
    severity: rule.severity,
    confidence: round2(input.confidence),
    evidenceRefs: refs,
    observation: input.observation.trim(),
    userImpact: input.userImpact.trim(),
    recommendation: input.recommendation.trim(),
    tier: "signal",
    screenId: input.screenId,
    route: routeOf(input.url),
    controls: [...(input.controls ?? [])],
    quotes: [...(input.quotes ?? [])],
    occurrences: input.occurrences ?? 1,
    screenIds: [...(input.screenIds ?? [input.screenId])],
    signal: input.evidence,
  };
  return Object.freeze(finding);
}

// ---------- helpers ----------

const API_TYPES = new Set(["fetch", "xhr"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** On-screen words that tell the user work is in progress. */
const BUSY_TEXT = /\b(loading|processing|running|in progress|please wait|pending|queued|working on|simulating|generating|saving|submitting|uploading)\b|…|\.\.\.|\b\d{1,3}\s?%/i;

function durationOf(r: SignalRequest, endedAt: number): number {
  return Math.max(0, (r.endedAt ?? endedAt) - r.startedAt);
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function requestEvidence(r: SignalRequest, endedAt: number): SignalEvidence["requests"][number] {
  return { id: r.id, method: r.method, url: r.url, status: r.status, durationMs: durationOf(r, endedAt), pending: r.endedAt === null, step: r.step };
}

function secs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`;
}

function okStatus(r: SignalRequest): boolean {
  return r.failed !== true && r.status !== null && r.status >= 200 && r.status < 400;
}

function controlKey(s: SignalStep): string {
  return s.descriptor === undefined ? `target:${s.target ?? ""}` : JSON.stringify(s.descriptor);
}

/** Positive step numbers, deduped and ordered (a screen's step is always ≥ 1). */
function uniqueSteps(steps: readonly number[]): number[] {
  return [...new Set(steps.filter((s) => s > 0))].sort((a, b) => a - b);
}

function quoteLine(text: string, needle: string): string {
  const line = text.split(/\n/).find((l) => l.includes(needle)) ?? needle;
  const t = line.replace(/\s+/g, " ").trim();
  return t.length <= 160 ? t : `${t.slice(0, 157)}...`;
}

// ---------- oracles ----------

/** A request pending far past the run's typical request time while no screen showed any status. */
export function detectHungRequests(capture: RunSignalCapture, opts: SignalOptions = {}): UxFinding[] {
  const factor = opts.hungFactor ?? 10;
  const floor = opts.hungFloorMs ?? 15_000;
  const api = capture.requests.filter((r) => API_TYPES.has(r.resourceType));
  const done = api.filter((r) => r.endedAt !== null).map((r) => durationOf(r, capture.endedAt));
  const typical = done.length >= 3 ? median(done) : null;
  const threshold = Math.max(floor, typical === null ? 0 : factor * typical);
  const byEndpoint = new Map<string, { r: SignalRequest; d: number; screens: SignalScreen[] }[]>();
  for (const r of api) {
    const d = durationOf(r, capture.endedAt);
    if (d < threshold) continue;
    const end = r.endedAt ?? capture.endedAt;
    const during = capture.screens.filter((s) => s.at >= r.startedAt && s.at <= end);
    // "The UI shows no status": at least one screen observed while it was pending, none busy.
    if (during.length === 0 || during.some((s) => s.busy || BUSY_TEXT.test(s.visibleText))) continue;
    const list = byEndpoint.get(r.endpoint) ?? [];
    list.push({ r, d, screens: during });
    byEndpoint.set(r.endpoint, list);
  }
  const out: UxFinding[] = [];
  for (const [endpoint, hits] of byEndpoint) {
    const worst = hits.reduce((a, b) => (b.d > a.d ? b : a));
    const last = worst.screens[worst.screens.length - 1]!;
    const pending = worst.r.endedAt === null;
    const ratio = worst.d / threshold;
    const confidence = clamp01(0.6 + 0.1 * Math.min(3, Math.log2(ratio)) + (pending ? 0.05 : 0) + (worst.screens.length >= 2 ? 0.05 : 0));
    const typicalNote = typical === null ? `the ${secs(floor)} floor (too few requests for a typical time)` : `${factor}× the run's typical request time of ${secs(typical)}`;
    out.push(
      makeSignalFinding({
        kind: "hung-request",
        confidence: Math.min(0.95, confidence),
        url: last.url,
        screenId: last.signature,
        observation: `${endpoint} was ${pending ? "still pending when the run ended" : "pending"} after ${secs(worst.d)} (past ${typicalNote}), and none of the ${worst.screens.length} screen(s) observed meanwhile showed any progress or status.`,
        userImpact: "The user cannot tell that work is still running, whether it failed, or whether to wait, retry or leave — and a retry may launch the work twice.",
        recommendation: `Show a visible, updating status for the work behind ${endpoint} (progress, or at least "still running…"), and surface a timeout or failure instead of an indefinite silent wait.`,
        occurrences: hits.length,
        screenIds: [...new Set(hits.flatMap((h) => h.screens.map((s) => s.signature)))],
        evidence: {
          kind: "hung-request",
          steps: uniqueSteps([worst.r.step, ...worst.screens.map((s) => s.step)]),
          requests: hits.map((h) => requestEvidence(h.r, capture.endedAt)),
          ...(last.screenshot === undefined ? {} : { screenshot: last.screenshot }),
          detail: `pending ${secs(worst.d)} vs threshold ${secs(threshold)} (${Math.round(ratio * 10) / 10}×); ${worst.screens.length} screen(s) without status; confidence from the overrun ratio, whether it never finished, and how many screens stayed silent`,
        },
      }),
    );
  }
  return out;
}

/** The same control clicked twice on the same page, and the same write request succeeded both times. */
export function detectDuplicateWrites(capture: RunSignalCapture): UxFinding[] {
  const clicks = capture.steps.filter((s) => s.op === "click" && s.actOk);
  const byControl = new Map<string, SignalStep[]>();
  for (const s of clicks) {
    const k = `${s.url}|${controlKey(s)}`;
    byControl.set(k, [...(byControl.get(k) ?? []), s]);
  }
  const out: UxFinding[] = [];
  for (const steps of byControl.values()) {
    if (steps.length < 2) continue;
    const stepNos = new Set(steps.map((s) => s.step));
    const writes = capture.requests.filter((r) => stepNos.has(r.step) && WRITE_METHODS.has(r.method.toUpperCase()) && okStatus(r));
    const byEndpoint = new Map<string, SignalRequest[]>();
    for (const r of writes) byEndpoint.set(r.endpoint, [...(byEndpoint.get(r.endpoint) ?? []), r]);
    for (const [endpoint, reqs] of byEndpoint) {
      const firing = [...new Set(reqs.map((r) => r.step))].sort((a, b) => a - b);
      if (firing.length < 2) continue;
      const first = firing[0]!;
      const lastStep = firing[firing.length - 1]!;
      const method = reqs[0]!.method.toUpperCase();
      // Input changed between the clicks ⇒ the repeat may be a deliberate second submission.
      const edited = capture.steps.some((s) => s.step > first && s.step < lastStep && (s.op === "type" || s.op === "select") && s.actOk);
      const base = method === "POST" ? 0.8 : method === "PUT" ? 0.5 : 0.6;
      const confidence = clamp01(base * (edited ? 0.6 : 1) + 0.05 * Math.min(2, firing.length - 2));
      const target = steps[0]!.target ?? "the control";
      const screen = capture.screens.filter((s) => s.step === lastStep).pop() ?? capture.screens.filter((s) => s.step <= lastStep).pop();
      out.push(
        makeSignalFinding({
          kind: "duplicate-write",
          confidence,
          url: steps[0]!.url,
          screenId: screen?.signature ?? `step:${lastStep}`,
          observation: `Clicking ${target} again (steps ${firing.join(", ")}) fired ${endpoint} ${firing.length} times, and every one succeeded${edited ? " (input was edited between the clicks)" : ""} — the repeat created a second side effect instead of being prevented.`,
          userImpact: "A user who clicks again (impatience, a slow response, a double click) launches the same work twice — duplicate records, duplicate charges or duplicate jobs.",
          recommendation: `Disable or guard ${target} while its request is in flight and after it succeeds, and make ${endpoint} idempotent (an idempotency key, or reject a duplicate).`,
          controls: [target],
          occurrences: firing.length,
          evidence: {
            kind: "duplicate-write",
            steps: firing,
            requests: reqs.map((r) => requestEvidence(r, capture.endedAt)),
            ...(screen?.screenshot === undefined ? {} : { screenshot: screen.screenshot }),
            detail: `${firing.length} successful ${method} ${endpoint} from repeated clicks on one control; confidence ${method === "POST" ? "high for a non-idempotent POST" : `lower for ${method}`}${edited ? ", reduced because input changed between the clicks" : ""}`,
          },
        }),
      );
    }
  }
  return out;
}

const ID_PATTERNS: readonly { readonly name: string; readonly re: RegExp; readonly base: number }[] = [
  { name: "UUID", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, base: 0.8 },
  { name: "ObjectId-shaped hex id", re: /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{24}\b/gi, base: 0.6 },
  { name: "prefixed internal id", re: /\b[a-z]{2,8}_(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}\b/g, base: 0.55 },
];
/** A line that labels the id as a reference the user may need (support id, order number…). */
const INTENTIONAL_ID = /\b(id|identifier|reference|ref|order|request|trace|correlation|transaction|invoice|ticket|tracking)\b\s*(no\.?|number|#)?\s*[:#]/i;

/** A UUID/ObjectId/prefixed-id-shaped string in user-facing text the run did not type itself. */
export function detectInternalIds(capture: RunSignalCapture): UxFinding[] {
  const typed = (capture.typedValues ?? []).join("\n");
  const groups = new Map<string, { pattern: (typeof ID_PATTERNS)[number]; ids: Set<string>; lines: Set<string>; screens: SignalScreen[]; intentional: boolean }>();
  for (const screen of capture.screens) {
    for (const pattern of ID_PATTERNS) {
      for (const m of screen.visibleText.matchAll(pattern.re)) {
        const id = m[0];
        if (typed.includes(id)) continue;
        const line = quoteLine(screen.visibleText, id);
        const key = `${routeOf(screen.url)}|${pattern.name}`;
        const g = groups.get(key) ?? { pattern, ids: new Set<string>(), lines: new Set<string>(), screens: [], intentional: true };
        g.ids.add(id);
        g.lines.add(line);
        if (!g.screens.includes(screen)) g.screens.push(screen);
        g.intentional = g.intentional && INTENTIONAL_ID.test(line);
        groups.set(key, g);
      }
    }
  }
  const out: UxFinding[] = [];
  for (const g of groups.values()) {
    const first = g.screens[0]!;
    const quotes = [...g.lines].slice(0, 3);
    const confidence = clamp01(g.pattern.base * (g.intentional ? 0.5 : 1) + 0.05 * Math.min(2, g.screens.length - 1));
    out.push(
      makeSignalFinding({
        kind: "internal-id",
        confidence,
        url: first.url,
        screenId: first.signature,
        observation: `A raw ${g.pattern.name} is shown to the user as text: ${quotes.map((q) => `"${q}"`).join("; ")}.`,
        userImpact: "An internal identifier means nothing to the user where they expect a name or label; it reads as a broken or unfinished screen and hides what the item actually is.",
        recommendation: "Render the entity's human-readable name (or a short, labeled reference only where the user needs one) instead of the internal id.",
        quotes,
        occurrences: g.screens.length,
        screenIds: g.screens.map((s) => s.signature),
        evidence: {
          kind: "internal-id",
          steps: uniqueSteps(g.screens.map((s) => s.step)),
          requests: [],
          text: quotes[0]!,
          ...(first.screenshot === undefined ? {} : { screenshot: first.screenshot }),
          detail: `${g.ids.size} distinct ${g.pattern.name}(s) on ${g.screens.length} screen(s), none typed by the run${g.intentional ? "; confidence halved: the line labels it as a reference" : ""}`,
        },
      }),
    );
  }
  return out;
}

/** A successful click after which nothing observable changed (url, screen, text) and no request fired. */
export function detectInertControls(capture: RunSignalCapture): UxFinding[] {
  const inert = new Map<string, { step: SignalStep; before: SignalScreen; after: SignalScreen }[]>();
  for (const s of capture.steps) {
    if (s.op !== "click" || !s.actOk) continue;
    const before = capture.screens.filter((x) => x.step === s.step).pop();
    const after = capture.screens.find((x) => x.step > s.step);
    if (before === undefined || after === undefined) continue;
    if (after.url !== before.url || after.signature !== before.signature || after.visibleText !== before.visibleText) continue;
    if (capture.requests.some((r) => r.step === s.step)) continue;
    const k = `${s.url}|${controlKey(s)}`;
    inert.set(k, [...(inert.get(k) ?? []), { step: s, before, after }]);
  }
  const out: UxFinding[] = [];
  for (const hits of inert.values()) {
    const target = hits[0]!.step.target ?? "the control";
    const n = hits.length;
    const confidence = n >= 3 ? 0.8 : n === 2 ? 0.7 : 0.5;
    const last = hits[n - 1]!;
    out.push(
      makeSignalFinding({
        kind: "inert-control",
        confidence,
        url: last.after.url,
        screenId: last.after.signature,
        observation: `Clicking ${target} ${n > 1 ? `(${n} times, steps ${hits.map((h) => h.step.step).join(", ")}) ` : `(step ${last.step.step}) `}changed nothing: same page, same screen, same text, and no request was sent.`,
        userImpact: "The user activates the control and gets no response at all — they cannot tell whether it is broken, disabled or waiting, and the path it promises is a dead end.",
        recommendation: `Make ${target} do what it says, or disable/hide it (with the reason) when it cannot act; at minimum give visible feedback on activation.`,
        controls: [target],
        occurrences: n,
        screenIds: [...new Set(hits.map((h) => h.after.signature))],
        evidence: {
          kind: "inert-control",
          steps: hits.map((h) => h.step.step),
          requests: [],
          ...(last.after.screenshot === undefined ? {} : { screenshot: last.after.screenshot }),
          detail: `${n} successful click(s) with no url/signature/text change and zero requests; confidence grows with repeated inert clicks`,
        },
      }),
    );
  }
  return out;
}

/** Every signal oracle over one run's capture. */
export function detectSignals(capture: RunSignalCapture, opts: SignalOptions = {}): UxFinding[] {
  return [...detectHungRequests(capture, opts), ...detectDuplicateWrites(capture), ...detectInternalIds(capture), ...detectInertControls(capture)];
}

/**
 * Adds signal findings to an analysis outcome, so they reach `buildReport` — and its
 * --min-confidence suppression — exactly like rubric findings. A failed analysis is left as is.
 */
export function withSignalFindings(outcome: AnalysisOutcome, findings: readonly UxFinding[]): AnalysisOutcome {
  if (outcome.kind === "failed" || findings.length === 0) return outcome;
  return {
    ...outcome,
    findings: [...outcome.findings, ...findings],
    rawOccurrences: (outcome.rawOccurrences ?? outcome.findings.length) + findings.reduce((n, f) => n + f.occurrences, 0),
  };
}
