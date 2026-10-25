import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshot } from "../index.js";
import { collectActionableControlEvidence } from "../goal-loop/handle-blocked.js";
import type { ActionableControlEvidence } from "../goal-loop/context/types.js";
import { useSkippingTime, withSession } from "../testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #688 — the actionable-control recovery evidence contract. A served fixture carries one control of
 * each class the recovery must tell apart: a visible enabled safe control, and hidden, disabled,
 * ambiguous, destructive, financial and approval controls. `collectActionableControlEvidence`
 * OBSERVES the page only — it never selects, clicks or otherwise executes a candidate. Each piece of
 * evidence carries a durable locator, a screenshot, the safety predicate, and the exact resume
 * identity (page URL + page-state signature + the control's locator).
 */

const FIXTURE_HTML = `<!doctype html><html><body>
<main>
  <h1>Recovery fixture</h1>
  <button data-testid="safe" id="safe">Save draft</button>
  <button data-testid="hidden" id="hidden" style="display:none">Hidden action</button>
  <button data-testid="disabled" id="disabled" disabled>Disabled action</button>
  <button data-testid="ambiguous-a" id="amb-a">Duplicate action</button>
  <button data-testid="ambiguous-b" id="amb-b">Duplicate action</button>
  <button data-testid="destructive" id="destructive">Delete account</button>
  <button data-testid="financial" id="financial">Buy plan</button>
  <button data-testid="approval" id="approval">Approve request</button>
</main>
</body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let evidence: readonly ActionableControlEvidence[] = [];
let pageState = "";

beforeAll(async () => {
  await withSession(
    "actionable-recovery-",
    async (session) => {
      await session.page.goto(`${origin}/fixture`, { waitUntil: "domcontentloaded" });
      pageState = (await snapshot(session.page)).signature;
      evidence = await collectActionableControlEvidence(session.page);
    },
    origin,
  );
});

function evidenceFor(testId: string): ActionableControlEvidence {
  const found = evidence.find((e) => e.locator === `[data-testid="${testId}"]`);
  if (found === undefined) throw new Error(`no recovery evidence for ${testId}`);
  return found;
}

const kindOf = (testId: string): string => evidenceFor(testId).kind;

describe("#688 — the served fixture tells the control classes apart", () => {
  it("classifies a visible enabled safe control as safe", () => {
    expect(kindOf("safe")).toBe("safe");
  });

  it("classifies a hidden control as hidden", () => {
    expect(kindOf("hidden")).toBe("hidden");
  });

  it("classifies a disabled control as disabled", () => {
    expect(kindOf("disabled")).toBe("disabled");
  });

  it("classifies a control whose name another control shares as ambiguous", () => {
    expect(kindOf("ambiguous-a")).toBe("ambiguous");
  });

  it("classifies a destructive control as destructive", () => {
    expect(kindOf("destructive")).toBe("destructive");
  });

  it("classifies a control that costs money as financial", () => {
    expect(kindOf("financial")).toBe("financial");
  });

  it("classifies a control that grants approval as approval", () => {
    expect(kindOf("approval")).toBe("approval");
  });
});

describe("#688 — every safe outcome carries its recovery evidence", () => {
  it("carries a durable locator for the safe control", () => {
    expect(evidenceFor("safe").locator).toBe('[data-testid="safe"]');
  });

  it("carries a screenshot for the safe control", () => {
    expect(evidenceFor("safe").screenshot).toMatch(/^data:image\/png;base64,/);
  });

  it("carries a non-empty safety predicate for the safe control", () => {
    expect(evidenceFor("safe").predicate.length).toBeGreaterThan(0);
  });

  it("carries the exact resume identity for the safe control", () => {
    expect(evidenceFor("safe").resume).toEqual({
      url: `${origin}/fixture`,
      state: pageState,
      locator: '[data-testid="safe"]',
    });
  });
});
