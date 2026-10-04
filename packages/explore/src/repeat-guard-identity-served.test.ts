import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import { withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #356 — the repeat-side-effect guard keyed on a button's LABEL: screen A's "Continue" sent
 * `POST /api/a`, screen B's same-labelled "Continue" (another control, another request) was refused
 * as a repeat. An action is its route + element + context, named by the request it sent: the second
 * screen's click goes through, and a true repeat of the same button is still refused.
 */
const SPA_HTML = `<!doctype html><html><body>
<div class="s1"><h1>Step 1: check your nameservers</h1><button type="button" class="c1">Continue</button></div>
<div class="s2" hidden><h1>Step 2: confirm the share</h1><button type="button" class="c2">Continue</button><p id="done"></p></div>
<script>
  document.querySelector(".c1").addEventListener("click", async () => {
    await fetch("/api/a", { method: "POST", body: "{}" });
    document.querySelector(".s1").hidden = true;
    document.querySelector(".s2").hidden = false;
  });
  document.querySelector(".c2").addEventListener("click", async () => {
    await fetch("/api/b", { method: "POST", body: "{}" });
    document.getElementById("done").textContent = "Share confirmed";
  });
</script>
</body></html>`;

const page = (n: string, api: string, next: string | null): string => `<!doctype html><html><body>
<h1>Page ${n}</h1><button type="button" id="c">Continue</button><p id="done"></p>
<script>
  document.getElementById("c").addEventListener("click", async () => {
    await fetch("${api}", { method: "POST", body: "{}" });
    ${next === null ? `document.getElementById("done").textContent = "Done";` : `location.href = "${next}";`}
  });
</script>
</body></html>`;

const posts = { a: 0, b: 0 };
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/api/a" || req.url === "/api/b")) {
      posts[req.url === "/api/a" ? "a" : "b"] += 1;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const html = req.url === "/one" ? page("one", "/api/a", "/two") : req.url === "/two" ? page("two", "/api/b", null) : SPA_HTML;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Picks, per step, the first offered action whose id or description matches (repeating the last). */
class PickingJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly steps: readonly RegExp[]) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const q = args.questions.action;
    if (q === undefined) {
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "noul", value: false, probability: 0.1 };
      return out;
    }
    if (q.kind !== "choice") throw new Error("expected a choice");
    const pattern = this.steps[Math.min(this.#i, this.steps.length - 1)] as RegExp;
    this.#i += 1;
    const pick = q.options.find((o) => pattern.test(o) || pattern.test(q.descriptions?.[o] ?? ""));
    if (pick === undefined) throw new Error(`no option matches ${String(pattern)}: ${q.options.join(", ")}`);
    return { action: { kind: "choice", value: pick, confidence: 0.9 } };
  }
}

const runClicks = (startUrl: string) =>
  withSession(
    "repeat-identity-",
    async (session) => {
      const actor = CastActor.named("flow").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge: new PickingJudge([/Continue/, /Continue/, /Continue/, /^blocked$/]),
        gen: new FakeGenerationGateway(),
        goal: "continue through both steps",
        allowlist: [base],
        startUrl,
        bounds: { maxDecisions: 5 },
      });
    },
    base,
  );

describe("#356 — same-labelled controls that send different requests are different actions", () => {
  for (const [what, path] of [
    ["two screens of one route (an SPA)", "/flow"],
    ["two pages", "/one"],
  ] as const) {
    it(`${what}: the second "Continue" goes through; a true repeat is still refused`, async () => {
      posts.a = 0;
      posts.b = 0;
      const run = await runClicks(`${base}${path}`);
      const clicks = run.transcript.filter((e) => e.op === "click");
      expect(clicks[0]?.actOk).toBe(true);
      expect(clicks[1]?.actOk).toBe(true);
      expect(clicks[1]?.reason ?? "").not.toMatch(/repeated side effect/);
      expect(posts).toEqual({ a: 1, b: 1 });
      // The third click is the same button on the same screen: refused, named by ITS request.
      expect(clicks[2]?.actOk).toBe(false);
      expect(clicks[2]?.reason).toMatch(/repeated side effect refused/);
      expect(clicks[2]?.reason).toContain("POST /api/b");
    }, 90_000);
  }
});
