import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { SuccessCheck } from "./success-checks.js";
import { describeCheck } from "./success-checks.js";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #335 / #327 — a visible text check on the issues' pages. `text=` matches an element's WHOLE text,
 * so `text=This demo has` never found `<h1>This demo has ended</h1>` and the check "did not hold"
 * although the page showed it. `textContains=` matches a substring; a failing exact `text=` now says
 * that some element contains the text and which form to use.
 */
const ENDED = `<!doctype html><html><head><title>Demo</title></head><body>
<h1>This demo has ended</h1><p>Contact your rep: Southshore</p>
</body></html>`;
const SETUP = `<!doctype html><html><head><title>Setup</title></head><body>
<h1>Acme is getting set up</h1><div style="height:2000px"></div><p>This is a read-only view of your site</p><a href="/setup">Refresh</a>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/setup" ? SETUP : ENDED));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const text = (key: "text" | "textContains", t: string): SuccessCheck => ({
  kind: "page",
  assertion: { kind: "textIncludes", target: key === "text" ? { text: t } : { text: t, textMatch: "contains" }, text: t },
});

async function run(path: string, successChecks: SuccessCheck[]) {
  return withSession(
    "text-check-",
    async (session) =>
      runGoalBasedMission({
        actor: CastActor.named("reader").whoCan(new BrowseTheWeb(session, [origin])),
        judge: new ScriptedJudge([{ op: "done" }]),
        gen: new FakeGenerationGateway({}),
        goal: "Open the link and read what it says",
        allowlist: [origin],
        startUrl: `${origin}${path}`,
        successChecks,
        successWhen: "held",
        allowVacuousChecks: true,
        oracleTimeoutMs: 500,
      }),
    origin,
  );
}

describe("visible text checks: textContains= matches part of an element's text (#335, #327)", () => {
  it("#327: a control-less goal page whose texts are shown succeeds (held, vacuous allowed)", async () => {
    const r = await run("/", [text("textContains", "This demo has"), text("textContains", "Contact your rep")]);
    expect(r.checks.map((c) => [c.check, c.passed])).toEqual([
      ["textIncludes:textContains=This demo has|This demo has", true],
      ["textIncludes:textContains=Contact your rep|Contact your rep", true],
    ]);
    expect(r.outcome).toBe("succeeded");
  }, 60_000);

  it("#335: below-the-fold text is matched too", async () => {
    const r = await run("/setup", [text("textContains", "is getting set up"), text("textContains", "This is a read-only view")]);
    expect(r.checks.every((c) => c.passed)).toBe(true);
    expect(r.outcome).toBe("succeeded");
  }, 60_000);

  it("an exact text= that only part of an element matches fails, and says to use textContains=", async () => {
    const r = await run("/", [text("text", "This demo has")]);
    expect(r.outcome).not.toBe("succeeded");
    expect(r.checks[0]?.detail).toMatch(/no element's whole text is exactly "This demo has".*1 element\(s\) contain it: use textContains=This demo has/);
    expect(describeCheck(text("text", "This demo has"))).toBe("textIncludes:text=This demo has|This demo has");
  }, 60_000);
});
