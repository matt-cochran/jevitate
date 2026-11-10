import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { GOAL_IS_SIGN_IN_QUESTION } from "./decide.js";
import { ScriptedJudge, withSession, useSkippingTime, type ScriptedStep } from "./testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * Independent re-check (signin-fail.mjs, variant home_error_banner): a WRONG password, and the app
 * redirects home, where the "Sign in" link has given way to an error banner. The #810 rule (a page that
 * offered Sign in before the credentials and offers none now) read that as a completed sign-in. A login
 * error on the page means it is not: the run never ends succeeded by sign-in-signals. Scripted judge,
 * fake generator: no model call. The page judgment says not met (0.3); the goal is only to sign in (0.95).
 */

const page = (t: string, b: string): string => `<!doctype html><html lang=en><head><title>${t}</title></head><body>${b}</body></html>`;
const signInPage = page(
  "Sign in",
  `<h1>Sign in</h1><form method=post action=/login><p><label>Email <input name=email type=email></label></p><p><label>Password <input name=password type=password></label></p><button type=submit>Sign in</button></form>`,
);

/** `banner`: how the home page shows the failure — a role=alert region, or plain text. */
function serve(banner: "alert" | "text"): Promise<{ server: Server; state: { signedIn: boolean; posts: number } }> {
  const state = { signedIn: false, posts: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const send = (s: number, h: string, headers: Record<string, string> = {}): void => void res.writeHead(s, { "content-type": "text/html", ...headers }).end(h);
      if (req.method === "POST" && u.pathname === "/login") {
        state.posts += 1;
        if (new URLSearchParams(body).get("password") === "lab-pass-1") state.signedIn = true;
        return send(303, "", { location: state.signedIn ? "/" : "/?error=invalid" });
      }
      if (u.pathname === "/login") return send(200, signInPage);
      if (u.pathname === "/") {
        if (state.signedIn) return send(200, page("Home", `<h1>Welcome back, Morgan</h1><p><a href="/invoices">Invoices</a></p>`));
        const msg = banner === "alert" ? `<p role=alert>Incorrect email or password.</p>` : `<p class=error>Incorrect email or password.</p>`;
        if (u.searchParams.get("error") !== null) return send(200, page("Home", `<h1>Pinecrest Books</h1>${msg}<p><a href="/help">Need help?</a></p>`));
        return send(200, page("Home", `<h1>Pinecrest Books</h1><p><a href="/login">Sign in</a></p>`));
      }
      send(404, page("Not found", "<h1>Not found</h1>"));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, state })));
}

const SIGN_IN_STEPS: ScriptedStep[] = [{ op: "click", target: "0" }, { op: "type", target: "0" }, { op: "type", target: "1" }, { op: "click", target: "2" }];

async function run(banner: "alert" | "text", tail: ScriptedStep[]) {
  const { server, state } = await serve(banner);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const judge = new ScriptedJudge([...SIGN_IN_STEPS, ...tail]);
  judge.goalMetProbability = 0.3;
  judge.noulProbabilities = { [GOAL_IS_SIGN_IN_QUESTION]: 0.95 };
  try {
    const result = await withSession(
      "sign-in-error-",
      (session) =>
        runGoalBasedMission({
          actor: CastActor.named("s").whoCan(new BrowseTheWeb(session, [url])),
          judge,
          gen: new FakeGenerationGateway(),
          goal: "Sign in with email morgan@pinecrest.example and password wrong-pass-9.",
          allowlist: [url],
          startUrl: `${url}/`,
          bounds: { maxDecisions: 10 },
        }),
      url,
    );
    return { result, state, judge };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("a wrong password on an app whose home page drops its Sign-in link for an error banner", () => {
  for (const banner of ["alert", "text"] as const)
    for (const tail of [[{ op: "wait" }, { op: "scroll_down" }, { op: "report" }], [{ op: "done" }]] as ScriptedStep[][])
      it(
        `${banner} banner, then ${tail.map((t) => t.op).join(",")}: never succeeded by sign-in-signals`,
        async () => {
          const { result, state, judge } = await run(banner, tail);
          expect(state.posts).toBe(1);
          expect(state.signedIn).toBe(false);
          // A `report` is grounded as an answer by the (scripted) judgment, a separate rule from this one; a `done` rests on sign-in alone.
          if (tail[0]?.op === "done") expect(result.outcome, JSON.stringify(result.run.outcome)).not.toBe("succeeded");
          expect(result.run.outcome).not.toMatchObject({ verifiedBy: "sign-in-signals" });
          const facts = judge.goalCalls.at(-1)?.state.controls.find((c) => c.startsWith("SIGN-IN (observed by code"));
          if (facts !== undefined) expect(facts).not.toMatch(/shows none now/);
        },
        90_000,
      );
});
