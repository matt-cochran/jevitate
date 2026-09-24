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
import { writeClassifier, type TargetDescriptor } from "@jevitate/recording";
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
  /** The REQUEST's content type, when it sent one (tells a gRPC-web/Connect read, #110). */
  readonly contentType?: string;
  /**
   * #131: a one-way digest of the request's (redacted) body with volatile keys (ids, timestamps,
   * nonces) dropped — two creates with the same key sent the same payload. Never the body itself.
   */
  readonly payloadKey?: string;
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
  /** #131: the page's main heading (first h1, else the document title), redacted. */
  readonly heading?: string;
}

/** One transcript step (the fields the oracles need). */
export interface SignalStep {
  readonly step: number;
  readonly op: string | null;
  readonly target: string | null;
  readonly actOk: boolean;
  readonly url: string;
  readonly descriptor?: TargetDescriptor;
  /** The transcript's reason for the step (e.g. the run's own refusal to repeat a side effect, #92). */
  readonly reason?: string;
  /** #131: the (redacted) value a `type`/`select` step entered. */
  readonly value?: string;
  /** #131: the (redacted) message a `send` step sent. */
  readonly message?: string;
  /** #131: the (redacted) conversational reply awaited after a sent message. */
  readonly reply?: string;
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
  /** Extra read-request patterns for the write classifier (`--read-rpc`, #110). */
  readonly readRequests?: readonly string[];
  /** #131: a started job is stuck past this multiple of the run's typical request time. Default 10. */
  readonly stuckFactor?: number;
  /** …and never below this floor (ms). Default 30 000. */
  readonly stuckFloorMs?: number;
  /** #131: the same assistant reply this many times is a finding (error/fallback copy: 2). Default 3. */
  readonly repeatedReplyMin?: number;
}

export type SignalKind =
  | "hung-request"
  | "duplicate-write"
  | "internal-id"
  | "inert-control"
  | "stuck-job"
  | "repeated-reply"
  | "duplicate-create"
  | "failed-submit"
  | "url-mismatch";

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
  "stuck-job": { id: "signal-stuck-job", principle: "Visibility of system status", citation: NNG, severity: "major" },
  "repeated-reply": { id: "signal-repeated-reply", principle: "Help users recognize, diagnose, and recover from errors", citation: NNG, severity: "major" },
  "duplicate-create": { id: "signal-duplicate-create", principle: "Error prevention", citation: NNG, severity: "major" },
  "failed-submit": { id: "signal-failed-submit", principle: "Help users recognize, diagnose, and recover from errors", citation: NNG, severity: "major" },
  "url-mismatch": { id: "signal-url-mismatch", principle: "Consistency and standards", citation: NNG, severity: "minor" },
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

/**
 * The same control clicked twice on the same page, and the same write request succeeded both times.
 * A write is classified by the shared classifier (#110): a gRPC-web/Connect read (`POST
 * /pkg.Svc/GetX`, a re-render double-fetch) is idempotent and never a duplicate write.
 */
export function detectDuplicateWrites(capture: RunSignalCapture, opts: SignalOptions = {}): UxFinding[] {
  const classify = writeClassifier(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests });
  const isWrite = (r: SignalRequest): boolean => classify({ method: r.method, path: r.url, contentType: r.contentType ?? null });
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
    const writes = capture.requests.filter((r) => stepNos.has(r.step) && isWrite(r) && okStatus(r));
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
  const reported = new Set(out.flatMap((f) => f.controls ?? []));

  // One click that fired the same write more than once: the app itself double-submits.
  for (const click of clicks) {
    const writes = capture.requests.filter((r) => r.step === click.step && isWrite(r) && okStatus(r));
    const byEndpoint = new Map<string, SignalRequest[]>();
    for (const r of writes) byEndpoint.set(r.endpoint, [...(byEndpoint.get(r.endpoint) ?? []), r]);
    for (const [endpoint, reqs] of byEndpoint) {
      const target = click.target ?? "the control";
      if (reqs.length < 2 || reported.has(target)) continue;
      reported.add(target);
      const method = reqs[0]!.method.toUpperCase();
      const screen = capture.screens.filter((sc) => sc.step <= click.step).pop();
      out.push(
        makeSignalFinding({
          kind: "duplicate-write",
          confidence: method === "POST" ? 0.8 : 0.6,
          url: click.url,
          screenId: screen?.signature ?? `step:${click.step}`,
          observation: `A single click on ${target} (step ${click.step}) fired ${method} ${endpoint} ${reqs.length} times, and every one succeeded — one action created ${reqs.length} side effects.`,
          userImpact: "One click launches the same work several times — duplicate records, duplicate charges or duplicate jobs.",
          recommendation: `Make ${target} submit once per activation, and make ${endpoint} idempotent (an idempotency key, or reject a duplicate).`,
          controls: [target],
          occurrences: reqs.length,
          evidence: {
            kind: "duplicate-write",
            steps: [click.step],
            requests: reqs.map((r) => requestEvidence(r, capture.endedAt)),
            ...(screen?.screenshot === undefined ? {} : { screenshot: screen.screenshot }),
            detail: `${reqs.length} successful ${method} ${endpoint} from one click`,
          },
        }),
      );
    }
  }

  // The run itself refused to click again (#92: its write already succeeded and the page offers no
  // retry) — yet the control was still there to click. No duplicate was sent, so the evidence is the
  // unguarded control plus the successful write, at a lower confidence than an observed duplicate.
  for (const refusal of capture.steps) {
    if (!/^repeated side effect refused: .*already sent .*does not offer a retry/.test(refusal.reason ?? "")) continue;
    const target = refusal.target ?? "the control";
    if (reported.has(target)) continue;
    const earlier = clicks.filter((c) => c.step < refusal.step && c.url === refusal.url && controlKey(c) === controlKey(refusal));
    const first = earlier[earlier.length - 1];
    if (first === undefined) continue;
    const reqs = capture.requests.filter((r) => r.step === first.step && isWrite(r) && okStatus(r));
    if (reqs.length === 0) continue;
    reported.add(target);
    const method = reqs[0]!.method.toUpperCase();
    const endpoint = reqs[0]!.endpoint;
    const screen = capture.screens.filter((sc) => sc.step <= refusal.step).pop();
    out.push(
      makeSignalFinding({
        kind: "duplicate-write",
        confidence: method === "POST" ? 0.55 : 0.4,
        url: refusal.url,
        screenId: screen?.signature ?? `step:${refusal.step}`,
        observation: `After ${method} ${endpoint} from ${target} succeeded (step ${first.step}), ${target} was still available to click again (step ${refusal.step}) with nothing on the page preventing a second submission; jevitate declined to repeat it.`,
        userImpact: "A user who clicks again (impatience, a slow response, a double click) would launch the same work twice — duplicate records, duplicate charges or duplicate jobs.",
        recommendation: `Disable or guard ${target} after its request succeeds, and make ${endpoint} idempotent (an idempotency key, or reject a duplicate).`,
        controls: [target],
        occurrences: 1,
        evidence: {
          kind: "duplicate-write",
          steps: [first.step, refusal.step],
          requests: reqs.map((r) => requestEvidence(r, capture.endedAt)),
          ...(screen?.screenshot === undefined ? {} : { screenshot: screen.screenshot }),
          detail: `the control stayed actionable after a successful ${method}; no duplicate was sent (the run refused the repeat), so confidence is lower than for an observed duplicate`,
        },
      }),
    );
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
  const journey = detectJourneySignals(capture, opts);
  return [
    ...detectHungRequests(capture, opts),
    ...withoutSubsumedDuplicateWrites(detectDuplicateWrites(capture, opts), journey),
    ...detectInternalIds(capture),
    ...detectInertControls(capture),
    ...journey,
  ];
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

// ---------- journey oracles (#131): defect shapes the run walked past ----------
//
//   - stuck job        — a job the user started (a successful write) shows no result far past the
//                        run's typical request time, while the page still offers the action that starts
//                        it (the user is invited to launch it again);
//   - repeated reply   — the same assistant reply (typically canned error/fallback copy) came back
//                        across several sent messages;
//   - duplicate create — two successful creates with the same payload (the same typed field values,
//                        or the same body digest), optionally confirmed by the item listed twice;
//   - failed submit    — a user-initiated write answered 4xx/5xx (or failed) and the next screen
//                        showed no error, or only generic "something went wrong" copy;
//   - url mismatch     — the page's heading belongs to a different route than its URL (e.g.
//                        onboarding content still under /login).

/** On-screen copy that tells the user something failed. */
const ERROR_TEXT =
  /\b(error|errors|failed|failure|went wrong|unavailable|couldn['’]?t|could not|can['’]?t|cannot|unable|try again|invalid|problem|denied|forbidden|expired|not (?:be )?(?:saved|sent|found|recorded))\b/i;
/** Generic error copy that names no cause and no recovery. */
const GENERIC_ERROR = /\b(something went wrong|an? (?:unexpected |unknown )?error (?:has )?occurred|unexpected error|oops|try again later)\b/i;
const START_OPS = new Set(["click", "send", "press", "submit"]);
const FIELD_OPS = new Set(["type", "select"]);

function normLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The label a step acted on: the quoted name in `button "Run the simulation →"`, else the descriptor's name. */
function labelOf(s: SignalStep): string | null {
  const quoted = /"([^"]{2,160})"/.exec(s.target ?? "")?.[1];
  const raw = quoted ?? s.descriptor?.name ?? s.descriptor?.text ?? null;
  if (raw === null || raw === undefined) return null;
  const t = raw.replace(/[→←↗›»…]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length >= 2 ? t : null;
}

function screenBefore(capture: RunSignalCapture, step: number): SignalScreen | undefined {
  return capture.screens.filter((s) => s.step <= step).pop();
}

function screenAfter(capture: RunSignalCapture, step: number): SignalScreen | undefined {
  return capture.screens.find((s) => s.step > step);
}

/** The shared write classifier (#110): a gRPC-web/Connect read over POST is not a write. */
const classifyWrite = writeClassifier();

function isWrite(r: SignalRequest): boolean {
  return (
    classifyWrite({ method: r.method, path: r.url, contentType: r.contentType ?? null }) &&
    (API_TYPES.has(r.resourceType) || r.resourceType === "document")
  );
}

function linesOf(text: string): string[] {
  return text
    .split(/\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

function countOf(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function shotOf(screen: SignalScreen | undefined): { screenshot?: string } {
  return screen?.screenshot === undefined ? {} : { screenshot: screen.screenshot };
}

/** A job started by a successful write shows no result far past the run's norm, while its start action is still offered. */
export function detectStuckJobs(capture: RunSignalCapture, opts: SignalOptions = {}): UxFinding[] {
  const factor = opts.stuckFactor ?? 10;
  const floor = opts.stuckFloorMs ?? 30_000;
  // The run's norm: its typical (p50) API request time — how long this app usually takes to answer.
  const done = capture.requests.filter((r) => API_TYPES.has(r.resourceType) && r.endedAt !== null).map((r) => durationOf(r, capture.endedAt));
  const norm = done.length >= 3 ? median(done) : null;
  const threshold = Math.max(floor, norm === null ? 0 : factor * norm);
  const out: UxFinding[] = [];
  const reported = new Set<string>();
  for (const start of capture.steps) {
    if (!start.op || !START_OPS.has(start.op) || !start.actOk) continue;
    const label = labelOf(start);
    if (label === null) continue;
    const route = routeOf(start.url);
    const key = `${route}|${normLine(label)}`;
    if (reported.has(key)) continue;
    const writes = capture.requests.filter((r) => r.step === start.step && isWrite(r) && okStatus(r));
    if (writes.length === 0) continue;
    // The window: later steps on the same route, until another control fires a write (the user moved on).
    const window: SignalStep[] = [];
    for (const s of capture.steps.filter((x) => x.step > start.step)) {
      if (routeOf(s.url) !== route) break;
      const other = s.op !== null && START_OPS.has(s.op) && controlKey(s) !== controlKey(start);
      if (other && capture.requests.some((r) => r.step === s.step && isWrite(r) && okStatus(r))) break;
      window.push(s);
    }
    const lastStep = window.length > 0 ? window[window.length - 1]!.step : start.step;
    const screens = capture.screens.filter((s) => s.step > start.step && s.step <= lastStep + 1 && routeOf(s.url) === route);
    if (screens.length === 0) continue;
    const reclicks = window.filter((s) => s.op === start.op && s.actOk && controlKey(s) === controlKey(start));
    const waits = window.filter((s) => s.op === "wait" || s.op === "reload");
    const busy = screens.filter((s) => s.busy || BUSY_TEXT.test(s.visibleText));
    const polled = new Map<string, SignalRequest[]>();
    for (const r of capture.requests.filter((x) => x.step > start.step && x.step <= lastStep && API_TYPES.has(x.resourceType))) {
      polled.set(r.endpoint, [...(polled.get(r.endpoint) ?? []), r]);
    }
    const polls = [...polled.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    const inProgress = reclicks.length > 0 || waits.length > 0 || busy.length > 0 || polls.length >= 3;
    const last = screens[screens.length - 1]!;
    const offered = reclicks.length > 0 || normLine(last.visibleText).includes(normLine(label));
    const endedHere = !capture.screens.some((s) => s.step > last.step);
    const startedAt = Math.min(...writes.map((w) => w.startedAt));
    const until = endedHere ? Math.max(capture.endedAt, last.at) : last.at;
    const elapsed = until - startedAt;
    if (!inProgress || !offered || elapsed < threshold) continue;
    reported.add(key);
    const endpoint = writes[0]!.endpoint;
    const confidence = Math.min(
      0.9,
      0.55 + (reclicks.length > 0 ? 0.15 : 0) + (busy.length > 0 ? 0.1 : 0) + (polls.length >= 3 ? 0.05 : 0) + (waits.length >= 2 ? 0.05 : 0) + (endedHere ? 0.05 : 0),
    );
    const normNote = norm === null || factor * norm < floor ? `the ${secs(floor)} floor` : `${factor}× the run's typical request time of ${secs(norm)}`;
    const signs = [
      reclicks.length > 0 ? `the run clicked it again (step ${reclicks.map((s) => s.step).join(", ")})` : null,
      waits.length > 0 ? `the run waited or reloaded ${waits.length} time(s) (step ${waits.map((s) => s.step).join(", ")})` : null,
      busy.length > 0 ? `${busy.length} screen(s) showed it in progress` : null,
      polls.length >= 3 ? `${polls[0]!.endpoint} was polled ${polls.length} times` : null,
    ].filter((x): x is string => x !== null);
    out.push(
      makeSignalFinding({
        kind: "stuck-job",
        confidence,
        url: last.url,
        screenId: last.signature,
        observation: `"${label}" started ${endpoint} (step ${start.step}), but ${secs(elapsed)} later (past ${normNote}) nothing had completed and "${label}" was still offered to start it again; ${signs.join("; ")}.`,
        userImpact:
          "The user cannot tell whether the job is running or stuck, and the page invites them to start it again — a hung job looks like a job that never began, and a relaunch may be paid for twice.",
        recommendation: `While the job behind ${endpoint} runs, replace "${label}" with its in-progress state (disabled, with status), and surface a timeout or failure when it stops making progress.`,
        controls: [start.target ?? label],
        occurrences: 1 + reclicks.length,
        screenIds: [...new Set(screens.map((s) => s.signature))],
        evidence: {
          kind: "stuck-job",
          steps: uniqueSteps([start.step, ...reclicks.map((s) => s.step), ...waits.map((s) => s.step), last.step]),
          requests: [...writes, ...polls.slice(0, 5)].map((r) => requestEvidence(r, capture.endedAt)),
          text: quoteLine(last.visibleText, label),
          ...shotOf(last),
          detail: `${secs(elapsed)} since the start vs threshold ${secs(threshold)}; still offered on the last screen${endedHere ? " when the run ended" : ""}; in-progress evidence: ${signs.join(", ")}`,
        },
      }),
    );
  }
  return out;
}

/** The reply a sent message got: the transcript's awaited reply, else the longest new line on the next screen. */
function replyOf(capture: RunSignalCapture, s: SignalStep): string | null {
  if (s.reply !== undefined && s.reply.trim().length > 0) return s.reply.replace(/\s+/g, " ").trim();
  const before = screenBefore(capture, s.step);
  const after = screenAfter(capture, s.step);
  if (before === undefined || after === undefined) return null;
  const was = new Set(linesOf(before.visibleText).map(normLine));
  const fresh = linesOf(after.visibleText).filter((l) => l.length >= 12 && !was.has(normLine(l)) && normLine(l) !== normLine(s.message ?? ""));
  return fresh.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** The same assistant reply (canned error/fallback copy) came back across several sent messages. */
export function detectRepeatedReplies(capture: RunSignalCapture, opts: SignalOptions = {}): UxFinding[] {
  const sends = capture.steps.filter((s) => s.actOk && (s.op === "send" || s.message !== undefined || s.reply !== undefined));
  const byReply = new Map<string, { text: string; steps: SignalStep[] }>();
  for (const s of sends) {
    const reply = replyOf(capture, s);
    if (reply === null || reply.length < 12) continue;
    const k = normLine(reply).slice(0, 240);
    const g = byReply.get(k) ?? { text: reply, steps: [] };
    g.steps.push(s);
    byReply.set(k, g);
  }
  const out: UxFinding[] = [];
  for (const { text, steps } of byReply.values()) {
    const errorish = ERROR_TEXT.test(text) || GENERIC_ERROR.test(text);
    const min = errorish ? 2 : Math.max(2, opts.repeatedReplyMin ?? 3);
    if (steps.length < min) continue;
    const n = steps.length;
    const lastStep = steps[n - 1]!.step;
    const lastScreen = screenAfter(capture, lastStep) ?? screenBefore(capture, lastStep);
    const quote = text.length <= 160 ? text : `${text.slice(0, 157)}...`;
    const confidence = Math.min(0.9, (errorish ? 0.6 : 0.45) + 0.1 * (n - min) + (n === sends.length ? 0.05 : 0));
    out.push(
      makeSignalFinding({
        kind: "repeated-reply",
        confidence,
        url: steps[0]!.url,
        screenId: lastScreen?.signature ?? `step:${lastStep}`,
        observation: `The same reply came back to ${n} of ${sends.length} sent message(s) (steps ${steps.map((s) => s.step).join(", ")}): "${quote}"${errorish ? " — error/fallback copy instead of an answer" : ""}.`,
        userImpact: "Whatever the user says, they get the same canned response: the conversation cannot progress, and nothing tells them why or what to do instead.",
        recommendation:
          "Find why the assistant falls back on these turns and fix it (or retry/advance to another route); when it truly cannot answer, say why and offer a concrete next step instead of repeating the same copy.",
        quotes: [quote],
        occurrences: n,
        screenIds: [lastScreen?.signature ?? `step:${lastStep}`],
        evidence: {
          kind: "repeated-reply",
          steps: steps.map((s) => s.step),
          requests: [],
          text: quote,
          ...shotOf(lastScreen),
          detail: `${n} identical replies across ${sends.length} sent message(s)${errorish ? " (error/fallback wording: 2 repeats suffice)" : ` (threshold ${min})`}`,
        },
      }),
    );
  }
  return out;
}

/** Fill steps (type/select) on the submit's page since the previous submit — the payload the user entered. */
function fieldStepsBefore(capture: RunSignalCapture, submit: SignalStep, after: number): SignalStep[] {
  return capture.steps.filter((s) => s.step > after && s.step < submit.step && s.op !== null && FIELD_OPS.has(s.op) && s.actOk && s.url === submit.url);
}

/** Two successful creates with the same payload — the same entity was created twice. */
export function detectDuplicateCreates(capture: RunSignalCapture): UxFinding[] {
  const creates = (s: SignalStep) => capture.requests.filter((r) => r.step === s.step && r.method.toUpperCase() === "POST" && isWrite(r) && okStatus(r));
  const submits = capture.steps.filter((s) => s.op !== null && START_OPS.has(s.op) && s.actOk && creates(s).length > 0);
  type Hit = { submit: SignalStep; reqs: SignalRequest[]; fieldSteps: number[] };
  const groups = new Map<string, { endpoint: string; fields: string[]; byDigest: boolean; hits: Hit[] }>();
  let prev = 0;
  for (const submit of submits) {
    const fieldSteps = fieldStepsBefore(capture, submit, prev);
    const fields = fieldSteps.map((s) => (s.value ?? "").trim()).filter((v) => v.length > 0 && !/^«.*»$/.test(v));
    prev = submit.step;
    for (const r of creates(submit)) {
      const byDigest = r.payloadKey !== undefined;
      if (!byDigest && fields.length === 0) continue; // no payload evidence at all
      const k = `${r.endpoint}|${byDigest ? `digest:${r.payloadKey}` : `fields:${[...fields].sort().join("\u0000")}`}`;
      const g = groups.get(k) ?? { endpoint: r.endpoint, fields, byDigest, hits: [] };
      const hit = g.hits.find((h) => h.submit.step === submit.step);
      if (hit === undefined) g.hits.push({ submit, reqs: [r], fieldSteps: fieldSteps.map((s) => s.step) });
      else hit.reqs.push(r);
      groups.set(k, g);
    }
  }
  const out: UxFinding[] = [];
  const seen = new Set<string>();
  for (const g of groups.values()) {
    if (g.hits.length < 2) continue;
    const steps = g.hits.map((h) => h.submit.step);
    if (seen.has(steps.join(","))) continue;
    seen.add(steps.join(","));
    const lastHit = g.hits[g.hits.length - 1]!;
    const after = screenAfter(capture, lastHit.submit.step) ?? screenBefore(capture, lastHit.submit.step);
    if (after !== undefined && /\b(already exists?|duplicate|already (?:added|saved|registered|taken|in use))\b/i.test(after.visibleText)) continue; // the app told the user
    const distinctive = [...g.fields].sort((a, b) => b.length - a.length)[0];
    const listed = distinctive !== undefined && after !== undefined ? countOf(after.visibleText.toLowerCase(), distinctive.toLowerCase()) : 0;
    const listLine = listed >= 2 && after !== undefined && distinctive !== undefined ? quoteLine(after.visibleText, distinctive) : undefined;
    const confidence = Math.min(0.95, 0.7 + (g.byDigest ? 0.1 : 0) + (listed >= 2 ? 0.15 : 0));
    const target = g.hits[0]!.submit.target ?? "the submit control";
    const shown = g.fields.slice(0, 3).map((v) => `"${v.length <= 60 ? v : `${v.slice(0, 57)}...`}"`);
    out.push(
      makeSignalFinding({
        kind: "duplicate-create",
        confidence,
        url: lastHit.submit.url,
        screenId: after?.signature ?? `step:${lastHit.submit.step}`,
        observation: `${target} created the same entity ${g.hits.length} times (steps ${steps.join(", ")}): ${g.endpoint} succeeded each time with the same ${g.byDigest ? "request payload" : `values ${shown.join(", ")}`}, and no duplicate warning was shown${listed >= 2 ? ` — the page now lists it ${listed} times` : ""}.`,
        userImpact: "A user who submits the same thing twice (a retry, a double click, a form that did not clear) silently gets duplicate records, which they then have to find and clean up.",
        recommendation: `Check for an existing entity with the same key fields before ${g.endpoint} creates another (reject it, or offer "already exists — open it?"), and make the create idempotent.`,
        controls: [target],
        ...(listLine === undefined ? {} : { quotes: [listLine] }),
        occurrences: g.hits.length,
        ...(after === undefined ? {} : { screenIds: [after.signature] }),
        evidence: {
          kind: "duplicate-create",
          steps: uniqueSteps(g.hits.flatMap((h) => [...h.fieldSteps, h.submit.step])),
          requests: g.hits.flatMap((h) => h.reqs).map((r) => requestEvidence(r, capture.endedAt)),
          ...(listLine === undefined ? {} : { text: listLine }),
          ...shotOf(after),
          detail: `${g.hits.length} successful POST ${g.endpoint} with ${g.byDigest ? "an identical body digest" : "identical typed field values"}${listed >= 2 ? `; the item is listed ${listed}× afterwards` : ""}; no duplicate warning on screen`,
        },
      }),
    );
  }
  return out;
}

/** A user-initiated write answered 4xx/5xx (or failed) and the next screen showed no error, or only generic copy. */
export function detectFailedSubmits(capture: RunSignalCapture): UxFinding[] {
  const out: UxFinding[] = [];
  for (const s of capture.steps) {
    if (!s.op || !START_OPS.has(s.op) || !s.actOk) continue;
    const failing = capture.requests.filter((r) => r.step === s.step && isWrite(r) && (r.failed === true || (r.status !== null && r.status >= 400)));
    if (failing.length === 0) continue;
    const before = screenBefore(capture, s.step);
    const after = screenAfter(capture, s.step);
    if (after === undefined) continue; // the run never saw what the user saw next
    if (before !== undefined && routeOf(after.url) !== routeOf(before.url)) continue; // a navigation is feedback of its own
    const lines = linesOf(`${after.visibleText}\n${s.reply ?? ""}`);
    const generic = lines.find((l) => GENERIC_ERROR.test(l));
    if (lines.some((l) => ERROR_TEXT.test(l) && !GENERIC_ERROR.test(l))) continue; // the user was told what went wrong
    const worst = failing.reduce((a, b) => ((b.status ?? 999) > (a.status ?? 999) ? b : a));
    const outcome = worst.failed === true ? "failed with no response" : `returned ${worst.status}`;
    const silent = generic === undefined;
    const confidence = Math.min(0.9, (silent ? 0.75 : 0.65) + (worst.status !== null && worst.status >= 500 ? 0.05 : 0));
    const target = s.target ?? "the control";
    const quote = generic === undefined ? undefined : generic.length <= 160 ? generic : `${generic.slice(0, 157)}...`;
    out.push(
      makeSignalFinding({
        kind: "failed-submit",
        confidence,
        url: after.url,
        screenId: after.signature,
        observation: silent
          ? `${target} (step ${s.step}) sent ${worst.endpoint}, which ${outcome} — and the next screen showed no error at all.`
          : `${target} (step ${s.step}) sent ${worst.endpoint}, which ${outcome} — and the next screen only said "${quote}", naming no cause and no way forward.`,
        userImpact: silent
          ? "The user believes their submission went through when it did not: the answer, order or change is lost without a trace."
          : "The user learns only that something failed — not whether their input was kept, what to change, or whether retrying is safe.",
        recommendation: `Handle a failure of ${worst.endpoint} explicitly: keep the user's input, say what failed in plain words, and offer a safe retry.`,
        controls: [target],
        ...(quote === undefined ? {} : { quotes: [quote] }),
        evidence: {
          kind: "failed-submit",
          steps: uniqueSteps([s.step, after.step]),
          requests: failing.map((r) => requestEvidence(r, capture.endedAt)),
          ...(quote === undefined ? {} : { text: quote }),
          ...shotOf(after),
          detail: `${failing.length} failing write(s) on a user-initiated step; the next screen ${silent ? "carried no error copy" : "carried only generic error copy"}`,
        },
      }),
    );
  }
  return out;
}

const LOGIN_WORDS = ["log in", "login", "sign in", "signin", "password", "verify", "verification", "code", "two-factor", "2fa", "authenticat", "welcome back"];
const SIGNUP_WORDS = ["sign up", "signup", "register", "create account", "create an account", "create your account", "join"];
const RESET_WORDS = ["password", "reset", "forgot", "recover"];
/** Well-known routes and the words their own content uses (a route's path words count too). */
const ROUTE_WORDS: Readonly<Record<string, readonly string[]>> = {
  login: LOGIN_WORDS,
  signin: LOGIN_WORDS,
  "sign-in": LOGIN_WORDS,
  signup: SIGNUP_WORDS,
  "sign-up": SIGNUP_WORDS,
  register: SIGNUP_WORDS,
  logout: ["log out", "sign out", "logged out", "signed out"],
  "forgot-password": RESET_WORDS,
  "reset-password": RESET_WORDS,
  verify: ["verify", "verification", "code", "confirm"],
  checkout: ["checkout", "payment", "pay", "order", "billing", "cart"],
};

function routeWords(route: string): { words: string[]; known: boolean } {
  const segs = route
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith(":"))
    .map((s) => s.toLowerCase());
  return {
    known: segs.some((s) => ROUTE_WORDS[s] !== undefined),
    words: segs.flatMap((s) => [...s.split(/[-_.]/).filter((w) => w.length >= 3).map((w) => w.replace(/s$/, "")), ...(ROUTE_WORDS[s] ?? [])]),
  };
}

function relates(heading: string, words: readonly string[]): boolean {
  const h = heading.toLowerCase();
  return words.some((w) => h.includes(w));
}

function headingOf(s: SignalScreen): string {
  const h = (s.heading ?? "").replace(/\s+/g, " ").trim();
  return h.length > 0 ? h : (linesOf(s.visibleText)[0] ?? "");
}

/**
 * The page's heading belongs to a different route than its URL (e.g. onboarding under /login):
 * either the same heading is shown under another route whose words it matches, or a well-known
 * route (login, signup, checkout…) first showed its own content and then — with no URL change —
 * content that is not its own.
 */
export function detectUrlMismatches(capture: RunSignalCapture): UxFinding[] {
  type Hit = { screens: SignalScreen[]; heading: string; route: string; was?: string; elsewhere?: string; known: boolean };
  const hits = new Map<string, Hit>();
  capture.screens.forEach((b, i) => {
    const route = routeOf(b.url);
    const heading = headingOf(b);
    if (heading.length < 3) return;
    const { words, known } = routeWords(route);
    if (words.length === 0 || relates(heading, words)) return;
    const other = capture.screens.find((s) => routeOf(s.url) !== route && normLine(headingOf(s)) === normLine(heading) && relates(heading, routeWords(routeOf(s.url)).words));
    const prior = capture.screens
      .slice(0, i)
      .reverse()
      .find((s) => routeOf(s.url) === route && normLine(headingOf(s)) !== normLine(heading));
    const transitioned = known && prior !== undefined && relates(headingOf(prior), words);
    if (other === undefined && !transitioned) return;
    const k = `${route}|${normLine(heading)}`;
    const g: Hit = hits.get(k) ?? {
      screens: [],
      heading,
      route,
      known,
      ...(transitioned ? { was: headingOf(prior!) } : {}),
      ...(other === undefined ? {} : { elsewhere: routeOf(other.url) }),
    };
    g.screens.push(b);
    hits.set(k, g);
  });
  const out: UxFinding[] = [];
  for (const g of hits.values()) {
    const first = g.screens[0]!;
    const confidence = Math.min(0.9, (g.elsewhere !== undefined ? 0.75 : 0.6) + (g.was !== undefined && g.elsewhere !== undefined ? 0.1 : 0) + (g.screens.length >= 2 ? 0.05 : 0));
    const why = [g.was !== undefined ? `the same URL first showed "${g.was}"` : null, g.elsewhere !== undefined ? `the same heading appears under ${g.elsewhere}` : null].filter(
      (x): x is string => x !== null,
    );
    out.push(
      makeSignalFinding({
        kind: "url-mismatch",
        confidence,
        url: first.url,
        screenId: first.signature,
        observation: `The page at ${g.route} shows "${g.heading}", which is not ${g.route}'s own content (${why.join("; ")}) — the URL and what is on screen disagree.`,
        userImpact: "Reload, back, bookmarks and shared links lead somewhere other than what the user was looking at, and the address bar says they are somewhere they are not.",
        recommendation: `Navigate to the route that owns "${g.heading}" (update the URL when the content changes), or keep ${g.route} showing only its own content.`,
        quotes: [g.heading],
        occurrences: g.screens.length,
        screenIds: [...new Set(g.screens.map((s) => s.signature))],
        evidence: {
          kind: "url-mismatch",
          steps: uniqueSteps(g.screens.map((s) => s.step)),
          requests: [],
          text: g.heading,
          ...shotOf(first),
          detail: `heading "${g.heading}" does not match route ${g.route}${g.known ? " (a well-known route)" : ""}; ${why.join("; ")}`,
        },
      }),
    );
  }
  return out;
}

/** The #131 journey oracles over one run's capture. */
export function detectJourneySignals(capture: RunSignalCapture, opts: SignalOptions = {}): UxFinding[] {
  return [...detectStuckJobs(capture, opts), ...detectRepeatedReplies(capture, opts), ...detectDuplicateCreates(capture), ...detectFailedSubmits(capture), ...detectUrlMismatches(capture)];
}

/** A duplicate-write finding whose steps a duplicate-create already explains is the same defect — reported once. */
function withoutSubsumedDuplicateWrites(writes: readonly UxFinding[], journey: readonly UxFinding[]): UxFinding[] {
  const creates = journey.filter((f) => f.signal?.kind === "duplicate-create").map((f) => new Set(f.signal!.steps));
  if (creates.length === 0) return [...writes];
  return writes.filter((w) => !creates.some((c) => (w.signal?.steps ?? []).every((s) => c.has(s))));
}
