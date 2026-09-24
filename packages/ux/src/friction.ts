// friction.ts — observed JOURNEY FRICTION, and grounding findings in it (#132).
//
// A rubric finding says a screen violates a principle; that alone does not show a user struggled.
// This module reads what the run itself did — the same capture the signal oracles read — and finds
// the friction points: where it backtracked, retried, hit a dead end, waited, met an error,
// abandoned a half-filled form, or did not reach the goal. Independent code, no model.
//
// `groundFindings` then ties each rubric finding to the friction observed on its screen/route:
//   - grounded: it carries the friction's step range (`journeyEvidence`), and its severity and
//     rank come from the observed impact on the job (blocked > slowed > confused), not from the
//     heuristic's label;
//   - not grounded: it is heuristic-only — `buildReport` caps it at `info` and moves it to the
//     report's appendix;
//   - collapsed: findings on the same friction point become ONE finding (a run signal on that
//     point, else the strongest rubric finding), the rest listed as its `contributing` rationale.
import { routeOf } from "./route.js";
import type { RunSignalCapture, SignalKind, SignalRequest, SignalStep } from "./signals.js";
import type { AnalysisOutcome, ContributingFinding, JobImpact, UxFinding } from "./types.js";

export type FrictionKind = "backtrack" | "retry" | "dead-end" | "long-wait" | "error" | "abandoned" | "goal-not-reached";

export interface FrictionPoint {
  /** Stable within one run, e.g. `retry@4-5`. */
  readonly id: string;
  readonly kind: FrictionKind;
  readonly impact: JobImpact;
  /** The transcript steps the friction spans (ascending). */
  readonly steps: readonly number[];
  /** Screen-state ids (signatures) observed over those steps. */
  readonly screenIds: readonly string[];
  /** Normalized routes those steps were on. */
  readonly routes: readonly string[];
  readonly detail: string;
}

/** The run's end state, as `explore`'s RunOutcome carries it. */
export type JourneyOutcome = { readonly status: "completed" } | { readonly status: "incomplete"; readonly reason: string };

export const IMPACT_RANK: Readonly<Record<JobImpact, number>> = { blocked: 3, slowed: 2, confused: 1, cosmetic: 0 };

/** What each run signal did to the job. */
export const SIGNAL_IMPACT: Readonly<Record<SignalKind, JobImpact>> = {
  "hung-request": "slowed",
  "stuck-job": "blocked",
  "failed-submit": "blocked",
  "repeated-reply": "blocked",
  "duplicate-write": "confused",
  "duplicate-create": "confused",
  "internal-id": "confused",
  "inert-control": "confused",
  "url-mismatch": "confused",
  "horizontal-overflow": "confused",
};

const IMPACT_SEVERITY: Readonly<Record<JobImpact, UxFinding["severity"]>> = { blocked: "major", slowed: "minor", confused: "minor", cosmetic: "info" };

const API_TYPES = new Set(["fetch", "xhr"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ACT_OPS = new Set(["click", "send", "select", "type", "upload"]);
const TERMINAL_OPS = new Set(["done", "report", "blocked"]);
/** A run of waits totalling at least this long is a long wait. */
const LONG_WAIT_MS = 5_000;
/** A request at least this long on a user step is a long wait. */
const SLOW_REQUEST_MS = 10_000;

function key(s: SignalStep): string {
  return `${s.op}|${s.url}|${s.descriptor === undefined ? s.target ?? "" : JSON.stringify(s.descriptor)}`;
}

function waitedMs(s: SignalStep): number {
  const m = /waited (\d+(?:\.\d+)?)\s*s/.exec(s.reason ?? "");
  return m ? Math.round(Number(m[1]) * 1000) : 3_000;
}

/** Every friction point the run itself walked into. */
export function detectFriction(capture: RunSignalCapture, outcome?: JourneyOutcome): FrictionPoint[] {
  const steps = [...capture.steps].sort((a, b) => a.step - b.step);
  const points: FrictionPoint[] = [];
  const screensAt = (nums: readonly number[]): string[] => {
    const set = new Set(nums);
    const ids = capture.screens.filter((s) => set.has(s.step)).map((s) => s.signature);
    return [...new Set(ids.length > 0 ? ids : nums.map((n) => `step:${n}`))];
  };
  const routesAt = (nums: readonly number[]): string[] => {
    const set = new Set(nums);
    return [...new Set([...steps.filter((s) => set.has(s.step)).map((s) => routeOf(s.url)), ...capture.screens.filter((s) => set.has(s.step)).map((s) => routeOf(s.url))])];
  };
  const add = (kind: FrictionKind, impact: JobImpact, nums: readonly number[], detail: string): void => {
    const sorted = [...new Set(nums)].filter((n) => n > 0).sort((a, b) => a - b);
    if (sorted.length === 0) return;
    points.push({ id: `${kind}@${sorted[0]}-${sorted[sorted.length - 1]}`, kind, impact, steps: sorted, screenIds: screensAt(sorted), routes: routesAt(sorted), detail });
  };
  const incomplete = outcome?.status === "incomplete";
  const lastStep = steps.length > 0 ? steps[steps.length - 1]!.step : 0;

  // Dead end: an action that could not be performed (a blocked/disabled control, a hang).
  for (const s of steps) {
    if (s.actOk || (s.op !== null && TERMINAL_OPS.has(s.op))) continue;
    add("dead-end", incomplete && lastStep - s.step <= 1 ? "blocked" : "slowed", [s.step], `step ${s.step}: ${s.op ?? "no action"} on ${s.target ?? "the page"} did not succeed${s.reason ? ` (${s.reason})` : ""}`);
  }

  // Retry: the same action on the same control again within a few steps, or a reload.
  let i = 0;
  while (i < steps.length) {
    const s = steps[i]!;
    if (s.op === "reload") {
      add("retry", "slowed", [s.step], `step ${s.step}: the page was reloaded`);
      i++;
      continue;
    }
    if (s.op === null || !ACT_OPS.has(s.op) || s.op === "type") {
      i++;
      continue;
    }
    const run = [s];
    for (let j = i + 1; j < steps.length && steps[j]!.step - run[run.length - 1]!.step <= 3; j++) {
      if (key(steps[j]!) === key(s)) run.push(steps[j]!);
    }
    if (run.length >= 2) {
      add("retry", "slowed", run.map((r) => r.step), `${s.op} on ${s.target ?? "the same control"} repeated ${run.length} times (steps ${run.map((r) => r.step).join(", ")})`);
      i = steps.indexOf(run[run.length - 1]!) + 1;
    } else i++;
  }

  // Long wait: consecutive waits adding up, or a request that took far too long on a user step.
  for (let a = 0; a < steps.length; ) {
    if (steps[a]!.op !== "wait") {
      a++;
      continue;
    }
    let b = a;
    while (b + 1 < steps.length && steps[b + 1]!.op === "wait") b++;
    const run = steps.slice(a, b + 1);
    const total = run.reduce((n, s) => n + waitedMs(s), 0);
    const unchanged = run.some((s) => /did not change/.test(s.reason ?? ""));
    if (total >= LONG_WAIT_MS || unchanged) add("long-wait", "slowed", run.map((s) => s.step), `the run waited ${Math.round(total / 100) / 10}s over ${run.length} step(s)${unchanged ? " and the page did not change" : ""}`);
    a = b + 1;
  }
  const slow = new Map<number, SignalRequest[]>();
  for (const r of capture.requests) {
    if (!API_TYPES.has(r.resourceType) || r.step < 1) continue;
    if ((r.endedAt ?? capture.endedAt) - r.startedAt >= SLOW_REQUEST_MS) slow.set(r.step, [...(slow.get(r.step) ?? []), r]);
  }
  for (const [step, reqs] of slow) {
    add("long-wait", "slowed", [step], `${reqs.map((r) => r.endpoint).join(", ")} took ≥ ${SLOW_REQUEST_MS / 1000}s after step ${step}${reqs.some((r) => r.endedAt === null) ? " (still pending when the run ended)" : ""}`);
  }

  // Error: a request the user's action triggered answered 4xx/5xx or failed.
  const errors = new Map<number, SignalRequest[]>();
  for (const r of capture.requests) {
    if (r.step < 1 || !(API_TYPES.has(r.resourceType) || r.resourceType === "document")) continue;
    if (r.failed === true || (r.status !== null && r.status >= 400)) errors.set(r.step, [...(errors.get(r.step) ?? []), r]);
  }
  for (const [step, reqs] of errors) {
    const blocking = reqs.some((r) => WRITE_METHODS.has(r.method.toUpperCase()) && (r.failed === true || (r.status ?? 0) >= 500));
    add("error", blocking ? "blocked" : "slowed", [step], `${reqs.map((r) => `${r.endpoint} → ${r.failed === true ? "failed" : r.status}`).join(", ")} after step ${step}`);
  }

  // Backtrack: the run left a route and came back to it within a few screens.
  const seq = capture.screens.map((s) => ({ route: routeOf(s.url), step: s.step }));
  for (let x = 2; x < seq.length; x++) {
    const here = seq[x]!;
    if (seq[x - 1]!.route === here.route) continue;
    for (let y = x - 2; y >= Math.max(0, x - 4); y--) {
      if (seq[y]!.route !== here.route) continue;
      if (seq.slice(y + 1, x).every((s) => s.route !== here.route)) {
        add("backtrack", "confused", [seq[y]!.step, ...seq.slice(y + 1, x).map((s) => s.step), here.step], `the run left ${here.route} and came back to it (steps ${seq[y]!.step}–${here.step})`);
      }
      break;
    }
  }

  // Abandoned: fields filled on a page that was then left without submitting.
  for (let a = 0; a < steps.length; a++) {
    const s = steps[a]!;
    if (s.op !== "type" || !s.actOk) continue;
    const rest = steps.slice(a + 1);
    const leftAt = rest.findIndex((r) => r.url !== s.url);
    if (leftAt === -1) continue;
    const between = rest.slice(0, leftAt);
    if (between.some((r) => r.op === "type")) continue; // judged from the last field typed
    if (between.some((r) => r.actOk && (r.op === "click" || r.op === "send" || r.op === "select"))) continue;
    add("abandoned", "confused", [s.step, rest[leftAt]!.step], `a value typed at step ${s.step} was left unsubmitted when the run moved to ${routeOf(rest[leftAt]!.url)}`);
  }

  // The goal was not reached: the last screens are where the job stopped.
  if (outcome?.status === "incomplete" && steps.length > 0) {
    const tail = steps.slice(-3).map((s) => s.step);
    add("goal-not-reached", "blocked", tail, `the job was not completed: ${outcome.reason}`);
  }
  return points;
}

function overlaps<T>(a: readonly T[], b: readonly T[]): boolean {
  const set = new Set(a);
  return b.some((x) => set.has(x));
}

/** The friction point a finding is grounded in: its screen, else its route (highest impact wins). */
function frictionFor(f: UxFinding, points: readonly FrictionPoint[]): FrictionPoint | undefined {
  const byScreen = points.filter((p) => overlaps(p.screenIds, f.screenIds.length > 0 ? f.screenIds : [f.screenId]));
  const candidates = byScreen.length > 0 ? byScreen : points.filter((p) => p.routes.includes(f.route));
  return [...candidates].sort((a, b) => IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] || a.steps[0]! - b.steps[0]!)[0];
}

function contribution(f: UxFinding): ContributingFinding {
  return { rubricItemId: f.rubricItemId, observation: f.observation, confidence: f.confidence, ...(f.quality ? { quality: f.quality } : {}) };
}

const SEVERITY_RANK = { info: 0, minor: 1, major: 2 } as const;

/**
 * Grounds an analysis in the run's observed friction (see the module header). Signal findings are
 * behavioral by construction (they cite the steps they were measured at); objective a11y findings
 * are computed facts and are left as they are. A failed analysis is returned unchanged.
 */
export function groundFindings(outcome: AnalysisOutcome, points: readonly FrictionPoint[]): AnalysisOutcome {
  if (outcome.kind === "failed") return outcome;
  const signals: UxFinding[] = [];
  const other: UxFinding[] = [];
  const grounded = new Map<string, { point: FrictionPoint; findings: UxFinding[] }>();
  const heuristic: UxFinding[] = [];
  for (const f of outcome.findings) {
    if (f.tier === "signal") {
      const kind = f.signal?.kind;
      signals.push({
        ...f,
        impact: kind === undefined ? "confused" : SIGNAL_IMPACT[kind],
        journeyEvidence: { id: `signal:${kind ?? f.rubricItemId}`, kind: kind ?? f.rubricItemId, steps: f.signal?.steps ?? [], detail: f.signal?.detail ?? f.observation },
      });
      continue;
    }
    if (f.tier === "objective-a11y") {
      other.push(f);
      continue;
    }
    const point = frictionFor(f, points);
    if (point === undefined) {
      heuristic.push(f);
      continue;
    }
    const g = grounded.get(point.id) ?? { point, findings: [] };
    g.findings.push(f);
    grounded.set(point.id, g);
  }
  const out: UxFinding[] = [];
  const merged = new Map<number, ContributingFinding[]>();
  for (const { point, findings } of grounded.values()) {
    // A run signal observed on the same friction point is the finding; the heuristics are its rationale.
    const owner = signals.findIndex((s) => overlaps(s.journeyEvidence?.steps ?? [], point.steps) || overlaps(s.screenIds, point.screenIds));
    if (owner !== -1) {
      merged.set(owner, [...(merged.get(owner) ?? []), ...findings.map(contribution)]);
      continue;
    }
    const ranked = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence);
    const primary = ranked[0]!;
    const rest = ranked.slice(1);
    out.push(
      Object.freeze({
        ...primary,
        severity: IMPACT_SEVERITY[point.impact],
        impact: point.impact,
        journeyEvidence: { id: point.id, kind: point.kind, steps: point.steps, detail: point.detail },
        ...(rest.length > 0 ? { contributing: rest.map(contribution) } : {}),
      }),
    );
  }
  signals.forEach((s, i) => {
    const extra = merged.get(i);
    out.push(Object.freeze(extra === undefined ? s : { ...s, contributing: [...(s.contributing ?? []), ...extra] }));
  });
  return { ...outcome, findings: [...out, ...heuristic, ...other] };
}
