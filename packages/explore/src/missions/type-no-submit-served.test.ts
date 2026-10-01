import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type GenerationPort } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission, type GoalBasedResult } from "./goal-based.js";
import { PreferenceJudge, withSession } from "../testkit.js";

/**
 * #242 — a goal run typed 49 different queries into the same search box and never submitted it:
 * the box searches only on Enter, so nothing was requested and nothing changed but the field's own
 * value — which counted as progress. Retyping the same field with no request and no change beyond
 * its own value is no progress: a search-like field is submitted (Enter) after one such retype, any
 * other field ends the run as stuck after a few.
 */

const HTML = `<!doctype html><html><body>
<header><input id="q" type="text" aria-label="Semantic search" placeholder="Search evidence… ⌘K"></header>
<main><h1>Home</h1><label>Notes <input id="notes" type="text"></label><ul id="results"></ul></main>
<script>
  setInterval(() => fetch("/api/balance").catch(() => {}), 2000);
  document.getElementById("q").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const r = await fetch("/api/search?q=" + encodeURIComponent(e.target.value));
    const items = await r.json();
    document.getElementById("results").innerHTML = items.map((i) => "<li>" + i + "</li>").join("");
  });
</script>
</body></html>`;

let server: Server;
let origin: string;
let searches = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/balance")) return void res.writeHead(200, { "content-type": "application/json" }).end("{\"credits\":0}");
    if (req.url?.startsWith("/api/search")) {
      searches += 1;
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(["Setup A: pricing page test", "Setup B: onboarding email"]));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A value generator that never repeats itself (the real model kept trying synonyms). */
class Synonyms implements GenerationPort {
  #n = 0;
  generate: GenerationPort["generate"] = (kind, input) => {
    this.#n += 1;
    return new FakeGenerationGateway({ "form.value": { text: `similar product setups ${this.#n}` } }).generate(kind, input);
  };
}

async function run(field: string, goal: string, goalMet: number): Promise<{ result: GoalBasedResult; judge: PreferenceJudge }> {
  // Types into `field` until the history says it was submitted, then proposes done.
  const judge = new PreferenceJudge((_n, state) => (state.history.some((h) => /^submitted /.test(h)) ? [] : [{ op: "type", name: field }]), "done");
  judge.goalMetProbability = goalMet;
  const result = await withSession(
    "type-no-submit-",
    async (session) => {
      const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        judge,
        gen: new Synonyms(),
        goal,
        allowlist: [origin],
        startUrl: `${origin}/home`,
        waitOpMs: 300,
        bounds: { maxDecisions: 20 },
      });
    },
    origin,
  );
  return { result, judge };
}

const types = (r: GoalBasedResult) => r.transcript.filter((e) => e.op === "type" && e.actOk);

describe("#242 — retyping one field with nothing happening is no progress", () => {
  it(
    "a search box that searches only on Enter is submitted after one retype that fired nothing",
    async () => {
      searches = 0;
      const { result, judge } = await run("Semantic search", "Find other setups similar to one your product has learned about.", 0.9);
      expect(searches).toBeGreaterThanOrEqual(1);
      expect(judge.states.some((s) => s.history.some((h) => /submitted "Semantic search" with Enter/.test(h)))).toBe(true);
      // Never the 49-step loop: the run ends within a handful of types.
      expect(types(result).length).toBeLessThanOrEqual(3);
      expect(result.run.stop).toBe("done");
    },
    90_000,
  );

  it(
    "a plain field retyped with no effect ends the run as stuck after a few attempts, naming the field",
    async () => {
      const { result } = await run("Notes", "Write a note about the similar setups.", 0.1);
      // (The page's first background poll may land inside the first type's window: at most one more.)
      expect(types(result).length).toBeLessThanOrEqual(5);
      expect(result.run.stop).toBe("no-progress");
      const reason = result.run.outcome.status === "incomplete" ? result.run.outcome.reason : "";
      expect(reason).toMatch(/typed into "Notes" \d times in a row: nothing changed but its own value/);
    },
    90_000,
  );
});
