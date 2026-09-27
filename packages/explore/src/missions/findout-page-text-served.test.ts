import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeGenerationGateway,
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
import { withSession } from "../testkit.js";

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
  "/packs-bare": `<!doctype html><html><body><p>Nothing to see here.</p><button type="button">Refresh</button></body></html>`,
  "/packs": `<!doctype html><html><body><h1>Credit packs</h1><p>Choose how many packs you need.</p>
<button type="button">3 packs</button></body></html>`,
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const html = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
    res.writeHead(html === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
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
  constructor(private readonly policy: (state: JudgmentState, turn: number) => string) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    if (!("action" in args.questions)) {
      const out: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(args.questions)) if (q.kind === "noul") out[name] = { kind: "noul", value: false, probability: 0.1 };
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
  ) {}
  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    if (kind !== "goal.answer") return this.#fallback.generate(kind, input);
    const pages = (input as { pages: string }).pages;
    this.pagesSeen.push(pages);
    const m = this.pattern.exec(pages);
    const value = m?.[1];
    const output = value === undefined ? { answer: null, claims: [] } : { answer: value, claims: [{ claim: this.claim(value), quote: value }] };
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
