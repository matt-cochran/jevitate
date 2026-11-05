import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "@jevitate/domain";
import { FsJourneyStore, assertionSiteKey, classifyMutation, journeyAssertions, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { verifyJourneyMutations, type JourneyVerifyReport } from "./journey-verify.js";
import { MissionFixtures } from "./mission-fixtures.js";

/**
 * The soundness matrix of `journey verify --mutate`: mutation kind × job timing × what the site really
 * depends on. An independent site is never `sensitive` and the proof is never `proven` because of it,
 * at any timing. A dependent site is `sensitive`, or `cascade` with a named refusal, and never
 * `insensitive`, at any timing.
 *
 * Real Chromium and a real clock: a server holding a request or running a job is real time. Durations
 * are scaled down: a claim's `stallMs` of 1 s caps a dead wait at 6 s, and settling gives up at 5 s.
 */

type Timing = "fast" | "pastCap" | "job202Short" | "job202Long" | "slowPost";
/** How long the POST takes to answer, then how long the job goes on after that with no request open. */
const TIMINGS: Readonly<Record<Timing, { readonly postMs: number; readonly jobMs: number }>> = {
  fast: { postMs: 0, jobMs: 0 },
  pastCap: { postMs: 7_000, jobMs: 0 },
  job202Short: { postMs: 0, jobMs: 800 },
  job202Long: { postMs: 0, jobMs: 7_000 },
  slowPost: { postMs: 5_500, jobMs: 0 },
};
const COLUMNS: readonly Timing[] = ["fast", "pastCap", "job202Short", "job202Long", "slowPost"];

type Kind = "skip" | "block-write" | "stale-value" | "swap-param" | "targeted-automatic" | "targeted-declared";
/**
 * `dependent`: the end state depends on the mutated step, whose own job has the row's timing.
 * `independent`: the end state depends only on an EARLIER step's job, which has the row's timing; the
 * mutated step answers once that job ends (its waiting is what let the base replay's end state hold).
 * `own-dependent`: the mutated step's own claim depends on its own action.
 * `own-earlier`: the mutated step's own claim only waits on an earlier step's job.
 */
type Relation = "dependent" | "independent" | "own-dependent" | "own-earlier";

const S = "sensitive, proven";
const I = "insensitive, insensitive";

/**
 * THE MATRIX. One row per (kind, relation), one column per timing; each cell is one test: what this
 * mutation made of this site, then the proof's verdict.
 *
 * Not reachable: a targeted proof's own-step rows. A targeted proof relaxes an EARLIER postcondition
 * to reach its target, and a mutated step's own claim has nothing before it that the mutation can
 * trip, so its first failure is itself and no relaxation ever runs.
 */
const MATRIX: readonly (readonly [Kind, Relation, string, string, string, string, string])[] = [
  //                                     fast pastCap 202-short 202-long slowPost
  ["skip", "dependent", /*              */ S, S, S, S, S],
  ["skip", "independent", /*            */ I, I, I, I, I],
  ["skip", "own-dependent", /*          */ S, S, S, S, S],
  ["skip", "own-earlier", /*            */ I, I, I, I, I],
  ["block-write", "dependent", /*       */ S, S, S, S, S],
  ["block-write", "independent", /*     */ I, I, I, I, I],
  ["block-write", "own-dependent", /*   */ S, S, S, S, S],
  ["block-write", "own-earlier", /*     */ I, I, I, I, I],
  ["stale-value", "dependent", /*       */ S, S, S, S, S],
  ["stale-value", "independent", /*     */ I, I, I, I, I],
  ["stale-value", "own-dependent", /*   */ S, S, S, S, S],
  ["stale-value", "own-earlier", /*     */ I, I, I, I, I],
  ["swap-param", "dependent", /*        */ S, S, S, S, S],
  ["swap-param", "independent", /*      */ I, I, I, I, I],
  ["swap-param", "own-dependent", /*    */ S, S, S, S, S],
  ["swap-param", "own-earlier", /*      */ I, I, I, I, I],
  ["targeted-automatic", "dependent", /**/ S, S, S, S, S],
  ["targeted-automatic", "independent", /**/ I, I, I, I, I],
  ["targeted-declared", "dependent", /* */ S, S, S, S, S],
  ["targeted-declared", "independent", /**/ I, I, I, I, I],
];

const ROWS = MATRIX.flatMap(([kind, relation, ...cells]) => COLUMNS.map((timing, i) => ({ kind, relation, timing, expected: cells[i]! })));

/** One session's page state, kept per browser context, so nothing here crosses from one replay to the next. */
interface SessionState {
  xAt: number | null;
  yAt: number | null;
  name: string | null;
}

const MATRIX_PAGE = (s: SessionState, now: number): string => `<!doctype html><html><head><title>T</title></head><body>
<button id="start">Start</button><button id="act">Act</button><input id="name"><p id="started"></p><p id="acked"></p>
<p id="x">x: ${s.xAt !== null && now >= s.xAt ? "done" : "pending"}</p><p id="y">y: ${s.yAt !== null && now >= s.yAt ? s.name : "pending"}</p>
<script>
const $ = (i) => document.getElementById(i);
let poller = null;
const poll = () => { if (poller === null) poller = setInterval(async () => { try { const b = await (await fetch('/api/status')).json(); $('x').textContent = 'x: ' + b.x; $('y').textContent = 'y: ' + b.y; } catch {} }, 1000); };
const act = async (name) => { poll(); try { await fetch('/api/act', { method: 'POST', body: JSON.stringify({ name }) }); $('acked').textContent = 'Acked ' + name; } catch {} };
$('start').onclick = async () => { poll(); try { await fetch('/api/start', { method: 'POST' }); $('started').textContent = 'Started'; } catch {} };
$('act').onclick = () => act('alice');
$('name').addEventListener('input', () => act($('name').value));
</script></body></html>`;

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const json = (res: ServerResponse, body: unknown = {}): void => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
const after = (ms: number, then: () => void): void => {
  if (ms <= 0) then();
  else clock.setTimeout(then, ms);
};

/** `family`: which job has the row's timing: the mutated step's own, or an earlier step's (the mutated step answering once it ends, or at once). */
type Family = "own-job" | "earlier-then-answer" | "earlier";

function serveMatrix(family: Family, timing: Timing): Promise<{ origin: string; close: () => Promise<void> }> {
  const { postMs, jobMs } = TIMINGS[timing];
  const sessions = new Map<string, SessionState>();
  let nextSid = 1;
  return listen((req, res) => {
    const sid = /sid=(\d+)/.exec(req.headers.cookie ?? "")?.[1];
    const now = clock.monotonicMs();
    const s = (sid === undefined ? undefined : sessions.get(sid)) ?? { xAt: null, yAt: null, name: null };
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/api/status") {
      return json(res, { x: s.xAt !== null && now >= s.xAt ? "done" : "pending", y: s.yAt !== null && now >= s.yAt ? s.name : "pending" });
    }
    if (path === "/api/start") {
      if (family === "own-job") {
        s.xAt = now;
        return json(res);
      }
      s.xAt = now + postMs + jobMs;
      return after(postMs, () => json(res));
    }
    if (path === "/api/act") {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const name = (JSON.parse(body) as { name: string }).name;
        if (family === "own-job") {
          s.yAt = clock.monotonicMs() + postMs + jobMs;
          s.name = name;
          return after(postMs, () => json(res));
        }
        const wait = family === "earlier-then-answer" && s.xAt !== null ? Math.max(0, s.xAt - clock.monotonicMs()) : 0;
        after(wait, () => {
          s.yAt = clock.monotonicMs();
          s.name = name;
          json(res);
        });
      });
      return;
    }
    const headers: Record<string, string> = { "content-type": "text/html" };
    if (sid === undefined || !sessions.has(sid)) {
      const fresh = String(nextSid++);
      headers["set-cookie"] = `sid=${fresh}; Path=/`;
      sessions.set(fresh, s);
    }
    res.writeHead(200, headers).end(MATRIX_PAGE(s, now));
  });
}

const text = (css: string, t: string) => ({ kind: "textIncludes", target: { css }, text: t }) as const;
const vis = (css: string) => ({ kind: "visible", target: { css } }) as const;
const WAIT = { maxMs: 20_000, stallMs: 1_000 };
const CREATED = "2026-11-04T00:00:00Z";

/** Navigate, start the earlier job, then the mutated step (4: a click, or a param-backed fill). */
function matrixJourney(site: string, spec: { readonly param: boolean; readonly family: Family; readonly targeted?: "automatic" | "declared"; readonly mutations: readonly string[] }): Journey {
  const who = spec.param ? "${name}" : "alice";
  const claim = spec.family === "own-job" ? text("#y", `y: ${who}`) : spec.family === "earlier" ? text("#x", "x: done") : text("#acked", `Acked ${who}`);
  const action = spec.param
    ? { kind: "fill", target: { css: "#name" }, value: { var: "name" }, expect: claim, waitFor: WAIT }
    : { kind: "click", target: { css: "#act" }, expect: claim, waitFor: WAIT };
  const endState =
    spec.family === "own-job" ? [{ kind: "reloadThen", assertion: text("#y", `y: ${who}`) }] : spec.family === "earlier-then-answer" ? [{ kind: "reloadThen", assertion: text("#x", "x: done") }] : [];
  const later = spec.targeted === undefined ? [] : [{ step: { kind: "assert", check: claim } }];
  const sites = ["step:4", ...(later.length > 0 ? ["step:5"] : []), ...(endState.length > 0 ? ["end-state:0"] : [])];
  return {
    metadata: {
      id: "matrix",
      name: "Matrix",
      params: spec.param ? ["name"] : [],
      promoted: false,
      createdAtIso: CREATED,
      endState,
      mutationPairs: spec.mutations.flatMap((m) => sites.map((check) => ({ check, mustFailWhen: m }))),
      ...(spec.targeted === "declared" ? { targetedProofs: spec.mutations.map((m) => ({ check: "end-state:0", mustFailWhen: m, relax: ["step:5"] })) } : {}),
    },
    recording: {
      version: "1",
      site,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: vis("#start") } },
            { step: { kind: "assert", check: vis("#act") } },
            { step: { kind: "click", target: { css: "#start" }, expect: vis("#start") } },
            { step: action },
            ...later,
          ],
        },
      ],
    },
  } as unknown as Journey;
}

/** The one proof a row reads. Rows that can read the same proof share it, which keeps the suite's length reasonable. */
function proofKey(kind: Kind, relation: Relation, timing: Timing): string {
  const family = relation === "own-earlier" ? "earlier" : relation === "independent" ? "earlier-then-answer" : "own-job";
  const shape = kind === "skip" || kind === "block-write" ? "click" : kind === "stale-value" || kind === "swap-param" ? "fill" : kind;
  return `${shape}|${family}|${timing}`;
}

function mutationOf(kind: Kind): string {
  if (kind === "swap-param") return "swap-param:name";
  if (kind === "stale-value") return "stale-value:4";
  if (kind === "block-write") return "block-write:4";
  return "skip:4";
}

async function proveOne(key: string): Promise<{ journey: Journey; report: JourneyVerifyReport }> {
  const [shape, family, timing] = key.split("|") as [string, Family, Timing];
  const served = await serveMatrix(family, timing);
  const param = shape === "fill";
  const mutations = shape === "click" ? ["skip:4", "block-write:4"] : shape === "fill" ? ["stale-value:4", "swap-param:name"] : ["skip:4"];
  const targeted = shape === "targeted-automatic" ? ("automatic" as const) : shape === "targeted-declared" ? ("declared" as const) : undefined;
  const journey = matrixJourney(served.origin, { param, family, mutations, ...(targeted === undefined ? {} : { targeted }) });
  const dir = await mkdtemp(join(tmpdir(), "jev-soundness-"));
  await new FsJourneyStore(dir).put(journey);
  const report = await verifyJourneyMutations({ dir, id: "matrix", params: param ? { name: "alice" } : {}, browserPortFactory: () => new PlaywrightBrowserPort() }).finally(served.close);
  return { journey, report };
}

async function pool<T>(items: readonly string[], size: number, work: (item: string) => Promise<T>): Promise<Map<string, T | Error>> {
  const out = new Map<string, T | Error>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = items[next++];
      if (item === undefined) return;
      out.set(item, await work(item).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))));
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

/** What this mutation made of this site, then the proof's verdict. A cascade says whether its refusal is named. */
function reading(proof: { journey: Journey; report: JourneyVerifyReport } | Error | undefined, mutationId: string, siteKey: string): string {
  if (proof === undefined) return "no proof";
  if (proof instanceof Error) return `proof threw: ${proof.message}`;
  const mutation = proof.report.mutations.find((m) => m.id === mutationId);
  const site = journeyAssertions(proof.journey).find((s) => assertionSiteKey(s) === siteKey);
  if (mutation === undefined || site === undefined) return `no ${mutationId} at ${siteKey}: base ${proof.report.base.outcome}`;
  const verdict = classifyMutation(site, mutation, mutation);
  if (verdict !== "cascade") return `${verdict}, ${proof.report.verdict}`;
  const named = mutation.targeted?.find((t) => t.site === siteKey)?.refused !== undefined;
  return `cascade (${named ? "named" : "unnamed"}), ${proof.report.verdict}`;
}

const siteOf = (relation: Relation): string => (relation === "own-dependent" || relation === "own-earlier" ? "step:4" : "end-state:0");

describe("[realtime] the soundness matrix", () => {
  let proofs: Map<string, { journey: Journey; report: JourneyVerifyReport } | Error>;

  beforeAll(async () => {
    const keys = [...new Set(ROWS.map((r) => proofKey(r.kind, r.relation, r.timing)))];
    proofs = await pool(keys, 4, proveOne);
  }, 3_600_000);

  it.each(ROWS)("$kind, $relation site, $timing job: $expected", ({ kind, relation, timing, expected }) => {
    expect(reading(proofs.get(proofKey(kind, relation, timing)), mutationOf(kind), siteOf(relation))).toBe(expected);
  });
});

/**
 * The shapes the review proved false readings on (`security-final2.md`), each kept as it was run:
 * Start's job answers at once and goes on, `Ack` answers when it ends, `Refresh` is disabled until it
 * ends, and `Watch` shows a progress panel. Scaled down.
 */
interface ProbeState {
  doneAt: number | null;
  tok: boolean;
}

function serveProbe(jobMs: number, log: string[], onGlobal: { done: boolean }): Promise<{ origin: string; close: () => Promise<void> }> {
  const sessions = new Map<string, ProbeState>();
  let nextSid = 1;
  return listen((req, res) => {
    const sid = /sid=(\d+)/.exec(req.headers.cookie ?? "")?.[1];
    const s = (sid === undefined ? undefined : sessions.get(sid)) ?? { doneAt: null, tok: false };
    const now = clock.monotonicMs();
    const done = s.doneAt !== null && now >= s.doneAt;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/seed") {
      if (req.method === "DELETE") {
        onGlobal.done = false;
        log.push("restore");
      } else log.push("setup");
      return json(res, { id: "1" });
    }
    if (path === "/api/status") return json(res, { done });
    if (path === "/api/start") {
      s.doneAt = now + jobMs;
      return json(res);
    }
    if (path === "/api/ack") return after(s.doneAt === null ? 0 : Math.max(0, s.doneAt - now), () => json(res));
    if (path === "/api/refresh" || path === "/api/watch") return json(res);
    if (path === "/api/go") {
      log.push("go-start");
      return after(jobMs, () => {
        onGlobal.done = true;
        log.push("go-landed");
        json(res);
      });
    }
    if (path === "/api/save") {
      return after(jobMs, () => {
        s.tok = true;
        json(res);
      });
    }
    const headers: Record<string, string> = { "content-type": "text/html" };
    if (sid === undefined || !sessions.has(sid)) {
      const fresh = String(nextSid++);
      headers["set-cookie"] = `sid=${fresh}; Path=/`;
      sessions.set(fresh, s);
    }
    res.writeHead(200, headers).end(`<!doctype html><html><head><title>T</title></head><body>
<button id="start">Start</button><button id="ack">Ack</button><button id="refresh" ${done ? "" : "disabled"}>Refresh</button><button id="watch">Watch</button><button id="go">Go</button><button id="save">Save</button>
<p id="started">-</p><p id="acked">-</p><p id="jobid">J1</p><p id="job">job: ${done ? "done" : "pending"}</p><p id="done">${onGlobal.done ? "done" : "pending"}</p><div id="panelHost"></div><p id="saved"></p><p id="marker">${s.tok ? "marker-on" : ""}</p>
<script>
const $ = (i) => document.getElementById(i);
$('start').onclick = async () => { await fetch('/api/start', { method: 'POST' }); $('started').textContent = 'Started'; };
$('ack').onclick = async () => { await fetch('/api/ack', { method: 'POST' }); $('acked').textContent = 'Acked J1'; };
$('refresh').onclick = () => fetch('/api/refresh', { method: 'POST' });
$('watch').onclick = async () => { await fetch('/api/watch', { method: 'POST' }); $('panelHost').innerHTML = '<p id="panel">watching</p>'; };
$('go').onclick = () => fetch('/api/go', { method: 'POST' }).catch(() => {});
$('save').onclick = async () => { const r = await fetch('/api/save', { method: 'POST' }); if (r.ok) $('saved').textContent = 'Saved'; };
let poller = null;
const poll = () => { if (poller !== null) return; poller = setInterval(async () => { try { const b = await (await fetch('/api/status')).json(); if (b.done) { clearInterval(poller); $('job').textContent = 'job: done'; $('refresh').disabled = false; } } catch {} }, 1000); };
$('start').addEventListener('click', poll);
</script></body></html>`);
  });
}

const POST = (p: string) => [{ kind: "responseStatus", method: "POST", pathGlob: p, status: { class: 2 } }];
const click = (css: string, expectation: unknown, extra: object = {}, recorded: object = {}) => ({ step: { kind: "click", target: { css }, expect: expectation, ...extra }, ...recorded });
/** Recorded as a write with no request check, so no step window waits on it and only the run's last settling does. */
const ACK_WRITE = { delta: { verdict: "relevant-change", why: "w", changes: [], requests: ["POST /api/ack → 200"], overheadMs: 1 } };
const NAV = { step: { kind: "navigate", url: "/", expect: vis("#start") } };
const START = { ...click("#start", text("#started", "Started")), expectRequests: POST("/api/start") };
const JOB_DONE = { kind: "reloadThen", assertion: text("#job", "job: done") };
const probeJourney = (site: string, steps: readonly unknown[], meta: object = {}): Journey =>
  ({ metadata: { id: "probe", name: "Probe", params: [], promoted: false, createdAtIso: CREATED, ...meta }, recording: { version: "1", site, pages: [{ url: "/", steps }] } }) as unknown as Journey;

/**
 * The claim held without the action, so it is not sensitive; the replay then failed at the step's own
 * request check, so nothing shows it vacuous either. The proof claims nothing, which is the safe reading.
 */
const HELD_BUT_REQUEST_FAILED = "cascade, inconclusive";

/** A run-level settling, after the last step, is all that covers the earlier job. */
const SETTLE_ONLY_MS = 3_500;

/** Each finding: the job's length, the Journey, and what the site must read. */
const FINDINGS: readonly { readonly name: string; readonly jobMs: number; readonly journey: (site: string) => Journey; readonly site: string; readonly expected: string; readonly fixtures?: true }[] = [
  {
    name: "F1: a skip with an answered write and a pending effect, end state independent",
    jobMs: 3_000,
    journey: (site) => probeJourney(site, [NAV, START, { ...click("#ack", text("#acked", "Acked"), { waitFor: { maxMs: 8_000 } }), expectRequests: POST("/api/ack") }], { endState: [JOB_DONE] }),
    site: "end-state:0",
    expected: "insensitive, insensitive",
  },
  {
    name: "F1: the same with no claim to wait on, only the settling after the last step",
    jobMs: SETTLE_ONLY_MS,
    journey: (site) => probeJourney(site, [NAV, START, click("#ack", vis("#ack"), {}, ACK_WRITE)], { endState: [JOB_DONE] }),
    site: "end-state:0",
    expected: "insensitive, insensitive",
  },
  {
    name: "F2: a first replay of a skipped no-expect step with a write in flight",
    jobMs: 7_000,
    journey: (site) =>
      probeJourney(site, [NAV, click("#save", vis("#start")), { step: { kind: "waitFor", target: { css: "#saved" }, state: "visible" } }], {
        endState: [{ kind: "reloadThen", assertion: text("#marker", "marker-on") }],
        mutationPairs: [{ check: "end-state:0", mustFailWhen: "skip:3" }],
      }),
    site: "end-state:0",
    expected: "insensitive, insensitive",
  },
  {
    name: "F3: a slow, correct app with a real claim, its job past the cap",
    jobMs: 7_000,
    journey: (site) =>
      probeJourney(site, [
        { step: { kind: "navigate", url: "/", expect: vis("#go") } },
        { ...click("#go", text("#done", "done"), { waitFor: { maxMs: 22_000, stallMs: 1_000, reload: true } }), delta: { verdict: "relevant-change", why: "w", changes: [], requests: ["POST /api/go → 200"], overheadMs: 1 } },
      ]),
    site: "step:2",
    expected: "sensitive, proven",
    fixtures: true,
  },
  {
    name: "F4: a claim that holds without the click, the click waiting on the job",
    jobMs: 7_000,
    journey: (site) => probeJourney(site, [NAV, START, { ...click("#refresh", text("#job", "job: done"), { waitFor: { maxMs: 22_000, stallMs: 1_000 } }), expectRequests: POST("/api/refresh") }]),
    site: "step:3",
    expected: HELD_BUT_REQUEST_FAILED,
  },
  {
    name: "F4, no waitFor: the same claim at the plain postcondition bound",
    jobMs: 7_000,
    journey: (site) => probeJourney(site, [NAV, START, { ...click("#refresh", text("#job", "job: done")), expectRequests: POST("/api/refresh") }]),
    site: "step:3",
    expected: HELD_BUT_REQUEST_FAILED,
  },
  {
    name: "F5: a progress signal only the click brings, the claim on an earlier job",
    jobMs: 3_000,
    journey: (site) => probeJourney(site, [NAV, START, { ...click("#watch", text("#job", "job: done"), { waitFor: { maxMs: 22_000, stallMs: 1_000, progress: vis("#panel") } }), expectRequests: POST("/api/watch") }]),
    site: "step:3",
    expected: HELD_BUT_REQUEST_FAILED,
  },
  {
    name: "F5: the same under block-write, reading an end state on the earlier job",
    jobMs: 3_000,
    journey: (site) => probeJourney(site, [NAV, START, { ...click("#watch", text("#job", "job: done"), { waitFor: { maxMs: 22_000, stallMs: 1_000, progress: vis("#panel") } }), expectRequests: POST("/api/watch") }], { endState: [JOB_DONE] }),
    site: "end-state:0",
    expected: "insensitive, insensitive",
  },
  {
    name: "F5: a kept wait on an extract output, which cannot resolve",
    jobMs: 3_000,
    journey: (site) =>
      probeJourney(
        site,
        [
          NAV,
          START,
          { step: { kind: "extract", target: { css: "#jobid" }, as: "jobid", expect: vis("#jobid") } },
          { ...click("#ack", { kind: "textIncludes", target: { css: "#acked" }, text: { var: "jobid" } }, { waitFor: { maxMs: 8_000 } }), expectRequests: POST("/api/ack") },
        ],
        { endState: [JOB_DONE] },
      ),
    site: "end-state:0",
    expected: "insensitive, insensitive",
  },
];

describe("[realtime] the review's findings", () => {
  let proofs: Map<string, { journey: Journey; report: JourneyVerifyReport } | Error>;

  beforeAll(async () => {
    proofs = await pool(FINDINGS.map((f) => f.name), 4, async (name) => {
      const finding = FINDINGS.find((f) => f.name === name)!;
      const served = await serveProbe(finding.jobMs, [], { done: false });
      const journey = finding.journey(served.origin);
      const dir = await mkdtemp(join(tmpdir(), "jev-findings-"));
      await new FsJourneyStore(dir).put(journey);
      const report = await verifyJourneyMutations({
        dir,
        id: journey.metadata.id,
        params: {},
        browserPortFactory: () => new PlaywrightBrowserPort(),
        ...(finding.fixtures === true
          ? { fixtures: (at: string) => new MissionFixtures({ spec: { setup: [{ method: "POST", url: "/seed" }], restore: [{ method: "DELETE", url: "/seed" }] }, auth: {}, site: at, seedUrl: `${at}/`, baseUrl: at, allowlist: [at], secrets: [] }) }
          : {}),
      }).finally(served.close);
      return { journey, report };
    });
  }, 1_800_000);

  it.each(FINDINGS)("$name: $expected", ({ name, site, expected }) => {
    const proof = proofs.get(name);
    if (proof === undefined || proof instanceof Error) throw proof ?? new Error("no proof");
    expect(`${proof.report.assertions.find((a) => a.site === site)?.verdict}, ${proof.report.verdict}`).toBe(expected);
  });
});

describe("[realtime] a job that outlasts the whole base replay and lands in a later one", () => {
  /** A row count no fixture resets: each Save adds a row, 2.5 s later, on a job with no open request. */
  let report: JourneyVerifyReport;
  let close: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    let rows = 0;
    const served = await listen((req, res) => {
      if (req.method === "POST") {
        after(2_500, () => void (rows += 1));
        return json(res);
      }
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><title>Rows</title></head><body><button id="save">Save</button><p id="rows">rows: ${rows}</p><p id="said"></p>
<script>document.getElementById('save').onclick = async () => { await fetch('/api/save', { method: 'POST' }); document.getElementById('said').textContent = 'Saved'; };</script></body></html>`);
    });
    close = served.close;
    const journey = probeJourney(served.origin, [{ step: { kind: "navigate", url: "/", expect: vis("#save") } }, { ...click("#save", text("#said", "Saved")), expectRequests: POST("/api/save") }], {
      endState: [{ kind: "reloadThen", assertion: text("#rows", "rows: 0") }],
    });
    const dir = await mkdtemp(join(tmpdir(), "jev-leak-"));
    await new FsJourneyStore(dir).put(journey);
    report = await verifyJourneyMutations({ dir, id: journey.metadata.id, params: {}, browserPortFactory: () => new PlaywrightBrowserPort() });
  }, 300_000);
  afterAll(() => close());

  it("does not read proven on the replay it broke", () => {
    expect(report.verdict).toBe("inconclusive");
  });
});

describe("[realtime] a job that runs slower after the base replay than in it", () => {
  /** The F1 shape: Ack answers when Start's job ends, and the end state reads only that job. */
  let report: JourneyVerifyReport;
  let close: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const sessions = new Map<string, number>();
    let nextSid = 1;
    let starts = 0;
    const served = await listen((req, res) => {
      const sid = /sid=(\d+)/.exec(req.headers.cookie ?? "")?.[1];
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/api/start") {
        starts += 1;
        sessions.set(sid ?? "", clock.monotonicMs() + (starts === 1 ? 2_000 : 6_000));
        return json(res);
      }
      if (path === "/api/ack") return after(Math.max(0, (sessions.get(sid ?? "") ?? 0) - clock.monotonicMs()), () => json(res));
      const headers: Record<string, string> = { "content-type": "text/html" };
      if (sid === undefined) headers["set-cookie"] = `sid=${nextSid++}; Path=/`;
      const done = (sessions.get(sid ?? "") ?? Number.POSITIVE_INFINITY) <= clock.monotonicMs();
      res.writeHead(200, headers).end(`<!doctype html><html><head><title>T</title></head><body><button id="start">S</button><button id="ack">A</button><p id="started"></p><p id="acked"></p><p id="job">job: ${done ? "done" : "pending"}</p>
<script>document.getElementById('start').onclick = async () => { await fetch('/api/start', { method: 'POST' }); document.getElementById('started').textContent = 'Started'; };
document.getElementById('ack').onclick = async () => { await fetch('/api/ack', { method: 'POST' }); document.getElementById('acked').textContent = 'Acked'; };</script></body></html>`);
    });
    close = served.close;
    const journey = probeJourney(served.origin, [NAV, START, { ...click("#ack", text("#acked", "Acked"), { waitFor: { maxMs: 12_000 } }), expectRequests: POST("/api/ack") }], { endState: [JOB_DONE] });
    const dir = await mkdtemp(join(tmpdir(), "jev-slower-"));
    await new FsJourneyStore(dir).put(journey);
    report = await verifyJourneyMutations({ dir, id: journey.metadata.id, params: {}, browserPortFactory: () => new PlaywrightBrowserPort() });
  }, 300_000);
  afterAll(() => close());

  // The fresh control stops skip:3 counting; block-write:3 had the room to see the end state hold without the write.
  it("reads the truth, that the end state does not depend on the step, and not proven", () => {
    expect(report.verdict).toBe("insensitive");
  });
});
