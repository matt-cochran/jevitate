import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type GenerationResult, type GenInput, type GenTaskKind } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { HostHealthSampler } from "../host-health.js";
import { runGoalBasedMission } from "./goal-based.js";
import { PreferenceJudge, withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, reply waits, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #368 — a chat whose reply never arrives, run with an explicit reply wait on a HEALTHY host, ended
 * `inconclusive` with "starved: renders 30079ms vs the run's baseline 511ms (>=5x) — not an app
 * finding": the configured reply wait was booked as the send's render time, and a render slowdown
 * alone blamed the host. The reply wait is the run's own wait (never render time), and the run names
 * the missing reply — never environment starvation.
 */

const REPLY_WAIT_MS = 4_000;

const HTML = `<!doctype html><html><body>
<h1>Assistant</h1>
<div id="log"><p>Assistant: Ask me anything about your account.</p></div>
<input id="box" aria-label="Message" /><button id="send" type="button">Send</button>
<script>
  document.getElementById("send").addEventListener("click", () => {
    const box = document.getElementById("box");
    const you = document.createElement("p"); you.textContent = "You: " + box.value;
    document.getElementById("log").appendChild(you);
    fetch("/chat", { method: "POST", body: box.value }).catch(() => {});
    box.value = "";
  });
</script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    // The chat backend has no model: it accepts the message and never answers it.
    if (req.method === "POST" && req.url === "/chat") return void res.writeHead(204).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Distinct chat messages, in turn (the default fake would repeat one, which the loop refuses to resend). */
class TurnsGateway extends FakeGenerationGateway {
  #n = 0;
  constructor(private readonly turns: readonly string[]) {
    super();
  }
  override async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    if (kind !== "chat.reply") return super.generate(kind, input);
    const text = this.turns[Math.min(this.#n++, this.turns.length - 1)]!;
    return new FakeGenerationGateway({ [kind]: { text } }).generate(kind, input);
  }
}

/** The issue's host: 0.14 load per core, plenty of free memory — healthy. */
const healthyHost = (): HostHealthSampler =>
  new HostHealthSampler({
    probe: async () => ({ sample: { memAvailableBytes: 27 * 1024 ** 3, source: "test" }, overThreshold: null, loadPerCore: 0.14 }),
    eventLoopLagMs: () => 2,
    intervalMs: 0,
    attribute: true,
    cores: 8,
  });

describe("#368 — a reply that never arrives is the run's own finding, never a starved host", () => {
  it(
    "the reply wait is not render time, and the run names the missing reply instead of environment starvation",
    async () => {
      const hostHealth = healthyHost();
      // A few distinct messages (each waits out the full reply wait), then only waits.
      const messages = ["What is my balance?", "Can you show my last invoice?", "How do I change my plan?", "Who is my account manager?"];
      const judge = new PreferenceJudge((n) => (n < messages.length ? [{ op: "send", name: "Message" }] : [{ op: "wait" }]));
      const result = await withSession(
        "reply-never-",
        async (session) => {
          const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
          return runGoalBasedMission({
            actor,
            judge,
            gen: new TurnsGateway(messages),
            goal: "Ask the assistant for your account balance and read its answer.",
            allowlist: [origin],
            startUrl: `${origin}/chat`,
            waitOpMs: 500,
            replyWaitMs: REPLY_WAIT_MS,
            replyCeilingMs: REPLY_WAIT_MS,
            bounds: { maxDecisions: 12 },
            hostHealth,
          });
        },
        origin,
      );
      hostHealth.stop();

      const sends = result.transcript.filter((e) => e.op === "send" && e.actOk);
      expect(sends.length).toBeGreaterThanOrEqual(3);
      for (const s of sends) {
        // The send waited out the reply wait…
        expect(s.reply?.received).toBe(false);
        expect(s.reply?.waitedMs ?? 0).toBeGreaterThanOrEqual(REPLY_WAIT_MS / 2);
      }
      // …and the next perception's render excludes it (booked as `waitedMs`, not `settleMs`).
      const after = result.transcript.filter((e) => e.timing?.waitedMs !== undefined);
      expect(after.length).toBeGreaterThanOrEqual(3);
      for (const e of after) {
        expect(e.timing!.waitedMs!).toBeGreaterThanOrEqual(REPLY_WAIT_MS / 2);
        expect(e.timing!.settleMs ?? 0).toBeLessThan(REPLY_WAIT_MS);
      }
      const health = hostHealth.summary();
      expect(health.slowestRenderMs ?? 0).toBeLessThan(REPLY_WAIT_MS);
      expect(health).toMatchObject({ degradedSteps: 0, degraded: false, starvation: [] });

      // Never an environment verdict…
      expect(result.run.failure?.kind).not.toBe("degraded-environment");
      expect(result.reason ?? "").not.toMatch(/starved|not an app finding|degraded/);
      // …the run's own reason: the reply that never came.
      expect(result.outcome).not.toBe("succeeded");
      expect(result.reason).toMatch(/no reply within 4s/);
    },
    180_000,
  );
});
