import { createServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { validateInvariantSpec } from "@jevitate/recording";
import { runAdversarialMission } from "./adversarial.js";
import { withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits; a request the server holds blocks skipping only until it
// is "held" (testkit `heldMs`), so the 5 s settle ceiling passes in about that much real time.
useSkippingTime({ per: "all" });

/**
 * #406 — a save slower than the settle ceiling. The server holds every save open (it never answers
 * while the step settles). The page still shows the previous save's "Saved", so read at the ceiling,
 * "saved-means-stored" compares that stale "Saved" with a name the server never stored: a violation
 * no replay reproduces. The write the step started has not ended, so its invariant is `inconclusive`
 * and names that write — never a violation, never a pass.
 */

const FORM = `<!doctype html><html><body><h1>Profile settings</h1>
  <form id="profile">
    <label>Display name <input name="displayName" aria-label="Display name" value="Ada Lovelace"></label>
    <button type="submit">Save</button>
  </form>
  <p role="status" data-testid="status" data-state="saved">Saved</p>
  <script>
    document.getElementById("profile").addEventListener("submit", async (e) => {
      e.preventDefault();
      const res = await fetch("/api/slow-profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      const status = document.querySelector("[data-testid=status]");
      status.textContent = res.ok ? "Saved" : "Please check the form.";
      status.dataset.state = res.ok ? "saved" : "invalid";
    });
  </script>
</body></html>`;

const held: ServerResponse[] = [];
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/profile") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FORM);
      return;
    }
    if (path === "/api/slow-profile" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ displayName: "Ada Lovelace" }));
      return;
    }
    if (path === "/api/slow-profile" && req.method === "PUT") {
      req.resume();
      held.push(res); // answered only when the suite ends
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const r of held) r.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("adversarial: a save slower than the settle ceiling is inconclusive (#406)", () => {
  it(
    "the step's invariant is not judged while its write is in flight, and the write is named",
    async () => {
      const spec = validateInvariantSpec(
        {
          observe: {
            saidSaved: { dom: { selector: "[data-testid=status][data-state=saved]", read: "count" } },
            typedName: { dom: { selector: "input[name=displayName]", read: "value" } },
            storedName: { probe: { get: "/api/slow-profile", json: "$.displayName" } },
          },
          invariants: [{ id: "saved-means-stored", when: { control: { name: "Save" }, op: ["click"] }, require: "saidSaved >= 1 -> storedName == typedName" }],
        },
        { allowlist: [origin], baseUrl: `${origin}/profile` },
      );
      const r = await withSession(
        "adv-ceiling-",
        async (session) =>
          runAdversarialMission({
            page: session.page,
            actor: CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin])),
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
            generation: new FakeGenerationGateway(),
            seedUrl: `${origin}/profile`,
            allowlist: [origin],
            bounds: { maxDecisions: 3 },
            strategies: ["boundary-submit"],
            invariants: spec,
          }),
        origin,
      );
      const inv = r.invariants?.find((i) => i.id === "saved-means-stored");
      // Never a violation judged at the ceiling...
      expect(r.defects.filter((d) => d.kind === "invariant")).toEqual([]);
      expect(inv?.violated).toBe(0);
      // ...and never a pass: it applied, was not decided, and says which write it waited on.
      expect(inv?.checked).toBeGreaterThan(0);
      expect(inv?.held).toBe(0);
      expect(inv?.inconclusive).toMatch(/PUT \/api\/slow-profile/);
      const save = r.transcript.find((e) => e.op === "click" && /inconclusive/.test(e.reason ?? ""));
      expect(save?.reason).toMatch(/saved-means-stored.*PUT \/api\/slow-profile/);
    },
    180_000,
  );
});
