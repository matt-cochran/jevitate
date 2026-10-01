import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./goal-based.js";
import { ScriptedJudge, withSession } from "../testkit.js";
import { FillHelper, identityKind, uniqueIdentity } from "../fill.js";

/**
 * #271 — a sign-up goal's model-invented identity (`jane.doe@example.com`, every run) collides with
 * the account an earlier run created. A model-invented email / username is unique per run; a value
 * the goal states verbatim is typed as given.
 */
const accounts = new Set<string>();
const PAGE = `<!doctype html><html><body>
<label for="em">Email</label><input id="em" type="email">
<button type="button" id="go" onclick="fetch('/signup',{method:'POST',body:document.getElementById('em').value}).then(r=>r.text()).then(t=>{document.getElementById('out').textContent=t})">Sign up</button>
<p id="out"></p>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/signup") {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const email = body.trim().toLowerCase();
        const msg = accounts.has(email) ? "An account with this email already exists" : "Welcome aboard";
        accounts.add(email);
        res.writeHead(200, { "content-type": "text/plain" }).end(msg);
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("per-run unique identity for model-invented emails/usernames (#271)", () => {
  it("classifies identity fields and makes a value unique, deterministically within a run", () => {
    expect(identityKind("Email", { tag: "input", inputType: "text" })).toBe("email");
    expect(identityKind("Work address", { tag: "input", inputType: "email" })).toBe("email");
    expect(identityKind("Username", { tag: "input", inputType: "text" })).toBe("username");
    expect(identityKind("Password", { tag: "input", inputType: "password" })).toBeNull();
    expect(identityKind("Full name", { tag: "input", inputType: "text" })).toBeNull();
    expect(identityKind("Email", { tag: "textarea", inputType: null })).toBeNull();
    expect(uniqueIdentity("jane.doe@example.com", "email", "abc123")).toBe("jane.doe.jevabc123@example.com");
    expect(uniqueIdentity("jane.doe.jevabc123@example.com", "email", "abc123")).toBe("jane.doe.jevabc123@example.com");
    expect(uniqueIdentity("janedoe", "username", "abc123")).toBe("janedoe_jevabc123");
  });

  it("a model-invented email is unique to the run; a goal-stated one is typed verbatim", async () => {
    const gen = new FakeGenerationGateway({ "form.value": { text: "jane.doe@example.com" } });
    const a = new FillHelper(gen);
    const b = new FillHelper(gen);
    const field = { tag: "input", inputType: "email" } as const;
    const ra = await a.valueFor({ fieldLabel: "Email", goal: "Create an account", visibleContext: "", field });
    const ra2 = await a.valueFor({ fieldLabel: "Email", goal: "Create an account", visibleContext: "", field, history: ["x"] });
    const rb = await b.valueFor({ fieldLabel: "Email", goal: "Create an account", visibleContext: "", field });
    expect(ra.text).toMatch(/^jane\.doe\.jev[0-9a-z]{6}@example\.com$/);
    expect(ra2.text).toBe(ra.text); // same run → same identity (sign up, then sign in)
    expect(rb.text).not.toBe(ra.text); // another run → another identity
    const stated = await a.valueFor({ fieldLabel: "Email", goal: "Sign up with email: ada@example.com", visibleContext: "", field });
    expect(stated).toEqual({ text: "ada@example.com", source: "goal" });
  });

  it(
    "the same sign-up goal run twice against one served app creates two accounts — no 'already exists'",
    async () => {
      const runOnce = () =>
        withSession(
          "signup-identity-",
          async (session) => {
            const actor = CastActor.named("signup").whoCan(new BrowseTheWeb(session, [origin]));
            return runGoalBasedMission({
              actor,
              judge: new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]),
              gen: new FakeGenerationGateway({ "form.value": { text: "jane.doe@example.com" } }),
              goal: "Create a new account for yourself",
              allowlist: [origin],
              startUrl: `${origin}/`,
              successAssertion: { kind: "textIncludes", target: { css: "#out" }, text: "Welcome" },
              oracleTimeoutMs: 2_000,
            });
          },
          origin,
        );
      const first = await runOnce();
      const second = await runOnce();
      expect(first.outcome).toBe("succeeded");
      expect(second.outcome).toBe("succeeded");
      expect(accounts.size).toBe(2);
      expect(accounts.has("jane.doe@example.com")).toBe(false);
    },
    240_000,
  );
});
