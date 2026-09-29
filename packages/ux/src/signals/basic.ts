// basic.ts — the #96 oracles: hung request, duplicate write, internal id, inert control.
import { writeClassifier } from "@jevitate/recording";
import { clamp01 } from "../confidence.js";
import { routeOf } from "../route.js";
import type { UxFinding } from "../types.js";
import { makeSignalFinding } from "./finding.js";
import { API_TYPES, BUSY_TEXT, controlKey, durationOf, median, okStatus, quoteLine, requestEvidence, secs, uniqueSteps } from "./shared.js";
import type { RunSignalCapture, SignalOptions, SignalRequest, SignalScreen, SignalStep } from "./types.js";

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

/**
 * Does a control's `href` resolve to the page it was clicked on (ignoring hash and a trailing
 * slash)? A nav link to the current route doing nothing is correct behaviour, not a bug (#127).
 */
function linksToCurrentPage(href: string | null | undefined, currentUrl: string): boolean {
  if (href === null || href === undefined || href === "") return false;
  const dropTrailingSlash = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  try {
    const target = new URL(href);
    const current = new URL(currentUrl);
    return (
      target.origin === current.origin &&
      dropTrailingSlash(target.pathname) === dropTrailingSlash(current.pathname) &&
      target.search === current.search
    );
  } catch {
    return false;
  }
}

/** A truthy `aria-current` (present and not explicitly `"false"`) marks the current nav item (#127). */
function hasAriaCurrent(v: string | null | undefined): boolean {
  return v !== null && v !== undefined && v !== "" && v !== "false";
}

/** A successful click after which nothing observable changed (url, screen, text) and no request fired. */
export function detectInertControls(capture: RunSignalCapture): UxFinding[] {
  const inert = new Map<string, { step: SignalStep; before: SignalScreen; after: SignalScreen }[]>();
  for (const s of capture.steps) {
    if (s.op !== "click" || !s.actOk) continue;
    // A link to the route the user is already on, or a control marked as the current nav item,
    // doing nothing on click is not inert — it is exactly what should happen (#127).
    if (hasAriaCurrent(s.ariaCurrent) || linksToCurrentPage(s.href, s.url)) continue;
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
