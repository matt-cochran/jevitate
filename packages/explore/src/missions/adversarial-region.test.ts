import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runAdversarialMission, type AdversarialMissionParams, type AdversarialOutcome } from "./adversarial.js";
import { withSession, useSkippingTime } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #519 — an in-place sub-flow (an "Import" wizard section) on a page full of other controls (a
 * 40-row list and a 10-button assistant panel). Scoped to the wizard, a thorough attack on it can
 * reach `clean` without lowering `--min-control-coverage`; unscoped, the same run stays thin.
 * `backFirst` puts the wizard's Back (which removes the wizard in place) first, so `exercise-controls`
 * — which acts in DOM order, the region's own controls first — leaves the region deterministically.
 */
const ITEMS = (backFirst: boolean): string => {
  const back = `<button type="button" id="back" onclick="document.querySelector('[data-testid=import-view]').remove()">Back</button>`;
  const rows = Array.from({ length: 40 }, (_, i) => `<li><button type="button" onclick="this.dataset.hit='1'">Row ${i + 1}</button></li>`).join("");
  const assistant = Array.from({ length: 10 }, (_, i) => `<button type="button">Ask ${i + 1}</button>`).join("");
  return `<!doctype html><html><body>
  <h1>Items</h1>
  <section data-testid="import-view" aria-label="Import">
    ${backFirst ? back : ""}
    <form id="import" onsubmit="event.preventDefault(); fetch('/api/import', { method: 'POST' }).then(() => { document.getElementById('st').textContent = 'Checked'; });">
      <label>Source <input name="source" aria-label="Source" /></label>
      <label>Delimiter <input name="delimiter" aria-label="Delimiter" /></label>
      <label>Encoding <input name="encoding" aria-label="Encoding" /></label>
      <label>Label <input name="label" aria-label="Label" /></label>
      <button type="submit" id="continue">Continue</button>
    </form>
    ${backFirst ? "" : back}
    <div id="st" role="status"></div>
  </section>
  <ul>${rows}</ul>
  <aside aria-label="Assistant">${assistant}</aside>
</body></html>`;
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app/items" || path === "/app/items-back") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ITEMS(path === "/app/items-back"));
      return;
    }
    if (path === "/api/import" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const REGION = { scopeRegions: [{ testId: "import-view" }], scopeRegionSpec: "testId=import-view" } as const;

async function hunt(path: string, extra: Partial<AdversarialMissionParams> = {}): Promise<AdversarialOutcome> {
  return withSession(
    "adv-region-",
    async (session) => {
      const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}${path}`,
        allowlist: [origin],
        strategies: ["exercise-controls"],
        bounds: { maxDecisions: 6 },
        ...extra,
      });
    },
    origin,
  );
}

describe("adversarial — hunt scoped to a declared region (#519)", () => {
  it("reaches clean on the region when it exercises at least 25% of it (#519 acceptance)", async () => {
    const r = await hunt("/app/items", REGION);
    expect({
      outcome: r.outcome,
      failure: r.failure,
      regionSpec: r.coverage.region?.spec,
      narrower: r.coverage.controls.total < (r.coverage.pageControls?.total ?? 0),
      ratio: r.coverage.controls.ratio >= 0.25,
    }).toEqual({ outcome: "clean", failure: undefined, regionSpec: "testId=import-view", narrower: true, ratio: true });
  }, 180_000);

  it("the same run without a region stays inconclusive (unchanged behaviour)", async () => {
    const r = await hunt("/app/items");
    expect({ outcome: r.outcome, failure: r.failure?.kind, region: r.scope.region }).toEqual({
      outcome: "inconclusive",
      failure: "insufficient-coverage",
      region: undefined,
    });
  }, 180_000);

  it("a region that never matches ends scope-unreachable without spending the budget", async () => {
    const r = await hunt("/app/items", { scopeRegions: [{ testId: "typo" }], scopeRegionSpec: "testId=typo" });
    expect({
      outcome: r.outcome,
      stop: r.stop,
      failure: r.failure?.kind,
      named: /scope region testId=typo/.test(r.failure?.message ?? ""),
      actionsOnTarget: r.coverage.actionsOnTarget,
    }).toEqual({ outcome: "inconclusive", stop: "scope-unreachable", failure: "target-unreachable", named: true, actionsOnTarget: 0 });
  }, 180_000);

  it("two consecutive region-less steps reset to the start and are counted", async () => {
    // The fixture's Back (first in the region) removes the region; the next step can only act outside it.
    const r = await hunt("/app/items-back", { ...REGION, bounds: { maxDecisions: 4 } });
    expect({
      lostResets: (r.scope.region?.lostResets ?? 0) >= 1,
      outOfScope: r.coverage.outOfScopeSteps >= 2,
      resetEntry: r.transcript.some((e) => e.strategy === "scope-reset" && /left the scope region/.test(e.reason ?? "")),
    }).toEqual({ lostResets: true, outOfScope: true, resetEntry: true });
  }, 180_000);
});
