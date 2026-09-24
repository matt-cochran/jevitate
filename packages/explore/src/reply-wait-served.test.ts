import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monitorFor } from "./page-monitor.js";
import { readPageText, waitForReply } from "./conversation.js";
import { withSession } from "./testkit.js";

/**
 * #93 — the reply wait observes until idle instead of a fixed wall clock. Timings are scaled 1:10
 * from the Preveti J2 evidence: the old fixed 60s default (here 6s) missed replies that take ~70s
 * (here ~7s: a 2.5s "thinking" request, then text streaming in for ~4.5s). The adaptive wait keeps
 * going while the send's request is in flight and the reply grows, up to the ceiling (180s → 18s),
 * and still stops early (idle patience) on a page that is doing nothing.
 */
const SCALE = 10;
const IDLE_MS = 60_000 / SCALE;
const CEILING_MS = 180_000 / SCALE;
const THINK_MS = 25_000 / SCALE;
const CHUNKS = 18;
const CHUNK_GAP_MS = 250;

const CHAT_HTML = `<!doctype html><html><body>
<h1>Assistant</h1>
<div id="log"><p>Assistant: What would you like to work on?</p></div>
<input id="box" aria-label="Message" /><button id="send" type="button">Send</button>
<script>
  document.getElementById("send").addEventListener("click", async () => {
    const text = document.getElementById("box").value;
    const you = document.createElement("p"); you.textContent = "You: " + text; document.getElementById("log").appendChild(you);
    const out = document.createElement("p"); out.textContent = "Assistant:"; document.getElementById("log").appendChild(out);
    const res = await fetch("/reply", { method: "POST", body: text });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.textContent += dec.decode(value);
    }
  });
</script>
</body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/reply") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        let i = 0;
        const t = setInterval(() => {
          i += 1;
          res.write(i === CHUNKS ? " END-OF-REPLY." : ` word${i}`);
          if (i === CHUNKS) {
            clearInterval(t);
            res.end();
          }
        }, CHUNK_GAP_MS);
      }, THINK_MS);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CHAT_HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("#93 — adaptive reply wait (observe until idle, hard ceiling)", () => {
  it("fully awaits a slow, streaming reply that outlasts the old fixed wait", async () => {
    await withSession(
      "reply-wait-stream-",
      async (session) => {
        const page = session.page;
        await monitorFor(page).instrument();
        await page.goto(base, { waitUntil: "domcontentloaded" });
        const baseline = await readPageText(page);
        const sent = "Customers cancel after a month";
        await page.fill("#box", sent);
        await page.click("#send");
        const r = await waitForReply(page, { baseline, sent, timeoutMs: IDLE_MS, ceilingMs: CEILING_MS });
        expect(r.received).toBe(true);
        expect(r.endedBy).toBe("reply");
        expect(r.text).toContain("END-OF-REPLY.");
        // It outlasted the old fixed wait (the reply only completes ~7s after the send)…
        expect(r.waitedMs).toBeGreaterThan(IDLE_MS);
        // …and stayed under the ceiling.
        expect(r.waitedMs).toBeLessThan(CEILING_MS);
      },
      base,
    );
  }, 90_000);

  it("stops early, with no reply, once the page shows no sign of working on one", async () => {
    await withSession(
      "reply-wait-idle-",
      async (session) => {
        const page = session.page;
        await monitorFor(page).instrument();
        await page.goto(base, { waitUntil: "domcontentloaded" });
        const baseline = await readPageText(page);
        // Nothing was sent: the page stays idle.
        const r = await waitForReply(page, { baseline, sent: "hello there", timeoutMs: 1_500, ceilingMs: CEILING_MS });
        expect(r.received).toBe(false);
        expect(r.endedBy).toBe("idle");
        expect(r.waitedMs).toBeLessThan(CEILING_MS / 2);
      },
      base,
    );
  }, 60_000);
});
