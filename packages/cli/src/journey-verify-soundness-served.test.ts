import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "@jevitate/domain";
import { FsJourneyStore, assertionSiteKey, classifyMutation, journeyAssertions, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { appendFile } from "node:fs/promises";
import { runJourneyProgrammatically } from "./journey-api.js";
import { planJourneyVerification, verifyJourneyMutations, type JourneyVerifyReport, type VerifyJourneyOptions } from "./journey-verify.js";
import { MissionFixtures } from "./mission-fixtures.js";
import { composeObservers } from "./run-screenshots.js";

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

/** How many proofs of this file run at once. */
const PROOF_POOL = 8;
/** With this set, every proof appends what each replay took, by kind and step, as one JSON line. */
const COST_LOG = process.env["JEV_PROOF_COST_LOG"];

/** A proof, measured through the `run` seam and the progress lines when `COST_LOG` is set: nothing about the proof itself changes. */
async function proveMeasured(name: string, opts: VerifyJourneyOptions): Promise<JourneyVerifyReport> {
  if (COST_LOG === undefined) return verifyJourneyMutations(opts);
  const startedAt = clock.monotonicMs();
  const replays: { label: string; atMs: number; endedMs?: number; stepEndMs: Record<number, number> }[] = [];
  const report = await verifyJourneyMutations(
    {
      ...opts,
      onProgress: (p) => {
        opts.onProgress?.(p);
        replays.push({ label: p.mutation ?? "base", atMs: clock.monotonicMs() - startedAt, stepEndMs: {} });
      },
    },
    async (options, mutation) => {
      const replay = replays.at(-1)!;
      const at = clock.monotonicMs();
      const timing = { afterStep: async ({ index }: { index: number }) => void (replay.stepEndMs[index] = Math.round(clock.monotonicMs() - at)) };
      try {
        return await runJourneyProgrammatically({ ...options, observer: composeObservers(options.observer, timing) }, mutation);
      } finally {
        replay.endedMs = clock.monotonicMs() - startedAt;
      }
    },
  );
  // Each pair's reading, on what the mutation alone saw, for what stopping a step's siblings early would have cost.
  const planned = await planJourneyVerification({ dir: opts.dir, id: opts.id, params: opts.params });
  const stored = await new FsJourneyStore(opts.dir).get(opts.id);
  const sitesOf = stored === null || stored === undefined ? [] : journeyAssertions(stored);
  const readings = planned.pairs.flatMap((p) => {
    const m = report.mutations.find((x) => x.id === p.mutation);
    const site = sitesOf.find((x) => assertionSiteKey(x) === p.site);
    return m === undefined || site === undefined ? [] : [[p.mutation, m.step, p.site, classifyMutation(site, m, m)]];
  });
  await appendFile(COST_LOG, `${JSON.stringify({ name, ms: Math.round(clock.monotonicMs() - startedAt), replays, verdict: report.verdict, assertions: report.assertions.map((a) => [a.site, a.verdict, a.provedBy]), readings })}\n`);
  return report;
}

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
  const report = await proveMeasured(key, { dir, id: "matrix", params: param ? { name: "alice" } : {}, browserPortFactory: () => new PlaywrightBrowserPort() }).finally(served.close);
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
    proofs = await pool(keys, PROOF_POOL, proveOne);
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
    proofs = await pool(FINDINGS.map((f) => f.name), PROOF_POOL, async (name) => {
      const finding = FINDINGS.find((f) => f.name === name)!;
      const served = await serveProbe(finding.jobMs, [], { done: false });
      const journey = finding.journey(served.origin);
      const dir = await mkdtemp(join(tmpdir(), "jev-findings-"));
      await new FsJourneyStore(dir).put(journey);
      const report = await proveMeasured(name, {
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

/**
 * THE EXPERIMENT'S ROWS. The fixture can vary what the matrix above holds fixed: state that crosses
 * replays, a job that runs slow in one replay (`first`), claims that decay, a client's retry,
 * background writes, a short claim on a slow request check. Each row fails on the code before the
 * experiment changed, except a row marked `limit`, which pins today's reading of a stated limit in
 * `docs/outcomes.md` (a limit's reading is not the truth of the Journey: it says so in its name).
 */
interface RowContext {
  /** The kind of replay running now, by its progress label. */
  label: string;
  /** Which replay of the proof is running, 1-based. */
  replay: number;
  /** True the first time it is asked for this label. */
  firstOf(label: string): boolean;
}
interface Row {
  readonly name: string;
  readonly limit?: true;
  readonly fixtures?: true;
  readonly serve: (ctx: RowContext) => (req: IncomingMessage, res: ServerResponse) => void;
  readonly journey: (site: string) => Journey;
  readonly verdict: string;
  readonly reading?: readonly [site: string, verdict: string];
  readonly reason?: RegExp;
  /** What one mutation must have made of a site, whatever its sibling read. */
  readonly under?: readonly [mutation: string, site: string, verdict: string];
}

const html = (res: ServerResponse, body: string, headers: Record<string, string> = {}): void => void res.writeHead(200, { "content-type": "text/html", ...headers }).end(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);
const pathOfUrl = (req: IncomingMessage): string => new URL(req.url ?? "/", "http://x").pathname;
const sidOf = (req: IncomingMessage): string => /sid=(\d+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
const NOCLAIM = { kind: "urlIncludes", text: "" } as const;
const WROTE = (p: string, method = "POST") => ({ delta: { verdict: "relevant-change", why: "w", changes: [], requests: [`${method} ${p} → 200`], overheadMs: 1 } });
const NAV_TO = (css: string) => ({ step: { kind: "navigate", url: "/", expect: vis(css) } });
const J = (site: string, steps: readonly unknown[], meta: object = {}): Journey => probeJourney(site, steps, meta);

const sessions = (): { sid: (req: IncomingMessage, res: Record<string, string>) => string } => {
  let next = 1;
  return {
    sid: (req, headers) => {
      const sid = sidOf(req);
      if (sid !== "") return sid;
      const fresh = String(next++);
      headers["set-cookie"] = `sid=${fresh}; Path=/`;
      return fresh;
    },
  };
};

/** Save answers at once and its job goes on; `onLanded` is its effect, `path` how it was started. */
const crossing = (opts: { readonly fixtures: boolean; readonly method?: "GET" | "POST" }): ((ctx: RowContext) => (req: IncomingMessage, res: ServerResponse) => void) => () => {
  let busyFrom = Number.POSITIVE_INFINITY;
  let busyTo = 0;
  let gone = false;
  return (req, res) => {
    const p = pathOfUrl(req);
    const now = clock.monotonicMs();
    if (p === "/seed") {
      gone = false;
      return json(res, { id: "1" });
    }
    if (p === "/api/save") {
      if (opts.fixtures) after(3_000, () => void (gone = true));
      else {
        busyFrom = now + 1_600;
        busyTo = busyFrom + 3_500;
      }
      return json(res);
    }
    const bad = opts.fixtures ? gone : now >= busyFrom && now < busyTo;
    html(res, `<button id="save">Save</button><p id="row">row: ${bad ? "gone" : "present"}</p><script>document.getElementById('save').onclick=()=>fetch('/api/save',{method:'${opts.method ?? "POST"}'}).catch(()=>{})</script>`);
  };
};
const crossingJourney = (site: string, extra: object = {}, line: object = WROTE("/api/save")): Journey =>
  J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: NOCLAIM }, ...line }], { endState: [{ kind: "reloadThen", assertion: text("#row", "row: present") }], ...extra });

/** An earlier step's toast lasts `toastMs`; `ownToast`: it is the last step's own write that brings it. */
const toastServer = (toastMs: number, ownToast: boolean) => () => (req: IncomingMessage, res: ServerResponse): void => {
  const p = pathOfUrl(req);
  if (p.startsWith("/api/")) return json(res);
  const show = `$('toast').textContent='Welcome';setTimeout(()=>{$('toast').textContent=''},${toastMs})`;
  html(res, `<button id="hello">Hello</button><button id="ack">Ack</button><p id="toast"></p><script>const $=(i)=>document.getElementById(i);
$('hello').onclick=async()=>{await fetch('/api/hello',{method:'POST'});${ownToast ? "" : show}};
$('ack').onclick=async()=>{await fetch('/api/ack',{method:'POST'});${ownToast ? show : ""}};</script>`);
};
const toastJourney = (site: string, ownToast: boolean): Journey =>
  J(site, [NAV_TO("#hello"), { step: { kind: "click", target: { css: "#hello" }, expect: ownToast ? NOCLAIM : text("#toast", "Welcome") }, ...WROTE("/api/hello") }, { step: { kind: "click", target: { css: "#ack" }, expect: NOCLAIM }, ...WROTE("/api/ack") }], {
    endState: [{ kind: "page", assertion: text("#toast", "Welcome") }],
  });

/** Ack's claim reads only Start's job, which takes 14 s (past any wait on the way to the claim) the first time `slowIn` starts it and 800 ms otherwise. */
const oneSlow = (slowIn: string) => (ctx: RowContext) => {
  const at = new Map<string, number>();
  const s = sessions();
  return (req: IncomingMessage, res: ServerResponse): void => {
    const headers: Record<string, string> = {};
    const sid = s.sid(req, headers);
    const p = pathOfUrl(req);
    const now = clock.monotonicMs();
    if (p === "/api/start") {
      at.set(sid, now + (ctx.label === slowIn && ctx.firstOf(slowIn) ? 14_000 : 800));
      return json(res);
    }
    if (p === "/api/ack") return json(res);
    if (p === "/api/status") return json(res, { done: (at.get(sid) ?? Number.POSITIVE_INFINITY) <= now });
    html(res, `<button id="start">S</button><button id="ack">A</button><p id="started"></p><p id="job">job: pending</p><script>const $=(i)=>document.getElementById(i);let q;
$('start').onclick=async()=>{await fetch('/api/start',{method:'POST'});$('started').textContent='Started';q=setInterval(async()=>{const b=await(await fetch('/api/status')).json();if(b.done){clearInterval(q);$('job').textContent='job: done'}},200)};
$('ack').onclick=()=>fetch('/api/ack',{method:'POST'}).catch(()=>{});</script>`, headers);
  };
};
const oneSlowSteps = (ackLine: object) => [NAV_TO("#start"), { step: { kind: "click", target: { css: "#start" }, expect: text("#started", "Started") }, ...WROTE("/api/start") }, { step: { kind: "click", target: { css: "#ack" }, expect: text("#job", "job: done") }, ...ackLine }];

/** A POST that fails is sent again by the client, 1.5 s on. The next step's button appears only after the click. */
const retrying = (retryLine?: string) => () => {
  const saved = new Map<string, boolean>();
  const s = sessions();
  return (req: IncomingMessage, res: ServerResponse): void => {
    const headers: Record<string, string> = {};
    const sid = s.sid(req, headers);
    const p = pathOfUrl(req);
    if (p === "/api/save" || p === "/api/save-retry") {
      saved.set(sid, true);
      return json(res);
    }
    html(res, `<button id="save">Save</button><div id="host"></div><p id="said"></p><p id="saved">${saved.get(sid) ? "YES" : "NO"}</p><script>const $=(i)=>document.getElementById(i);
const send=async(left,url)=>{try{await fetch(url,{method:'POST'});$('said').textContent='Saved'}catch{if(left>0)setTimeout(()=>send(left-1,'${retryLine ?? "/api/save"}'),1500)}};
$('save').onclick=()=>{$('host').innerHTML='<button id="next">Next</button>';send(3,'/api/save')};</script>`, headers);
  };
};
const SAVED_YES = { kind: "reloadThen", assertion: text("#saved", "YES") } as const;

/** A POST held open after its click; `keepalive`: a repeating POST the Journey never recorded starts 3 s after load. */
const saving = (opts: { readonly saveMs: number; readonly keepalive?: boolean; readonly optimistic?: boolean }) => () => {
  const saved = new Map<string, boolean>();
  const s = sessions();
  return (req: IncomingMessage, res: ServerResponse): void => {
    const headers: Record<string, string> = {};
    const sid = s.sid(req, headers);
    const p = pathOfUrl(req);
    if (p === "/api/keepalive") return after(500, () => json(res));
    if (p === "/api/save") return after(opts.saveMs, () => {
      saved.set(sid, true);
      json(res);
    });
    html(res, `<button id="save">Save</button><p id="said"></p><p id="saved">${saved.get(sid) ? "YES" : "NO"}</p><script>const $=(i)=>document.getElementById(i);
${opts.keepalive === true ? "setTimeout(()=>setInterval(()=>fetch('/api/keepalive',{method:'POST'}).catch(()=>{}),1000),3000);" : ""}
$('save').onclick=async()=>{${opts.optimistic === true ? "$('said').textContent='Saving';" : ""}try{await fetch('/api/save',{method:'POST'});${opts.optimistic === true ? "" : "$('said').textContent='Saved';"}}catch{}};</script>`, headers);
  };
};

/** A Save the server answers with `Cache-Control: no-store`, whose body the page never reads: Chromium then never reports the request as finished. */
const answeredUnread = (status: number) => () => {
  const said = `Saved ${status}`;
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (pathOfUrl(req) === "/api/save") return void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end("{}");
    html(res, `<button id="save">Save</button><p id="said"></p><script>document.getElementById('save').onclick=()=>fetch('/api/save',{method:'POST'}).then(()=>{document.getElementById('said').textContent='${said}'})</script>`);
  };
};
const unreadJourney = (status: number) => (site: string): Journey => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", `Saved ${status}`) }, ...WROTE("/api/save") }]);

/** A Save whose headers go at once and whose body, read by nobody, ends `bodyMs` later. Its effect lands as the body ends. Chromium reports none of that body until it ends. */
const streaming = (bodyMs: number, shared: boolean) => () => {
  const saved = new Set<string>();
  const s = sessions();
  return (req: IncomingMessage, res: ServerResponse): void => {
    const headers: Record<string, string> = {};
    const sid = shared ? "" : s.sid(req, headers);
    if (pathOfUrl(req) === "/api/save") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.flushHeaders();
      return after(bodyMs, () => {
        saved.add(sid);
        res.end("{}");
      });
    }
    html(res, `<button id="save">Save</button><p id="said"></p><p id="saved">${saved.has(sid) ? "YES" : "NO"}</p><script>document.getElementById('save').onclick=()=>fetch('/api/save',{method:'POST'}).then(()=>{document.getElementById('said').textContent='Saved'})</script>`, headers);
  };
};
const streamJourney = (assertion: ReturnType<typeof text>) => (site: string): Journey => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saved") }, ...WROTE("/api/save") }], { endState: [{ kind: "reloadThen", assertion }] });

const ROWS_EXPERIMENT: readonly Row[] = [
  {
    name: "no delta: a networkCheck names a POST, and page timing shows it: no pair comes of that, and the reason says what to add",
    serve: saving({ saveMs: 0 }),
    journey: (site) =>
      J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: NOCLAIM }, timing: { atMs: 0, durationMs: 0, gapBeforeMs: 0, page: { route: "/", kind: "transition", settled: true, requests: { count: 1, pending: 0, slowest: [{ endpoint: "POST /api/save", url: `${site}/api/save`, status: 200, durationMs: 5 }] } } } }], { networkChecks: POST("/api/save") }),
    verdict: "inconclusive",
    reason: /no assertion is paired.*end-state:0 names POST \/api\/save, and no step records it.*If this request is the step's write, add it to that step's delta\.requests.*"check":"end-state:0","mustFailWhen":"skip:<step>"/,
  },
  {
    name: "no delta and no network check: the reason says what to add",
    serve: saving({ saveMs: 0 }),
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: NOCLAIM } }]),
    verdict: "inconclusive",
    reason: /no assertion is paired.*if a step sends a write, add it to that step's delta\.requests.*"requests":\["POST \/path → 200"\]/,
  },
  {
    name: "a read RPC a check names by glob: no pair, and the reason calls it no write",
    serve: () => (req, res) => {
      if (pathOfUrl(req).startsWith("/board.v1.Items/")) return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      html(res, `<button id="open">Open</button><script>document.getElementById('open').onclick=()=>fetch('/board.v1.Items/GetItem',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})</script>`);
    },
    journey: (site) => J(site, [NAV_TO("#open"), { step: { kind: "click", target: { css: "#open" }, expect: NOCLAIM } }], { networkChecks: POST("/board.v1.Items/Get*") }),
    verdict: "inconclusive",
    reason: /If this request is the step's write, add it.*If it is a read, there is no write here to prove/,
  },
  {
    name: "a check naming the first of two recorded writes stays with the last write, which can't break it: a recording can place a timer's write under the wrong step",
    serve: () => (req, res) => {
      if (pathOfUrl(req).startsWith("/api/")) return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      html(res, `<button id="a">A</button><button id="b">B</button><script>for(const id of ['a','b'])document.getElementById(id).onclick=()=>fetch('/api/'+id,{method:'POST'})</script>`);
    },
    journey: (site) => J(site, [NAV_TO("#a"), { step: { kind: "click", target: { css: "#a" }, expect: NOCLAIM }, ...WROTE("/api/a") }, { step: { kind: "click", target: { css: "#b" }, expect: NOCLAIM }, ...WROTE("/api/b") }], { networkChecks: POST("/api/a") }),
    verdict: "insensitive",
    reading: ["end-state:0", "insensitive"],
  },
  {
    name: "a no-store 200 whose body the page never reads: the write was answered",
    serve: answeredUnread(200),
    journey: unreadJourney(200),
    verdict: "proven",
    reading: ["step:2", "sensitive"],
  },
  {
    name: "a no-store 401 whose body the page never reads: the write was answered",
    serve: answeredUnread(401),
    journey: unreadJourney(401),
    verdict: "proven",
    reading: ["step:2", "sensitive"],
  },
  {
    name: "a write the server never answers stays open: its effect may land in a later replay",
    serve: () => (req, res) => {
      if (pathOfUrl(req) === "/api/save") return;
      html(res, `<button id="save">Save</button><p id="said"></p><script>document.getElementById('save').onclick=()=>{document.getElementById('said').textContent='Saving';fetch('/api/save',{method:'POST'}).catch(()=>{})}</script>`);
    },
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saving") }, ...WROTE("/api/save") }]),
    verdict: "inconclusive",
    reason: /closed with a write still unanswered/,
  },
  {
    name: "a body that ends a moment after its headers is waited for, so the end state reads its effect",
    serve: streaming(1_000, false),
    journey: streamJourney(text("#saved", "YES")),
    verdict: "proven",
    reading: ["end-state:0", "sensitive"],
  },
  {
    name: "a body held open past the bound, its effect crossing replays, stays open: it is a server still working",
    serve: streaming(2_500, true),
    journey: streamJourney(text("#saved", "NO")),
    verdict: "inconclusive",
  },
  {
    name: "answered, then keeps working with its body unsent, and the app is busy for a while: no false proven",
    // The independent check's attack, scaled down: 200 headers at once, the first write's body held 8 s, the app busy from 1 s to 8 s.
    serve: () => {
      let first = true;
      let busyFrom = Infinity;
      let busyTo = 0;
      return (req: IncomingMessage, res: ServerResponse): void => {
        if (pathOfUrl(req) === "/api/save") {
          req.resume();
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.flushHeaders();
          if (!first) return void res.end("{}");
          first = false;
          const now = clock.monotonicMs();
          busyFrom = now + 1_000;
          busyTo = now + 8_000;
          return after(8_000, () => res.end("{}"));
        }
        const now = clock.monotonicMs();
        html(res, `<button id="save">Save</button><p id="said"></p><p id="health">${now >= busyFrom && now < busyTo ? "BUSY" : "OK"}</p><script>document.getElementById('save').onclick=()=>fetch('/api/save',{method:'POST'}).then(()=>{document.getElementById('said').textContent='Saved'})</script>`);
      };
    },
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saved") }, ...WROTE("/api/save") }], { endState: [{ kind: "reloadThen", assertion: text("#health", "OK") }] }),
    verdict: "inconclusive",
  },
  {
    name: "stated limit, today's reading: a body the page reads and the server holds open reports its first bytes, so past 2 s it reads as answered, proven",
    limit: true,
    serve: () => (req: IncomingMessage, res: ServerResponse): void => {
      if (pathOfUrl(req) === "/api/save") {
        req.resume();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.write("{");
        return after(20_000, () => res.end("}"));
      }
      html(res, `<button id="save">Save</button><p id="said"></p><script>document.getElementById('save').onclick=async()=>{const r=await fetch('/api/save',{method:'POST'});document.getElementById('said').textContent='Saved';await r.text()}</script>`);
    },
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saved") }, ...WROTE("/api/save") }]),
    verdict: "proven",
    reading: ["step:2", "sensitive"],
  },
  {
    name: "an empty no-store 200: Chromium aborts it after the response, and that is an answer",
    serve: () => (req: IncomingMessage, res: ServerResponse): void => {
      if (pathOfUrl(req) === "/api/save") return void res.writeHead(200, { "cache-control": "no-store" }).end();
      html(res, `<button id="save">Save</button><p id="said"></p><script>document.getElementById('save').onclick=()=>fetch('/api/save',{method:'POST'}).then(()=>{document.getElementById('said').textContent='Saved'})</script>`);
    },
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saved") }, ...WROTE("/api/save") }]),
    verdict: "proven",
    reading: ["step:2", "sensitive"],
  },
  {
    name: "H1: the base's job lands in the next replay and a fixture restore clears it",
    fixtures: true,
    serve: crossing({ fixtures: true }),
    journey: (site) => crossingJourney(site),
    verdict: "inconclusive",
    reason: /cross into the next/,
  },
  {
    name: "H1: the base's job opens a time-limited window over the replay after it, no fixture",
    serve: (ctx) => (req, res) => {
      if (pathOfUrl(req).startsWith("/api/")) return json(res);
      html(res, `<button id="save">Save</button><p id="row">row: ${ctx.replay === 2 ? "gone" : "present"}</p><script>document.getElementById('save').onclick=()=>fetch('/api/save',{method:'POST'}).catch(()=>{})</script>`);
    },
    journey: (site) => crossingJourney(site),
    verdict: "inconclusive",
    reason: /cross into the next/,
  },
  {
    name: "M4: the same job started by a GET, with no write to see",
    serve: crossing({ fixtures: false, method: "GET" }),
    journey: (site) => crossingJourney(site, { mutationPairs: [{ check: "end-state:0", mustFailWhen: "skip:2" }] }, {}),
    verdict: "insensitive",
    reading: ["end-state:0", "insensitive"],
  },
  {
    name: "H2: the pacing hold outlasts a toast an earlier step showed",
    serve: toastServer(1_300, false),
    journey: (site) => toastJourney(site, false),
    verdict: "insensitive",
    reading: ["end-state:0", "insensitive"],
  },
  {
    name: "H3: one replay's job runs slow, and the sibling mutation passes the site",
    serve: oneSlow("skip:3"),
    journey: (site) => J(site, oneSlowSteps(WROTE("/api/ack"))),
    verdict: "insensitive",
    reading: ["step:3", "insensitive"],
  },
  {
    name: "H4: a client's retry after the block window, with no claim on the step",
    serve: retrying(),
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: NOCLAIM }, ...WROTE("/api/save") }, { step: { kind: "click", target: { css: "#next" }, expect: NOCLAIM } }], { endState: [SAVED_YES] }),
    verdict: "proven",
    reading: ["end-state:0", "sensitive"],
  },
  {
    name: "H4: a client's retry during a relaxed replay's kept wait",
    serve: retrying(),
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saved") }, ...WROTE("/api/save") }], { endState: [SAVED_YES] }),
    verdict: "proven",
    under: ["block-write:2", "end-state:0", "sensitive"],
    reading: ["end-state:0", "sensitive"],
  },
  {
    name: "H4: a client's retry during a targeted replay",
    serve: retrying(),
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saved") }, ...WROTE("/api/save") }, { step: { kind: "assert", check: text("#said", "Saved") } }], {
      endState: [SAVED_YES],
      mutationPairs: [{ check: "step:3", mustFailWhen: "block-write:2" }],
    }),
    verdict: "proven",
    reading: ["end-state:0", "sensitive"],
  },
  {
    name: "M1: a repeating POST the Journey never recorded, open as a longer replay closes",
    serve: saving({ saveMs: 0, keepalive: true }),
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saved") }, ...WROTE("/api/save") }], { endState: [{ kind: "page", assertion: text("#said", "Saved") }] }),
    verdict: "proven",
    reading: ["end-state:0", "sensitive"],
  },
  {
    name: "M2: a claim on optimistic text with a short wait, on a step with a slow request check",
    serve: saving({ saveMs: 8_000, optimistic: true }),
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: text("#said", "Saving"), waitFor: { maxMs: 2_000 } }, expectRequests: POST("/api/save") }]),
    verdict: "proven",
    reading: ["step:2", "sensitive"],
  },
  {
    name: "M3: a write the end state's reload drops as the base closes, its effect landing in the next replay",
    fixtures: true,
    serve: () => {
      let gone = false;
      return (req, res) => {
        const p = pathOfUrl(req);
        if (p === "/seed") {
          gone = false;
          return json(res, { id: "1" });
        }
        if (p === "/api/save") return after(8_000, () => {
          gone = true;
          json(res);
        });
        html(res, `<button id="save">Save</button><p id="row">row: ${gone ? "gone" : "present"}</p><script>document.getElementById('save').onclick=()=>fetch('/api/save',{method:'POST'}).catch(()=>{})</script>`);
      };
    },
    journey: (site) => crossingJourney(site),
    verdict: "insensitive",
    reading: ["end-state:0", "insensitive"],
  },
  {
    name: "stated limit, today's reading: a one-off slow job, no sibling to disagree, plenty of room reads proven though the claim is independent",
    limit: true,
    serve: oneSlow("skip:3"),
    journey: (site) => J(site, oneSlowSteps({}), { mutationPairs: [{ check: "step:3", mustFailWhen: "skip:3" }] }),
    verdict: "proven",
    reading: ["step:3", "sensitive"],
  },
  {
    name: "stated limit, today's reading: state landing later than the independence replay, only inside one mutated replay, reads proven though the end state is independent",
    limit: true,
    serve: (ctx) => (req, res) => {
      if (pathOfUrl(req).startsWith("/api/")) return json(res);
      html(res, `<button id="save">Save</button><p id="row">row: ${ctx.label === "skip:2" ? "gone" : "present"}</p><script>document.getElementById('save').onclick=()=>{}</script>`);
    },
    journey: (site) => crossingJourney(site, { mutationPairs: [{ check: "end-state:0", mustFailWhen: "skip:2" }] }, {}),
    verdict: "proven",
    reading: ["end-state:0", "sensitive"],
  },
  {
    name: "stated limit, today's reading: a claim that really depends on the write but decays inside the hold cannot be told from one the hold broke",
    limit: true,
    serve: toastServer(1_000, true),
    journey: (site) => toastJourney(site, true),
    // The hold may read as state crossing replays first, depending on when the toast ends: either way the proof claims nothing.
    verdict: "inconclusive",
  },
  {
    name: "stated limit, today's reading: a client's retry on a line the step never recorded gets through, so the end state reads insensitive though it depends on the write",
    limit: true,
    serve: retrying("/api/save-retry"),
    journey: (site) => J(site, [NAV_TO("#save"), { step: { kind: "click", target: { css: "#save" }, expect: NOCLAIM }, ...WROTE("/api/save") }, { step: { kind: "click", target: { css: "#next" }, expect: NOCLAIM } }], { endState: [SAVED_YES] }),
    verdict: "insensitive",
    reading: ["end-state:0", "insensitive"],
  },
];

describe("[realtime] the experiment's rows", () => {
  let proofs: Map<string, { journey: Journey; report: JourneyVerifyReport } | Error>;

  beforeAll(async () => {
    proofs = await pool(ROWS_EXPERIMENT.map((r) => r.name), PROOF_POOL, async (name) => {
      const row = ROWS_EXPERIMENT.find((r) => r.name === name)!;
      const seen = new Set<string>();
      const ctx: RowContext = {
        label: "base",
        replay: 0,
        firstOf: (label) => {
          if (seen.has(label)) return false;
          seen.add(label);
          return true;
        },
      };
      const served = await listen(row.serve(ctx));
      const journey = row.journey(served.origin);
      const dir = await mkdtemp(join(tmpdir(), "jev-rows-"));
      await new FsJourneyStore(dir).put(journey);
      const report = await proveMeasured(name, {
        dir,
        id: journey.metadata.id,
        params: {},
        browserPortFactory: () => new PlaywrightBrowserPort(),
        onProgress: (p) => {
          ctx.label = p.mutation ?? "base";
          ctx.replay = p.replay;
        },
        ...(row.fixtures === true
          ? { fixtures: (at: string) => new MissionFixtures({ spec: { setup: [{ method: "POST", url: "/seed" }], restore: [{ method: "DELETE", url: "/seed" }] }, auth: {}, site: at, seedUrl: `${at}/`, baseUrl: at, allowlist: [at], secrets: [] }) }
          : {}),
      }).finally(served.close);
      return { journey, report };
    });
  }, 1_800_000);

  // Named in full, so a stated limit's row says so wherever it is listed.
  for (const { name, verdict, reading: site, reason, under } of ROWS_EXPERIMENT) {
    it(`${name}: ${verdict}`, () => {
      const proof = proofs.get(name);
      if (proof === undefined || proof instanceof Error) throw proof ?? new Error("no proof");
      const seen = site === undefined ? proof.report.verdict : `${proof.report.assertions.find((a) => a.site === site[0])?.verdict}, ${proof.report.verdict}`;
      expect(seen).toBe(site === undefined ? verdict : `${site[1]}, ${verdict}`);
      if (reason !== undefined) expect(proof.report.reason).toMatch(reason);
      if (under !== undefined) {
        const mutation = proof.report.mutations.find((m) => m.id === under[0])!;
        const target = journeyAssertions(proof.journey).find((a) => assertionSiteKey(a) === under[1])!;
        expect(classifyMutation(target, mutation, mutation)).toBe(under[2]);
      }
    });
  }
});
