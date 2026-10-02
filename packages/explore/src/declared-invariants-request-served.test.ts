import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { validateInvariantSpec, type InvariantSpec } from "@jevitate/recording";
import { runGoalBasedMission, type GoalBasedResult } from "./missions/goal-based.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #295 on a served page (real Chromium): "what was saved is what reloads". A list editor PUTs
 * `/api/items` with `{"items": [...], "password": ...}` and the server answers only `{"ok": true}`;
 * the page then shows what `GET /api/items` returns. In the broken mode the server stores the list
 * REORDERED — the save "succeeds", the reload silently comes back in another order.
 *
 * The invariant reads the request PAYLOAD (`network.request`) and the reload's response
 * (`network.json`), both `[*]` lists, and compares them in order (`sameList`) right after a reload
 * (`when.op: ["reload"]` — before it, the DOM and the last GET legitimately differ from the edit).
 * A credential in the payload is never readable.
 */

let reorders = false;
let stored: string[] = ["alpha", "beta", "gamma"];
let app: Server;
let origin: string;

const pageHtml = `<!doctype html><html><body>
<h1>Mechanisms</h1>
<ol id="list"></ol>
<button type="button" id="up">Move gamma to the top</button>
<button type="button" id="save">Save order</button>
<p id="state"></p>
<script>
  let items = [];
  const render = () => {
    document.getElementById("list").innerHTML = items.map((i) => "<li>" + i + "</li>").join("");
  };
  fetch("/api/items").then((r) => r.json()).then((b) => { items = b.items; render(); });
  document.getElementById("up").addEventListener("click", () => {
    items = ["gamma", ...items.filter((i) => i !== "gamma")];
    render();
  });
  document.getElementById("save").addEventListener("click", async () => {
    const r = await fetch("/api/items", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items, password: "hunter2-secret" }),
    });
    document.getElementById("state").textContent = r.ok ? "Saved" : "Save failed";
  });
</script>
</body></html>`;

beforeAll(async () => {
  app = createServer((req, res) => {
    if (req.url === "/api/items" && req.method === "PUT") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const body = JSON.parse(raw) as { items: string[] };
        // The bug: the server persists the list sorted, not in the order the user saved.
        stored = reorders ? [...body.items].sort() : body.items;
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    if (req.url === "/api/items") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: stored }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve) => app.close(() => resolve()));
});
beforeEach(() => {
  stored = ["alpha", "beta", "gamma"];
});

const ORDER_SPEC = {
  observe: {
    savedOrder: { network: { url: "/api/items", method: "PUT", request: "$.items[*]" } },
    reloadedOrder: { network: { url: "/api/items", method: "GET", json: "$.items[*]" } },
  },
  invariants: [{ id: "saved-order-reloads", when: { op: ["reload"] }, require: "sameList(savedOrder, reloadedOrder)" }],
};

/** A rule that always breaks once the save went out, so its detail shows what `$.password` read as. */
const PASSWORD_SPEC = {
  observe: { sentPassword: { network: { url: "/api/items", method: "PUT", request: "$.password" } } },
  invariants: [{ id: "show-password", when: { op: ["reload"] }, require: "sentPassword == null" }],
};

const spec = (raw: unknown): InvariantSpec => validateInvariantSpec(raw, { allowlist: [origin], baseUrl: `${origin}/editor` });

async function run(raw: unknown = ORDER_SPEC): Promise<GoalBasedResult> {
  return withSession(
    "invariant-request-",
    async (session) => {
      const actor = CastActor.named("editor").whoCan(new BrowseTheWeb(session, [origin]));
      return runGoalBasedMission({
        actor,
        // Controls: [0] Move gamma to the top, [1] Save order.
        judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "click", target: "1" }, { op: "reload" }, { op: "done" }]),
        gen: new FakeGenerationGateway(),
        goal: "Move gamma to the top and save the new order.",
        allowlist: [origin],
        startUrl: `${origin}/editor`,
        successChecks: [{ kind: "requestMade", method: "PUT", pathGlob: "/api/items" }],
        waitOpMs: 300,
        bounds: { maxDecisions: 8 },
        invariants: spec(raw),
      });
    },
    origin,
  );
}

describe("invariants over the request payload: what was saved is what reloads (#295)", () => {
  it(
    "a save whose reload comes back reordered is a defect; the same run against a correct server holds",
    async () => {
      reorders = true;
      const broken = await run();
      expect(broken.outcome).toBe("defects-found");
      const d = broken.invariantDefects?.find((v) => v.invariant.id === "saved-order-reloads");
      expect(d).toBeDefined();
      // The detail shows both lists, in order — the reorder is visible.
      expect(d?.invariant.reason).toContain('["gamma", "alpha", "beta"]');
      expect(d?.invariant.reason).toContain('["alpha", "beta", "gamma"]');

      reorders = false;
      const ok = await run();
      expect(ok.outcome).toBe("succeeded");
      expect(ok.invariantDefects).toEqual([]);
      const report = ok.invariants?.find((r) => r.id === "saved-order-reloads");
      // Gated on the reload: checked exactly once, and it held.
      expect(report).toMatchObject({ checked: 1, held: 1, violated: 0 });
    },
    120_000,
  );

  it(
    "a credential in the request payload is never read: it reads as the scrubbed marker, never its value",
    async () => {
      reorders = false;
      const r = await run(PASSWORD_SPEC);
      const d = r.invariantDefects?.find((v) => v.invariant.id === "show-password");
      expect(d?.invariant.values).toMatchObject({ sentPassword: { after: "[redacted]" } });
      expect(JSON.stringify(r)).not.toContain("hunter2");
    },
    120_000,
  );
});
