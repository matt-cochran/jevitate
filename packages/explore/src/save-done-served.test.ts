import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { GOAL_IS_SAVE_QUESTION, GOAL_MET_QUESTION } from "./decide.js";
import { ScriptedJudge, withSession, type ScriptedStep, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #225 item 1 — a usability job "save a bio on your profile" (the example site's /demo/profile)
 * failed 3/3: the bio really saved and the page said "Saved", yet the model's `done` was rejected
 * (p 0.66 → 0.42) and the run ended `job-incomplete`. The done-judge only ever saw the page's
 * `innerText`, which never contains a form field's VALUE — so the saved bio, displayed only in its
 * textarea, was invisible to it. Served page (the demo's shape), real Chromium; a deterministic fake
 * judge that answers the goal question by whether the value the server saved is visible in its state.
 */

let saved = { displayName: "Ada Lovelace", bio: "" };
/** Which status the save reports: the demo's planted bug says "Saved" on a 500 too. */
let failSave = false;

const page = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Profile settings</title></head>
<body><h1>Profile settings</h1>
<form id="profile">
<label>Display name <input name="displayName" aria-label="Display name" value="${saved.displayName}"></label>
<label>Bio <textarea name="bio" aria-label="Bio">${saved.bio}</textarea></label>
<button type="submit">Save</button>
</form>
<p role="status" data-testid="status"></p>
<script>
document.getElementById("profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const res = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ok = !(res.status >= 400 && res.status < 500);
  document.querySelector("[data-testid=status]").textContent = ok ? "Saved" : "Please check the form.";
});
</script></body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/profile" && req.method === "PUT") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        if (failSave) {
          res.writeHead(500, { "content-type": "application/json" }).end('{"ok":false}');
          return;
        }
        const b = JSON.parse(raw) as { displayName?: string; bio?: string };
        saved = { displayName: b.displayName ?? saved.displayName, bio: b.bio ?? saved.bio };
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    if (path === "/profile") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  saved = { displayName: "Ada Lovelace", bio: "" };
  failSave = false;
});

/**
 * The scripted run's goal judge: P(goal met) is high only when the bio the SERVER saved is visible in
 * what the judge was shown — a judge can only confirm what it can see.
 */
class SavedValueJudge extends ScriptedJudge {
  override async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    if (!("action" in args.questions)) {
      const visible = saved.bio !== "" && JSON.stringify(args.state).includes(saved.bio.slice(0, 40));
      this.goalMetProbability = visible ? 0.9 : 0.42;
    }
    return super.systemOne(args);
  }
}

const GOAL = "Add a short bio to your profile and save it.";

async function run(judge: ScriptedJudge): Promise<ExploreRun> {
  return withSession(
    "explore-save-done-",
    async (session) => {
      const actor = CastActor.named("save-done").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: GOAL,
        allowlist: [base],
        startUrl: `${base}/profile`,
        bounds: { maxDecisions: 8 },
      });
    },
    base,
  );
}

// Profile: [0] Display name, [1] Bio, [2] Save.
const SAVE_THEN_DONE: ScriptedStep[] = [{ op: "type", target: "1" }, { op: "click", target: "2" }, { op: "done" }];

describe("#225 — a completed save is recognised as done", () => {
  it(
    "the saved bio (shown only in its field) reaches the done-judge: done accepted, run completed",
    async () => {
      const judge = new SavedValueJudge(SAVE_THEN_DONE);
      const r = await run(judge);

      expect(saved.bio).not.toBe("");
      expect(r.outcome.status).toBe("completed");
      expect(r.stop).toBe("done");
      const call = judge.goalCalls.at(-1);
      expect(Object.keys(call?.questions ?? {})).toContain(GOAL_MET_QUESTION);
      expect(JSON.stringify(call?.state)).toContain(saved.bio.slice(0, 40));
    },
    90_000,
  );

  /** A judge as timid as the live one: P(goal met) 0.42 whatever it is shown; `goalIsSave` scopes the goal. */
  function timid(goalIsSave: number): ScriptedJudge {
    const judge = new ScriptedJudge(SAVE_THEN_DONE);
    judge.goalMetProbability = 0.42;
    judge.noulProbabilities = { [GOAL_IS_SAVE_QUESTION]: goalIsSave };
    return judge;
  }

  it(
    "code evidence is preferred: the save went through (2xx, \"Saved\", value still shown) → done, verified by save-signals",
    async () => {
      const judge = timid(0.95);
      const r = await run(judge);

      expect(r.outcome).toEqual({ status: "completed", verifiedBy: "save-signals" });
      const accepted = r.transcript.at(-1);
      expect(accepted?.reason).toMatch(/done accepted: goal verified by save-signals/);
      expect(accepted?.judgments?.goalIsSave).toEqual({ value: true, probability: 0.95 });
      const call = judge.goalCalls.at(-1);
      expect(Object.keys(call?.questions ?? {})).toEqual([GOAL_MET_QUESTION, GOAL_IS_SAVE_QUESTION]);
      const facts = call?.state.controls.find((c) => c.startsWith("SAVE (observed by code"));
      expect(facts).toMatch(/clicking "Save" sent PUT \/api\/profile → 200/);
      expect(facts).toMatch(/success notice \("Saved"\)/);
      expect(facts).toMatch(/still displays every value it saved/);
      // Facts carry labels and routes only — never the typed value itself.
      expect(facts).not.toContain(saved.bio);
    },
    90_000,
  );

  it(
    "the planted bug (a 500, yet the page says \"Saved\") is never code evidence of a save",
    async () => {
      failSave = true;
      const judge = timid(0.95);
      const r = await run(judge);

      expect(r.outcome.status).toBe("incomplete");
      const facts = judge.goalCalls.at(-1)?.state.controls.find((c) => c.startsWith("SAVE (observed by code"));
      expect(facts).toMatch(/PUT \/api\/profile → 500/);
    },
    90_000,
  );

  it(
    "a goal asking for more than the save still needs the goal judgment (scope < threshold): not done",
    async () => {
      const r = await run(timid(0.2));
      expect(r.outcome.status).toBe("incomplete");
      expect(r.transcript.at(-1)?.reason).toMatch(/done rejected \(3\/3\)/);
    },
    90_000,
  );
});
