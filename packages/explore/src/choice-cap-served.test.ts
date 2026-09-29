import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeGenerationGateway,
  MAX_CHOICE_OPTIONS,
  type Answer,
  type JudgmentPort,
  type JudgmentState,
  type Question,
} from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import { withSession } from "./testkit.js";

/**
 * #192 — a page with more controls than the judgment API's choice cap (a country picker with ≈300
 * options open inside a dialog, plus the page's own controls) must still yield decisions: the
 * candidate set is bounded below the cap, an option the goal names is reachable even deep in the
 * list, the dialog's Save after the list is still offered, and a refusal of the count is retried
 * with a tighter budget instead of ending the run.
 */
const COUNTRIES = Array.from({ length: 300 }, (_, i) => (i === 280 ? "Uruguay" : `Country ${String(i).padStart(3, "0")}`));

const PAGE = `<!doctype html><html><body>
<header><nav>${Array.from({ length: 12 }, (_, i) => `<a href="#n${i}">Nav ${i}</a>`).join(" ")}</nav></header>
<main>
  <h1>Phone numbers</h1>
  <button id="add" type="button">Add New Phone Number</button>
  <div id="dlg" role="dialog" aria-label="Add phone number" hidden>
    <button id="cc" type="button" aria-haspopup="listbox">Country code</button>
    <span id="chosen">none</span>
    <ul id="list" role="listbox" aria-label="Countries" hidden>
      ${COUNTRIES.map((c) => `<li role="option" tabindex="0">${c}</li>`).join("\n")}
    </ul>
    <button id="save" type="button">Save</button>
  </div>
  <p id="saved">not saved</p>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  $("add").onclick = () => { $("dlg").hidden = false; };
  $("cc").onclick = () => { $("list").hidden = false; };
  for (const li of document.querySelectorAll('[role=option]')) {
    li.onclick = () => { $("chosen").textContent = li.textContent; $("list").hidden = true; };
  }
  $("save").onclick = () => { $("saved").textContent = "saved: " + $("chosen").textContent; };
</script>
</body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * Plays the judgment API's contract: a choice question with more than `cap` options is refused with
 * its real message. Otherwise picks the first option matching the step's pattern.
 */
class CappedJudge implements JudgmentPort {
  #i = 0;
  readonly optionCounts: number[] = [];
  readonly histories: string[][] = [];
  constructor(
    private readonly steps: readonly RegExp[],
    private readonly cap: number = MAX_CHOICE_OPTIONS,
  ) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const q = args.questions.action;
    if (q === undefined) {
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "noul", value: false, probability: 0.05 };
      return out;
    }
    if (q.kind !== "choice") throw new Error("expected a choice");
    this.optionCounts.push(q.options.length);
    if (q.options.length > this.cap) throw new Error(`400 Too many choices. Must have at most ${this.cap} choices.`);
    this.histories.push([...args.state.history]);
    const pattern = this.steps[Math.min(this.#i, this.steps.length - 1)] as RegExp;
    this.#i += 1;
    const pick = q.options.find((o) => pattern.test(o) || pattern.test(q.descriptions?.[o] ?? ""));
    if (pick === undefined) throw new Error(`no option matches ${String(pattern)}`);
    const out: Record<string, Answer> = { action: { kind: "choice", value: pick, confidence: 0.9 } };
    for (const name of Object.keys(args.questions)) if (name !== "action") out[name] = { kind: "noul", value: false, probability: 0.05 };
    return out;
  }
}

const GOAL = "Add a phone number for Uruguay and save it.";
const STEPS = [/click button "Add New Phone Number"/, /click button "Country code"/, /click option "Uruguay"/, /click button "Save"/, /^done$/];

function run(judge: JudgmentPort) {
  return withSession(
    "choice-cap-",
    async (session) =>
      explore({
        actor: CastActor.named("user").whoCan(new BrowseTheWeb(session, [base])),
        judge,
        gen: new FakeGenerationGateway(),
        goal: GOAL,
        allowlist: [base],
        startUrl: `${base}/numbers`,
        bounds: { maxDecisions: 8 },
        waitOpMs: 300,
        successCheck: async () => (await session.page.locator("#saved").textContent()) === "saved: Uruguay",
      }),
    base,
  );
}

describe("#192 — more controls than the judgment API's choice cap", () => {
  it(
    "every decision stays within the cap; the goal's option deep in the list and the dialog's Save stay reachable",
    async () => {
      const judge = new CappedJudge(STEPS);
      const r = await run(judge);
      expect(r.stop).toBe("done");
      expect(Math.max(...judge.optionCounts)).toBeLessThanOrEqual(MAX_CHOICE_OPTIONS);
    },
    240_000,
  );

  it(
    "an API that refuses a smaller count than documented is retried with a tighter budget, never ending the run",
    async () => {
      const judge = new CappedJudge(STEPS, 40);
      const r = await run(judge);
      expect(r.stop).toBe("done");
      expect(judge.optionCounts.some((n) => n > 40)).toBe(true); // refused once (the open picker)…
      expect(judge.histories.some((h) => h.some((l) => /too many choices for the model: retried with the 40 most relevant/.test(l)))).toBe(true); // …and retried
    },
    240_000,
  );
});
