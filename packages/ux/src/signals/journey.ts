// journey.ts — journey oracles (#131): defect shapes the run walked past ----------
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
import { writeClassifier } from "@jevitate/recording";
import { routeOf } from "../route.js";
import type { UxFinding } from "../types.js";
import { makeSignalFinding } from "./finding.js";
import { API_TYPES, BUSY_TEXT, controlKey, durationOf, median, okStatus, quoteLine, requestEvidence, secs, uniqueSteps } from "./shared.js";
import type { RunSignalCapture, SignalRequest, SignalScreen, SignalStep, SignalOptions } from "./types.js";

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
