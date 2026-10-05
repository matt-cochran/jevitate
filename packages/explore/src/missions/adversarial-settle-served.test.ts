import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { validateInvariantSpec } from "@jevitate/recording";
import { runAdversarialMission } from "./adversarial.js";
import { withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * A settled misuse step is judged on the page AFTER the save it sent came back, never mid-flight.
 * The profile form still shows the last save's "Saved" while a new save is pending; the server
 * rejects every save (400) and the page then says "Please check the form". Judged before the
 * response, "saved-means-stored" would read the stale "Saved" against the newly typed name and
 * report a violation that no replay reproduces (and that takes the slot of a real one).
 */

let stored = "Ada Lovelace";
const FORM = (): string => `<!doctype html><html><body><h1>Profile settings</h1>
  <form id="profile">
    <label>Display name <input name="displayName" aria-label="Display name" value="${stored}"></label>
    <button type="submit">Save</button>
  </form>
  <p role="status" data-testid="status" data-state="saved">Saved</p>
  <script>
    document.getElementById("profile").addEventListener("submit", async (e) => {
      e.preventDefault();
      const res = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      const status = document.querySelector("[data-testid=status]");
      status.textContent = res.ok ? "Saved" : "Please check the form.";
      status.dataset.state = res.ok ? "saved" : "invalid";
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/profile") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FORM());
      return;
    }
    if (path === "/api/profile" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ displayName: stored }));
      return;
    }
    if (path === "/api/profile" && req.method === "PUT") {
      req.resume();
      req.on("end", () => res.writeHead(400, { "content-type": "application/json" }).end('{"ok":false}'));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("adversarial: a settled step's invariants are judged after its request came back", () => {
  it(
    "a rejected save is not read as the previous save's stale \"Saved\"",
    async () => {
      const spec = validateInvariantSpec(
        {
          observe: {
            saidSaved: { dom: { selector: "[data-testid=status][data-state=saved]", read: "count" } },
            typedName: { dom: { selector: "input[name=displayName]", read: "value" } },
            storedName: { probe: { get: "/api/profile", json: "$.displayName" } },
          },
          invariants: [{ id: "saved-means-stored", when: { control: { name: "Save" }, op: ["click"] }, require: "saidSaved >= 1 -> storedName == typedName" }],
        },
        { allowlist: [origin], baseUrl: `${origin}/profile` },
      );
      const r = await withSession(
        "adv-settle-",
        async (session) =>
          runAdversarialMission({
            page: session.page,
            actor: CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin])),
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
            generation: new FakeGenerationGateway(),
            seedUrl: `${origin}/profile`,
            allowlist: [origin],
            bounds: { maxDecisions: 6 },
            strategies: ["boundary-submit"],
            invariants: spec,
          }),
        origin,
      );
      const inv = r.invariants?.find((i) => i.id === "saved-means-stored");
      // The check ran on the Save clicks, and every one held: no invariant defect.
      expect(inv?.checked).toBeGreaterThan(0);
      expect(r.defects.filter((d) => d.kind === "invariant")).toEqual([]);
      expect(inv?.violated).toBe(0);
    },
    180_000,
  );
});
