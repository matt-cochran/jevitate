import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeGenerationGateway,
  GOAL_ANSWER_INSTRUCTIONS,
  type Answer,
  type GenerationPort,
  type GenerationResult,
  type GenInput,
  type GenTaskKind,
  type JudgmentPort,
  type JudgmentState,
  type Question,
} from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { withSession, useSkippingTime } from "../testkit.js";
import { ANSWER_FITS_QUESTION } from "../answer.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #207 — a find-out goal must answer from ordinary page text and from a form field's value, and an
 * unanswerable one must say so. Dogfood on the example site: the key's name in a table cell and an
 * item's h1 were never reported (the model scrolled, then `blocked`, never `report`: the decision
 * state carried controls only, so the answer was invisible to it); a saved email in an
 * `<input value>` could not ground an answer (the observed text is `innerText`, which never holds a
 * control's value); and a find-out whose answer is absent ended "no progress" instead of naming what
 * it searched. Real Chromium, served pages, a deterministic judge that decides from the state it is
 * shown, and a generator that answers only from the `pages` it is given.
 */

const PAGES: Record<string, string> = {
  "/keys": `<!doctype html><html><body><h1>API keys</h1>
<table><thead><tr><th>ID</th><th>Name</th></tr></thead>
<tbody><tr><td>k_live_1</td><td>Production key</td></tr></tbody></table>
<button type="button">Acknowledge</button></body></html>`,
  "/items/item-1": `<!doctype html><html><body><h1>Quarterly roadmap review</h1>
<p>Owner: tenant b</p><a href="/items">All items</a></body></html>`,
  "/tenancy/items/item-1": `<!doctype html><html><head><title>Item · Example</title></head><body>
<nav><a href="/tenancy/items">Items</a></nav><h1>Tenant B roadmap</h1>
<p>Owner: tenant b</p><p>Status: open</p></body></html>`,
  "/profile": `<!doctype html><html><body><h1>Profile</h1>
<form onsubmit="return false"><label>Display name <input name="displayName" value="Ada Lovelace"></label>
<label>Email <input name="email" type="email" value="ada@example.test"></label>
<label>Password <input name="password" type="password" value="hunter2-secret"></label>
<button type="submit">Save</button></form></body></html>`,
  "/bio": `<!doctype html><html><body><h1>Profile</h1>
<form onsubmit="return false"><label>Display name <input name="displayName" value="Ada Lovelace"></label>
<label>Bio <textarea name="bio" aria-label="Bio">Mathematician and writer; first to publish an algorithm for a machine.</textarea></label>
<button type="submit">Save</button></form></body></html>`,
  // #223: tenant a's view of tenant b's item — a 404 whose only way on is "Back to items" …
  "/t/items/item-1": `<!doctype html><html><head><title>Items · Example</title></head><body>
<h1>Item not found</h1><a href="/t/items">Back to items</a></body></html>`,
  // … to a list with no items of its own: a create form (a "Title" label and a "Create item" button).
  "/t/items": `<!doctype html><html><head><title>Items · Example</title></head><body><h1>Items</h1>
<p>No items yet.</p>
<form onsubmit="return false"><label>Title <input name="title" aria-label="Title"></label><button type="submit">Create item</button></form></body></html>`,
  "/notes": `<!doctype html><html><body><h1>Notes</h1>
<div contenteditable="true" role="textbox" aria-label="Notes">Call the bank on Tuesday.<br>Renew the lease.</div></body></html>`,
  // #223: item titles as links in the content (a list), beside nav links.
  "/list": `<!doctype html><html><body><nav><a href="/list">Home</a> <a href="/about">About us</a></nav>
<main><h1>Items</h1><ul><li><a href="/i/1">Quarterly roadmap review</a></li><li><a href="/i/2">Hiring plan</a></li></ul></main></body></html>`,
  "/packs-bare": `<!doctype html><html><body><p>Nothing to see here.</p><button type="button">Refresh</button></body></html>`,
  "/packs": `<!doctype html><html><body><h1>Credit packs</h1><p>Choose how many packs you need.</p>
<button type="button">3 packs</button></body></html>`,
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const html = PAGES[path];
    res.writeHead(html === undefined || path === "/t/items/item-1" ? 404 : 200, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A judge that decides from what it is SHOWN, like the real model: `report` once the answer is
 * visible in the state (its controls or its visible page text), else it scrolls and then gives up
 * (`blocked`) — or follows a fixed policy. The goal-completion judgment says "not met" (a find-out
 * goal is verified by a grounded answer, never by an advisory judgment).
 */
class ReadingJudge implements JudgmentPort {
  readonly states: JudgmentState[] = [];
  /** #223: every "does this quote answer the goal's question?" ask, and Jev's P(yes) to it. */
  readonly fitsCalls: JudgmentState[] = [];
  fitsProbability = 0.9;
  /** #229: Jev's P(yes) per ask, in order (a real model's judgments vary); then `fitsProbability`. */
  fitsSequence: number[] = [];
  constructor(private readonly policy: (state: JudgmentState, turn: number) => string) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    if (!("action" in args.questions)) {
      const out: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(args.questions)) {
        if (q.kind !== "noul") continue;
        if (name === ANSWER_FITS_QUESTION) {
          this.fitsCalls.push(args.state);
          const p = this.fitsSequence.shift() ?? this.fitsProbability;
          out[name] = { kind: "noul", value: p >= 0.5, probability: p };
        } else out[name] = { kind: "noul", value: false, probability: 0.1 };
      }
      return out;
    }
    this.states.push(args.state);
    return { action: { kind: "choice", value: this.policy(args.state, this.states.length - 1), confidence: 0.8 } };
  }
}

const shows = (state: JudgmentState, needle: string): boolean =>
  [...state.controls, state.visibleText ?? ""].some((line) => line.includes(needle));

/** Reports when it sees `needle`; otherwise scrolls twice, then `blocked` (the dogfood transcript). */
const reportWhenSeen =
  (needle: string) =>
  (state: JudgmentState, turn: number): string =>
    shows(state, needle) ? "report" : turn < 2 ? "scroll_down" : "blocked";

/**
 * A generator that answers ONLY from the `pages` it is handed (the observed pages as code renders
 * them): the first match of `pattern` there is the answer, quoted verbatim; no match → `answer: null`.
 */
class PageReadingGen implements GenerationPort {
  readonly pagesSeen: string[] = [];
  readonly #fallback = new FakeGenerationGateway();
  constructor(
    private readonly pattern: RegExp,
    private readonly claim: (value: string) => string,
    private readonly quote: (value: string) => string = (v) => v,
  ) {}
  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    if (kind !== "goal.answer") return this.#fallback.generate(kind, input);
    const pages = (input as { pages: string }).pages;
    this.pagesSeen.push(pages);
    const m = this.pattern.exec(pages);
    const value = m?.[1];
    const output = value === undefined ? { answer: null, claims: [] } : { answer: value, claims: [{ claim: this.claim(value), quote: this.quote(value) }] };
    return {
      output,
      provenance: { adapter: "fake", model: "page-reader", promptVersion: "2", latencyMs: 0, responseHash: "x" },
    } as unknown as GenerationResult<K>;
  }
}

/**
 * #216: gpt-4o-mini's behaviour on "the title of this item" over an h1 — `null` when asked plainly,
 * the heading once the page's main heading is hinted. Deterministic; records every ask's `hint`.
 */
class TitleBlindGen implements GenerationPort {
  readonly hints: (string | undefined)[] = [];
  readonly #fallback = new FakeGenerationGateway();
  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    if (kind !== "goal.answer") return this.#fallback.generate(kind, input);
    const hint = (input as { hint?: string }).hint;
    this.hints.push(hint);
    const heading = hint === undefined ? undefined : /main heading is "([^"]+)"/.exec(hint)?.[1];
    const output =
      heading === undefined ? { answer: "null", claims: [] } : { answer: heading, claims: [{ claim: `The item is titled ${heading}`, quote: heading }] };
    return {
      output,
      provenance: { adapter: "fake", model: "title-blind", promptVersion: "3", latencyMs: 0, responseHash: "x" },
    } as unknown as GenerationResult<K>;
  }
}

async function run(path: string, goal: string, judge: JudgmentPort, gen: GenerationPort): Promise<GoalBasedResult> {
  return withSession(
    "findout-page-text-",
    async (session) => {
      const actor = CastActor.named("reader").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen,
        goal,
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        waitOpMs: 300,
        bounds: { maxDecisions: 12 },
      });
    },
    origin,
  );
}

const reasonOf = (r: GoalBasedResult): string => (r.run.outcome.status === "incomplete" ? r.run.outcome.reason : "");

describe("#207 — a find-out goal answers from page text and form values; an absent answer says so", () => {
  it(
    "answer in a table cell: the decision shows the page's visible text, the model reports, code grounds it",
    async () => {
      const judge = new ReadingJudge(reportWhenSeen("Production key"));
      const gen = new PageReadingGen(/(Production key)/, (v) => `The key listed in the table is named ${v}`);
      const r = await run("/keys", "Find out the name of the key listed in the table and report it", judge, gen);

      // The table cell is not a control: only the page's visible text shows it to the decision.
      expect(judge.states[0]?.visibleText).toContain("Production key");
      expect(r.outcome).toBe("succeeded");
      expect(r.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.run.answer?.text).toBe("Production key");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "page-text" });
      // Read-only: nothing was clicked on the way.
      expect(r.transcript.some((e) => e.op === "click")).toBe(false);
    },
    90_000,
  );

  it(
    "answer in an h1, a model that only ever says `blocked`: the give-up becomes one grounded report attempt",
    async () => {
      const judge = new ReadingJudge(() => "blocked");
      const gen = new PageReadingGen(/URL: [^\n]*\n([^\n]+)/, (v) => `The item is titled ${v}`);
      const r = await run("/items/item-1", "Find out the title of this item", judge, gen);

      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer?.text).toBe("Quarterly roadmap review");
      const report = r.transcript.find((e) => e.op === "report");
      expect(report?.actOk).toBe(true);
      expect(report?.reason).toMatch(/report accepted/);
      // The model was told why its `blocked` did not end the run.
      expect(r.transcript.every((e) => !/model blocked/.test(e.reason ?? ""))).toBe(true);
    },
    90_000,
  );

  it(
    "#216 'title of this item': a generator that answers null is retried ONCE with the page's h1 / <title> hint, and the heading grounds",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new TitleBlindGen();
      const r = await run("/tenancy/items/item-1", "Find out the title of this item", judge, gen);

      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer?.text).toBe("Tenant B roadmap");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "page-text" });
      // First ask plain; the single retry carries the main heading and the document title.
      expect(gen.hints).toHaveLength(2);
      expect(gen.hints[0]).toBeUndefined();
      expect(gen.hints[1]).toContain('main heading is "Tenant B roadmap"');
      expect(gen.hints[1]).toContain('document title is "Item · Example"');
    },
    90_000,
  );

  it(
    "#216 no heading, no title: a null answer is not retried",
    async () => {
      const judge = new ReadingJudge(() => "blocked");
      const gen = new TitleBlindGen();
      const r = await run("/packs-bare", "Find out the title of this item", judge, gen);

      expect(r.outcome).not.toBe("succeeded");
      expect(gen.hints.every((h) => h === undefined)).toBe(true);
      expect(gen.hints).toHaveLength(1);
    },
    90_000,
  );

  it(
    "answer in an input's value: the generator sees FORM FIELD VALUES, code grounds on the control value — recorded as such",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new PageReadingGen(/^Email: (\S+)$/m, (v) => `The saved email is ${v}`);
      const r = await run("/profile", "Find out what email is saved on the profile", judge, gen);

      expect(r.outcome).toBe("succeeded");
      expect(r.run.answer?.text).toBe("ada@example.test");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "control-value", control: "Email" });
      // A password field's value never reaches the generator (nor the transcript).
      expect(gen.pagesSeen.join("\n")).not.toContain("hunter2-secret");
      expect(JSON.stringify(r.transcript)).not.toContain("hunter2-secret");
    },
    90_000,
  );

  it(
    "answer absent: the run ends 'answer not found (pages seen: …)', not a generic no-progress",
    async () => {
      const judge = new ReadingJudge(() => "scroll_down");
      const gen = new PageReadingGen(/(\$\d+(?:\.\d+)?)/, (v) => `The 10-pack costs ${v}`);
      const r = await run("/packs", "Find out the price of the 10-pack", judge, gen);

      expect(r.outcome).not.toBe("succeeded");
      expect(r.run.answer).toBeUndefined();
      // The last-chance idle became a report attempt, which found nothing …
      expect(r.transcript.some((e) => e.op === "report" && /no answer was found/.test(e.reason ?? ""))).toBe(true);
      // … and the run's reason says what was searched.
      expect(reasonOf(r)).toBe("answer not found (pages seen: /packs)");
      expect(r.reason).toContain("answer not found (pages seen: /packs)");
    },
    90_000,
  );

  it(
    "answer absent, a model that says `blocked`: one report attempt, then blocked — 'answer not found'",
    async () => {
      const judge = new ReadingJudge(() => "blocked");
      const gen = new PageReadingGen(/(\$\d+(?:\.\d+)?)/, (v) => `The 10-pack costs ${v}`);
      const r = await run("/packs", "Find out the price of the 10-pack", judge, gen);

      expect(r.run.stop).toBe("blocked");
      expect(r.transcript.filter((e) => e.op === "report")).toHaveLength(1);
      expect(reasonOf(r)).toBe("answer not found (pages seen: /packs)");
    },
    90_000,
  );
});

/** #223: a generator that always proposes the same answer (the dogfood transcript's). */
class FixedAnswerGen implements GenerationPort {
  readonly hints: (string | undefined)[] = [];
  readonly #fallback = new FakeGenerationGateway();
  constructor(private readonly output: { answer: string; claims: { claim: string; quote: string }[] }) {}
  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    if (kind !== "goal.answer") return this.#fallback.generate(kind, input);
    this.hints.push((input as { hint?: string }).hint);
    return {
      output: this.output,
      provenance: { adapter: "fake", model: "fixed", promptVersion: "3", latencyMs: 0, responseHash: "x" },
    } as unknown as GenerationResult<K>;
  }
}

const TITLE_GOAL = "Find out the title of this item";

describe("#223 — a quote on the page must answer the question; a textarea's value grounds like an input's", () => {
  it(
    "404, then 'Back to items', then the 'Create item' button's label as the title: rejected by code — answer not found",
    async () => {
      // On the 404 page: follow "Back to items" (control 0); then report.
      const judge = new ReadingJudge((state) => (shows(state, "Item not found") ? "click:0" : "report"));
      const gen = new FixedAnswerGen({ answer: "Create item", claims: [{ claim: "The title of this item is Create item", quote: "Create item" }] });
      const r = await run("/t/items/item-1", TITLE_GOAL, judge, gen);

      expect(r.outcome).not.toBe("succeeded");
      expect(r.run.answer).toBeUndefined();
      expect(reasonOf(r)).toBe("answer not found (pages seen: /t/items/item-1, /t/items)");
      const rejected = r.transcript.filter((e) => e.op === "report");
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected.every((e) => e.actOk === false && /only a control's label/.test(e.reason ?? ""))).toBe(true);
      // Code rejected it: Jev (who would have said yes here) was never what decided — it never approves alone.
      expect(judge.fitsCalls).toHaveLength(0);
    },
    90_000,
  );

  it(
    "the label and the button run together ('Title Create item'): still only controls' names — rejected",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new FixedAnswerGen({ answer: "Create item", claims: [{ claim: "The item title is Create item", quote: "Title Create item" }] });
      const r = await run("/t/items", TITLE_GOAL, judge, gen);

      expect(r.outcome).not.toBe("succeeded");
      expect(reasonOf(r)).toBe("answer not found (pages seen: /t/items)");
    },
    90_000,
  );

  it(
    "an answer on the 404 page itself (its h1 'Item not found' as the title): rejected — the page answered HTTP 404; no heading retry",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new FixedAnswerGen({ answer: "Item not found", claims: [{ claim: "The item is titled Item not found", quote: "Item not found" }] });
      const r = await run("/t/items/item-1", TITLE_GOAL, judge, gen);

      expect(r.outcome).not.toBe("succeeded");
      expect(r.run.answer).toBeUndefined();
      expect(reasonOf(r)).toBe("answer not found (pages seen: /t/items/item-1)");
      expect(r.transcript.find((e) => e.op === "report")?.reason).toMatch(/HTTP 404/);
      // An error page's heading is never offered as the item's title (#216's hint).
      expect(gen.hints.every((h) => h === undefined)).toBe(true);
    },
    90_000,
  );

  it(
    "Jev's veto: page content code grounds, but Jev says it does not answer the question — rejected",
    async () => {
      const judge = new ReadingJudge(() => "report");
      judge.fitsProbability = 0.05;
      const gen = new FixedAnswerGen({ answer: "tenant b", claims: [{ claim: "The item's title is tenant b", quote: "Owner: tenant b" }] });
      const r = await run("/items/item-1", TITLE_GOAL, judge, gen);

      expect(r.outcome).not.toBe("succeeded");
      expect(r.run.answer).toBeUndefined();
      expect(judge.fitsCalls.length).toBeGreaterThan(0);
      expect(judge.fitsCalls[0]?.controls.some((c) => c.includes("Owner: tenant b"))).toBe(true);
      expect(r.transcript.find((e) => e.op === "report")?.reason).toMatch(/does not answer the question \(Jev vetoed it/);
      expect(reasonOf(r)).toMatch(/^answer not found/);
    },
    90_000,
  );

  it(
    "a <textarea>'s value (quoted as the model sees it, 'Bio: …' with its full stop) grounds on the control value",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new PageReadingGen(/^Bio: (.+)$/m, (v) => `The current bio text on the profile is '${v}'`, (v) => `Bio: ${v}`);
      const r = await run("/bio", "What is the current bio text on the profile?", judge, gen);

      expect(r.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.run.answer?.text).toBe("Mathematician and writer; first to publish an algorithm for a machine.");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "control-value", control: "Bio" });
      // Jev was asked and said yes — the veto only ever turns an accept into a reject.
      expect(judge.fitsCalls).toHaveLength(1);
    },
    90_000,
  );

  it(
    "a contenteditable's text (quoted as a form field value, 'Notes: …') grounds on the control value",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new PageReadingGen(/^Notes: (.+)$/m, (v) => `The notes say '${v}'`, (v) => `Notes: ${v}`);
      const r = await run("/notes", "What do the notes say?", judge, gen);

      expect(r.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.run.answer?.text).toBe("Call the bank on Tuesday. Renew the lease.");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "control-value", control: "Notes" });
    },
    90_000,
  );

  it(
    "a list of item-title links: 'the title of the first item' is answered from the link text (content, not an action)",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new FixedAnswerGen({
        answer: "Quarterly roadmap review",
        claims: [{ claim: "The first item is titled Quarterly roadmap review", quote: "Quarterly roadmap review" }],
      });
      const r = await run("/list", "Find the title of the first item in the list", judge, gen);

      expect(r.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.run.answer?.text).toBe("Quarterly roadmap review");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "page-text" });
    },
    90_000,
  );

  it(
    "a nav link's label is still only a control's label — rejected, answer not found",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new FixedAnswerGen({ answer: "About us", claims: [{ claim: "The company is called About us", quote: "About us" }] });
      const r = await run("/list", "Find out the name of the company", judge, gen);

      expect(r.outcome).not.toBe("succeeded");
      expect(r.transcript.find((e) => e.op === "report")?.reason).toMatch(/only a control's label/);
      expect(reasonOf(r)).toBe("answer not found (pages seen: /list)");
    },
    90_000,
  );
});

/**
 * #229: gpt-4o-mini on a list page. It follows the brief's word on headings: while the instructions
 * (or a hint) say the page's heading IS the title of what it shows, it answers the heading — its claim
 * copying the hint's wording; otherwise it answers an ordinal question from the list's entries (the
 * lines after the heading). Records every ask's `hint`.
 */
class HeadingLedGen implements GenerationPort {
  readonly hints: (string | undefined)[] = [];
  readonly #fallback = new FakeGenerationGateway();
  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    if (kind !== "goal.answer") return this.#fallback.generate(kind, input);
    const i = input as { pages: string; hint?: string; instructions?: string };
    this.hints.push(i.hint);
    const instructions = i.instructions ?? GOAL_ANSWER_INSTRUCTIONS;
    const lines = i.pages.split("\n").map((l) => l.trim());
    const at = lines.indexOf("Items");
    const hinted = i.hint === undefined ? undefined : /main heading is "([^"]+)"/.exec(i.hint)?.[1];
    const output =
      hinted !== undefined
        ? { answer: hinted, claims: [{ claim: `The current page's main heading is ${hinted}`, quote: hinted }] }
        : /heading[^.]*\bIS the title\b/.test(instructions) && at >= 0
          ? { answer: "Items", claims: [{ claim: "The page's main heading is the title: Items", quote: "Items" }] }
          : at >= 0 && lines[at + 1]
            ? { answer: lines[at + 1]!, claims: [{ claim: "The first entry of the list", quote: lines[at + 1]! }] }
            : { answer: null, claims: [] };
    return {
      output,
      provenance: { adapter: "fake", model: "heading-led", promptVersion: "4", latencyMs: 0, responseHash: "x" },
    } as unknown as GenerationResult<K>;
  }
}

describe("#229 — find-out with real-model behaviour: a veto stands, list pages are answered from their entries, the answer in its quote grounds", () => {
  it(
    "H1: 'Items' on tenant a's empty list, vetoed once (p=0.23), re-reported and judged yes next time: still rejected — answer not found",
    async () => {
      const judge = new ReadingJudge(() => "report");
      judge.fitsSequence = [0.23];
      const gen = new FixedAnswerGen({ answer: "Items", claims: [{ claim: "The title of this item is Items", quote: "Items" }] });
      const r = await run("/t/items", TITLE_GOAL, judge, gen);

      expect(r.outcome).not.toBe("succeeded");
      expect(r.run.answer).toBeUndefined();
      expect(reasonOf(r)).toBe("answer not found (pages seen: /t/items)");
      const reports = r.transcript.filter((e) => e.op === "report");
      expect(reports.length).toBeGreaterThan(1);
      expect(reports.every((e) => e.actOk === false)).toBe(true);
      expect(reports.slice(1).every((e) => /already vetoed/.test(e.reason ?? ""))).toBe(true);
      // Jev was asked once; the veto was never re-judged.
      expect(judge.fitsCalls).toHaveLength(1);
      // "this item" on a page whose heading names the list ("Items"): no heading hint.
      expect(gen.hints.every((h) => h === undefined)).toBe(true);
    },
    90_000,
  );

  it(
    "H2: 'the title of the first item' on a list page is the first entry's link text, never the list's heading; no heading hint",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new HeadingLedGen();
      const r = await run("/list", "Find out the title of the first item", judge, gen);

      expect(r.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.run.answer?.text).toBe("Quarterly roadmap review");
      expect(gen.hints.every((h) => h === undefined)).toBe(true);
    },
    90_000,
  );

  it(
    "H3: the bio, claimed in words the quote does not share ('The bio of the profile states what the user does'): the answer is in its quote — grounded",
    async () => {
      const judge = new ReadingJudge(() => "report");
      const gen = new PageReadingGen(/^Bio: (.+)$/m, () => "The bio of the profile states what the user does", (v) => `Bio: ${v}`);
      const r = await run("/bio", "What is the current bio text on the profile?", judge, gen);

      expect(r.run.outcome).toEqual({ status: "completed", verifiedBy: "grounded-answer" });
      expect(r.run.answer?.text).toBe("Mathematician and writer; first to publish an algorithm for a machine.");
      expect(r.run.answer?.evidence[0]).toMatchObject({ grounded: true, source: "control-value", control: "Bio" });
    },
    90_000,
  );
});
