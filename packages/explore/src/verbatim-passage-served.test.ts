import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore, type ExploreRun } from "./explore.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * #281 — a goal quoting the exact text to import ("… Click here to learn more about reminders …")
 * had it typed as a model's paraphrase ("Discover more about how reminders can assist …"), its
 * paragraph breaks lost. A passage the goal quotes is now typed by code, verbatim, line breaks and
 * all. Real Chromium; the generator would paraphrase if it were asked.
 */

let saved: string | null = null;

const PAGE = `<!doctype html><html><body><main><h1>New reminder</h1>
<form id="f"><label>Reminder text <textarea name="text" aria-label="Reminder text"></textarea></label>
<button type="submit">Save reminder</button></form><p role="status" id="s"></p></main>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/reminders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
  document.getElementById("s").textContent = r.ok ? "Saved" : "Failed";
});
</script></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/api/reminders" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        saved = (JSON.parse(raw) as { text: string }).text;
        res.writeHead(201, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    res.writeHead(path === "/reminders/new" ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(path === "/reminders/new" ? PAGE : "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  saved = null;
});

const PASSAGE =
  "Reminders keep your team on track.\n\nClick here to learn more about reminders and how they can help you never miss a renewal.\nQuestions? Reply to this message.";

async function run(goal: string): Promise<ExploreRun> {
  return withSession(
    "verbatim-passage-",
    async (session) => {
      const actor = CastActor.named("importer").whoCan(new BrowseTheWeb(session, [origin]));
      return explore({
        actor,
        // [0] Reminder text, [1] Save reminder.
        judge: new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]),
        // Asked, the generator paraphrases (the dogfood transcript's value).
        gen: new FakeGenerationGateway({ "form.value": { text: "Discover more about how reminders can assist you." } }),
        goal,
        allowlist: [origin],
        startUrl: `${origin}/reminders/new`,
        waitOpMs: 300,
        bounds: { maxDecisions: 4 },
      });
    },
    origin,
  );
}

describe("#281 — quoted goal text is typed verbatim", () => {
  it(
    "a multi-paragraph passage the goal quotes reaches the server exactly, its line breaks kept — never the paraphrase",
    async () => {
      const r = await run(`Create a reminder. Import this text exactly as written: "${PASSAGE}" and save it.`);
      expect(saved).toBe(PASSAGE);
      const typed = r.transcript.find((e) => e.op === "type");
      expect(typed?.actOk).toBe(true);
    },
    90_000,
  );

  it(
    "a long single-line passage over the free-text cap is typed whole (the cap is for generated essays only)",
    async () => {
      const long = `Click here to learn more about reminders ${"and why they matter ".repeat(40).trim()}.`;
      expect(long.length).toBeGreaterThan(600);
      await run(`Create a reminder with the text "${long}" and save it.`);
      expect(saved).toBe(long);
    },
    90_000,
  );
});
