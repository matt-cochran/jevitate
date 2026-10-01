import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type GenerationPort } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession } from "./testkit.js";
import { parseTypeFixtureSpec, TypeFixtureSpecError, type TypeFixture } from "./type-fixtures.js";

/**
 * #281 — `--type-fixture`: a field bound to a file's exact text is typed VERBATIM by code (paragraph
 * breaks kept, no generated-text cap, no value generator call), the model only sees the placeholder,
 * and the Recording keeps the text — redacted only when it holds a registered run secret.
 */
const PAGE = `<!doctype html><html><body>
<label for="t">Paste your text</label>
<textarea id="t"></textarea>
<button type="button" id="imp" onclick="const v=document.getElementById('t').value;document.getElementById('out').textContent=v.split(/\\n\\s*\\n/).length+' paragraphs, '+v.length+' chars'">Import</button>
<p id="out"></p>
</body></html>`;

// Three paragraphs, longer than the generated-text cap would allow on one field.
const TEXT = [
  "Click here to learn more about reminders and how they keep your week on track.",
  "Reminders arrive by email the morning before.\nReply STOP to opt out.",
  `${"Every account gets ten free reminders a month. ".repeat(40).trim()}`,
].join("\n\n");

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(fixture: TypeFixture, secrets: string[] = []) {
  const generated: string[] = [];
  const fake = new FakeGenerationGateway({ "form.value": { text: "Discover more about how reminders can assist you." } });
  const gen: GenerationPort = {
    generate: async (kind, input) => {
      generated.push(kind);
      return fake.generate(kind, input);
    },
  };
  const judge = new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]);
  const out = await withSession(
    "type-fixture-",
    async (session) => {
      const result = await runGoalBasedMission({
        actor: CastActor.named("fixture").whoCan(new BrowseTheWeb(session, [origin])),
        judge,
        gen,
        goal: "Import this text and analyze it",
        allowlist: [origin],
        startUrl: `${origin}/`,
        typeFixtures: [fixture],
        ...(secrets.length === 0 ? {} : { secrets }),
        successAssertion: { kind: "textIncludes", target: { css: "#out" }, text: "3 paragraphs" },
        oracleTimeoutMs: 2_000,
      });
      return { result, typed: await session.page.locator("#t").inputValue() };
    },
    origin,
  );
  return { ...out, judge, generated };
}

const bind = (text: string): TypeFixture => {
  const spec = parseTypeFixtureSpec("label=Paste your text=./fixtures/newsletter.txt");
  return { descriptor: spec.descriptor, matcher: spec.matcher, name: "newsletter.txt", text };
};

describe("--type-fixture (#281)", () => {
  it(
    "types the file's exact text — paragraphs kept, never capped, never generated — and records it for replay",
    async () => {
      const { result, typed, judge, generated } = await run(bind(TEXT));
      expect(typed).toBe(TEXT);
      expect(result.outcome).toBe("succeeded");
      expect(generated).not.toContain("form.value");
      const fills = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
      expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toEqual([{ redacted: false, value: TEXT }]);
      // The model chose `type` seeing the placeholder, never the contents (the page shows them once typed).
      const shown = JSON.stringify(judge.calls[0]);
      expect(shown).toContain("«fixture:newsletter.txt»");
      expect(shown).not.toContain("Reply STOP to opt out");
    },
    90_000,
  );

  it(
    "a fixture holding a registered secret is typed, but its Recording fill is redacted",
    async () => {
      const secret = "sk-live-4242-secret-token";
      const text = `Your API token is ${secret}.\n\nKeep it safe.\n\nDone.`;
      const { result, typed } = await run(bind(text), [secret]);
      expect(typed).toBe(text);
      const fills = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step)).filter((s) => s.kind === "fill");
      expect(fills.map((s) => (s.kind === "fill" ? s.value : null))).toEqual([{ redacted: true, length: text.length }]);
      expect(JSON.stringify(result.transcript)).not.toContain(secret);
    },
    90_000,
  );

  it("parses '<key>=<value>=<file>' and refuses a malformed spec", () => {
    expect(parseTypeFixtureSpec("testId=body=fixtures/b.txt")).toEqual({ descriptor: "testId=body", matcher: { key: "testId", value: "body" }, path: "fixtures/b.txt" });
    expect(parseTypeFixtureSpec("label=Message=fixtures/m.txt").path).toBe("fixtures/m.txt");
    expect(() => parseTypeFixtureSpec("Message=fixtures/m.txt")).toThrow(TypeFixtureSpecError);
    expect(() => parseTypeFixtureSpec("label=Message")).toThrow(TypeFixtureSpecError);
    expect(() => parseTypeFixtureSpec("label==m.txt")).toThrow(TypeFixtureSpecError);
  });
});
