import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { sendCandidates, sendable } from "./actions.js";
import { explore } from "./explore.js";
import { snapshot, type Control } from "./snapshot.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #370: an answer editor's `<textarea aria-label="Chat answer">` (Save / Publish buttons, no
 * message list) was classified a chat composer because its name contains "chat" — the run used
 * `send` (Enter) with conversational prose and never pressed the form's own Publish. A composer
 * needs conversational evidence (a transcript, or a Send control paired with the field).
 */

const html = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

/** The issue's minimal repro: a form field labelled "Chat answer" and its form's Publish button. */
const EDITOR = html(`<h1>Edit answer</h1>
<form id="f"><label>Chat answer <textarea name="answer"></textarea></label><button>Publish draft</button></form>
<p id="st"></p>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  await fetch("/api/PublishDraft", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
  document.getElementById("st").textContent = "Draft published";
});
</script>`);

async function fieldOn(body: string, name: string): Promise<{ field: Control; controls: readonly Control[] }> {
  return withSession("explore-composer-evidence-", async (session) => {
    await session.page.setContent(html(body));
    const snap = await snapshot(session.page);
    const field = snap.controls.find((c) => c.name === name);
    if (field === undefined) throw new Error(`no control named ${name}: ${snap.controls.map((c) => c.name).join(", ")}`);
    return { field, controls: snap.controls };
  });
}

describe("#370 — a chat composer needs conversational evidence, not the word 'chat'", () => {
  it("an editor textarea labelled 'Chat answer' with Save / Publish / Update and no transcript is a form field", async () => {
    const { field, controls } = await fieldOn(
      `<h1>Answer editor</h1><form><label>Chat answer <textarea></textarea></label>
       <button type="button">Save</button><button>Publish draft</button><button type="button">Update</button></form>`,
      "Chat answer",
    );
    expect(field.conversational).toBe(false);
    expect(sendable(field)).toBe(false);
    expect(sendCandidates(controls)).toEqual([]);
  });

  it("a real chat (role=log transcript + input + Send) is a composer", async () => {
    const { field } = await fieldOn(
      `<div role="log"><p>Assistant: Hi, how can I help?</p></div>
       <div><input aria-label="Chat with us" /><button type="button">Send</button></div>`,
      "Chat with us",
    );
    expect(field.conversational).toBe(true);
    expect(sendable(field)).toBe(true);
  });

  it("an input labelled 'Message' under a transcript of message bubbles is a composer (no Send button needed)", async () => {
    const { field } = await fieldOn(
      `<ul class="thread"><li class="message">Hi</li><li class="message">Hello — what do you need?</li></ul>
       <input aria-label="Message" />`,
      "Message",
    );
    expect(field.conversational).toBe(true);
    expect(sendable(field)).toBe(true);
  });

  it("a 'Type a reply' box paired with its Send button (no transcript yet) is a composer", async () => {
    const { field } = await fieldOn(`<div><textarea aria-label="Type a reply"></textarea><button>Send</button></div>`, "Type a reply");
    expect(field.conversational).toBe(true);
  });
});

let server: Server;
let base: string;
let published: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/api/PublishDraft" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        published.push(raw);
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(EDITOR);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  published = [];
});

describe("#370 — goal run on the issue's minimal repro", () => {
  it("offers `type` (not `send`) for the 'Chat answer' field and presses the form's 'Publish draft'", async () => {
    const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]);
    await withSession(
      "explore-composer-evidence-run-",
      async (session) => {
        const actor = CastActor.named("editor").whoCan(new BrowseTheWeb(session, [base]));
        return explore({
          actor,
          judge,
          gen: new FakeGenerationGateway(),
          goal: "Write the approved answer about refunds and publish the draft",
          allowlist: [base],
          startUrl: `${base}/editor`,
          bounds: { maxDecisions: 6 },
        });
      },
      base,
    );
    const first = judge.actionOptions[0] ?? [];
    expect(first).toContain("type:0");
    expect(first).not.toContain("send:0");
    expect(judge.actionOptions.flat().some((o) => o.startsWith("send:"))).toBe(false);
    expect(first).toContain("click:1");
    // The form's own Publish was pressed: the publish request was observed, carrying the typed answer.
    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0] as string).answer).not.toBe("");
  });
});
