import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission, type AdversarialOutcome } from "./adversarial.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import { snapshot } from "../snapshot.js";
import { useSkippingTime, withSession } from "../testkit.js";

/**
 * #397 — an adversarial mission anchored inside an open dialog ("Suspend service": a reason field,
 * Suspend service / Cancel) took 0 actions: the dialog is `role=dialog` but not `aria-modal`, so
 * the page's controls below the fold ("Archive customer", "Log contact", …) stayed in the inventory
 * — off-screen, nothing was probed over them — and every step on one was refused as `target
 * obscured by …` once it was scrolled under the dialog's fixed backdrop. The dialog's own controls
 * were never chosen, and the obscured ones inflated the coverage total.
 *
 * A control that no scroll can bring out from under a FIXED layer (a backdrop, a fixed dialog) is
 * covered wherever it sits, so it is not offered, and not counted.
 */

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px sans-serif; }
  #backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 10; }
  #suspend { position: fixed; top: 15vh; left: 25vw; width: 50vw; background: #fff; padding: 16px; z-index: 11; }
  #suspend label, #suspend input { display: block; width: 100%; }
</style></head><body>
  <h1>Acme Ltd</h1>
  <p>Customer profile.</p>
  <div style="height:1400px"></div>
  <a href="/customers">Customers</a>
  <button type="button" id="archive">Archive customer</button>
  <button type="button" id="log">Log contact</button>
  <div style="height:1400px"></div>
  <button type="button" id="notes">Add note</button>
  <div id="backdrop"></div>
  <div id="suspend" role="dialog" aria-labelledby="suspend-title">
    <h2 id="suspend-title">Suspend service</h2>
    <label for="reason">Reason for suspending</label>
    <input id="reason" type="text" />
    <button type="button" id="cancel">Cancel</button>
    <button type="button" id="confirm">Suspend service</button>
  </div>
  <p id="status" role="status"></p>
  <script>
    const status = document.getElementById("status");
    document.getElementById("cancel").addEventListener("click", () => { status.textContent = "Cancelled"; });
    document.getElementById("confirm").addEventListener("click", () => {
      status.textContent = "Suspended: " + document.getElementById("reason").value;
    });
    for (const id of ["archive", "log", "notes"]) document.getElementById(id).addEventListener("click", () => { status.textContent = id; });
  </script>
</body></html>`;

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/customer") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><h1>Customers</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const STRATEGIES: readonly MisuseStrategy[] = ["exercise-controls", "double-submit", "boundary-input", "act-while-pending"];
const DIALOG = ["Reason for suspending", "Cancel", "Suspend service"];
const PAGE_CONTROLS = ["Customers", "Archive customer", "Log contact", "Add note"];

describe("#397 — a dialog drawn over the page scopes what can be acted on", () => {
  useSkippingTime();

  it(
    "the snapshot offers the dialog's controls only: below-the-fold controls under the fixed backdrop are covered wherever they scroll",
    async () => {
      const names = await withSession(
        "adv-397-snap-",
        async (session) => {
          await session.page.goto(`${origin}/customer`, { waitUntil: "load" });
          return (await snapshot(session.page)).controls.map((c) => c.name);
        },
        origin,
      );
      for (const n of DIALOG) expect(names, n).toContain(n);
      for (const n of PAGE_CONTROLS) expect(names, n).not.toContain(n);
    },
    60_000,
  );

  it(
    "an adversarial mission on the open dialog acts on the dialog, never on the obscured page behind it",
    async () => {
      const result: AdversarialOutcome = await withSession(
        "adv-397-",
        async (session) => {
          const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
          return runAdversarialMission({
            page: session.page,
            actor,
            judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
            generation: new FakeGenerationGateway(),
            seedUrl: `${origin}/customer`,
            allowlist: [origin],
            strategies: STRATEGIES,
            bounds: { maxActions: 12 },
            safety: { allowDestructive: true },
          });
        },
        origin,
      );
      const t = result.transcript;
      expect(t.filter((e) => /target obscured by/.test(e.reason ?? ""))).toEqual([]);
      const acted = t.filter((e) => e.op !== null && e.actOk);
      expect(acted.length).toBeGreaterThan(0);
      for (const e of acted) expect(PAGE_CONTROLS.some((n) => (e.target ?? "").includes(`"${n}"`)), e.target ?? "").toBe(false);
      // The obscured page controls never count toward the target total.
      expect(result.coverage.controls.total).toBeLessThanOrEqual(DIALOG.length);
      expect(result.coverage.controls.exercised).toBeGreaterThan(0);
    },
    180_000,
  );
});
