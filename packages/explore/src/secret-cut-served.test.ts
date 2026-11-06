import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { perceive } from "./perceive.js";
import { snapshot } from "./snapshot.js";
import { captureAria } from "./action-delta.js";
import { monitorFor } from "./page-monitor.js";
import { busyOverlay, maskPageReads, readBusyContainer, readBusyIndicator, readBusyText, readFormText, readInProgressStatus, readPageStatus, readWorkingStatus } from "./status.js";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { runGoalBasedMission } from "./missions/goal-based.js";
import type { VerifySession } from "./verify-fix.js";
import { ScriptedJudge, withSession, useSkippingTime } from "./testkit.js";

/** A secret across any bound leaves none of its characters: the mask comes before the cut, on every field the model reads. */
const SECRET = "Qx7StraddleSecretVal9";
const pad = (n: number): string => "w".repeat(n);
/** Every 4-character piece of the secret: a cut leaves one of these if it came first. */
const pieces = Array.from({ length: SECRET.length - 3 }, (_, i) => SECRET.slice(i, i + 4));
/** What a model reads. A descriptor is a control's identity for replay: it never goes in a prompt, and writers mask it. */
const readByModel = (v: unknown): string => JSON.stringify(v, (k, x: unknown) => (k === "descriptor" || k === "target" ? undefined : x));
const clean = (v: unknown): void => {
  const json = readByModel(v);
  for (const p of pieces) expect(json).not.toContain(p);
};

const PAGE = (): string => {
  // Each bound, with the secret starting a few characters before it, at several offsets.
  const offs = [3, 7, 11, 15];
  const rows = offs.flatMap((o) => [
    `<select aria-label="plan ${o}"><option value="a">${pad(200 - o)}${SECRET}</option></select>`,
    `<section aria-label="${pad(60 - o)}${SECRET}"><button>in region ${o}</button></section>`,
    `<h3>${pad(120 - o)}${SECRET}</h3><button>under heading ${o}</button>`,
    `<button>${pad(200 - o)}${SECRET}</button>`,
    `<div role="listbox"><div role="option">${pad(200 - o)}${SECRET}</div></div>`,
  ]);
  return `<!doctype html><title>t</title><h1>Cuts</h1>${rows.join("")}`;
};

/** A spinner that never clears, its label crossing the name's cut at 60. */
const heldSpinner = (o: number): string => `<main aria-label="${pad(60 - o)}${SECRET}"><div class="spinner" aria-busy="true" aria-label="${pad(60 - o)}${SECRET}" style="width:20px;height:20px">${pad(200 - o)}${SECRET}</div><button>Go</button></main>`;
const HELD = `<!doctype html><title>t</title>${heldSpinner(5)}`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((q, r) => r.writeHead(200, { "content-type": "text/html" }).end(q.url === "/held" ? HELD : PAGE()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("mask before cut", () => {
  useSkippingTime();
  it("a snapshot's options, region labels, headings and names", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.goto(`${origin}/`);
      const snap = await snapshot(session.page, { secrets: [SECRET], maxCandidates: 200 });
      clean(snap.controls);
      expect(readByModel(snap.controls)).toContain("«redacted»");
      // The cuts themselves still hold.
      for (const c of snap.controls) {
        expect((c.heading ?? "").length).toBeLessThanOrEqual(120);
        for (const o of c.options ?? []) expect(o.length).toBeLessThanOrEqual(200);
      }
    });
  });

  it("a perception", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.goto(`${origin}/`);
      clean(await perceive(session.page, { secrets: [SECRET], maxCandidates: 200 }));
    });
  });

  it("an announcement is read past its cut, so the reader's mask sees the whole value", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.addInitScript(() => {
        (window as unknown as { __jevitateDeltasOn?: boolean }).__jevitateDeltasOn = true;
      });
      const monitor = monitorFor(session.page);
      await session.page.goto(`${origin}/`);
      const since = Date.now();
      await session.page.evaluate((text) => {
        const el = document.createElement("div");
        el.setAttribute("role", "status");
        el.textContent = text;
        document.body.append(el);
      }, `${pad(195)}${SECRET}`);
      const notes = await monitor.transientsSince(since);
      if (notes.length > 0) expect(notes.some((n) => n.text.includes(SECRET))).toBe(true);
    });
  });

  it("status reads: alerts, in-progress lines, form text", async () => {
    await withSession("secret-cut", async (session) => {
      maskPageReads(session.page, [SECRET]);
      await session.page.setContent(
        [3, 7, 11, 15].flatMap((o) => [`<div role="alert">${pad(200 - o)}${SECRET}</div>`]).join("") +
          `<div role="status">Processing ${pad(80 - 11 - 5)}${SECRET}</div><form><button id="in">x</button><p>${pad(200 - 5)}${SECRET}</p></form>`,
      );
      const status = await readPageStatus(session.page);
      expect(status.alerts.length).toBeGreaterThan(0);
      clean(status);
      for (const a of status.alerts) expect(a.length).toBeLessThanOrEqual(201);
      const job = await readInProgressStatus(session.page);
      expect(job).not.toBeNull();
      clean(job);
      const form = await readFormText(session.page.locator("#in"));
      expect(form).not.toBeNull();
      clean(form);
    });
  });

  it.each([3, 7, 11, 15])("a held spinner's description, container and words, the secret %i characters before the cut", async (o) => {
    await withSession("secret-cut", async (session) => {
      maskPageReads(session.page, [SECRET]);
      await session.page.setContent(heldSpinner(o));
      const described = await readBusyIndicator(session.page);
      expect(described).toMatch(/^role=div "w+/);
      clean(described);
      // The cut is the one the page made: the same element keeps the same identity.
      expect(/"(.*)"/.exec(described ?? "")?.[1]?.length).toBeLessThanOrEqual(60);
      const container = await readBusyContainer(session.page);
      expect(container).toMatch(/^role=main "w+/);
      clean(container);
      expect(/"(.*)"/.exec(container ?? "")?.[1]?.length).toBeLessThanOrEqual(60);
      const words = await readBusyText(session.page);
      expect(words).toMatch(/^w+/);
      clean(words);
      expect(words?.length).toBeLessThanOrEqual(200);
      clean(await busyOverlay(session.page));
    });
  });

  it("without a secret, a long busy name is cut where it always was, unmarked", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.setContent(`<div class="spinner" aria-label="${pad(80)}" style="width:20px;height:20px"></div>`);
      expect(await readBusyIndicator(session.page)).toBe(`role=div "${pad(60)}"`);
    });
  });

  it("a test id or an id is whole, and masked", async () => {
    await withSession("secret-cut", async (session) => {
      maskPageReads(session.page, [SECRET]);
      await session.page.setContent(`<div class="spinner" data-testid="${pad(70)}-${SECRET}" style="width:20px;height:20px"></div>`);
      expect(await readBusyIndicator(session.page)).toBe(`[data-testid=${pad(70)}-«redacted»]`);
    });
  });

  it("the working status: a disabled progress control, a Cancel, each cut after its mask", async () => {
    await withSession("secret-cut", async (session) => {
      maskPageReads(session.page, [SECRET]);
      await session.page.setContent(`<button disabled>Saving ${pad(28)}${SECRET}</button><button>Cancel ${pad(28)}${SECRET}</button>`);
      const working = await readWorkingStatus(session.page);
      expect(working).toMatch(/^a disabled "Saving w+.*" control and an enabled "Cancel w+.*" control$/);
      clean(working);
    });
  });

  it("a spinner that never clears: the perception's hang holds none of it", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.goto(`${origin}/held`);
      const seen = await perceive(session.page, { secrets: [SECRET], renderWaitMs: 2_000, requestBoundMs: 1_000, hangProbeMs: 1_000 });
      expect(seen.hang?.kind).toBe("ui-no-progress");
      clean(seen.hang);
    });
  });

  it("a goal run on a held spinner: the hang and each fresh replay of it hold none of it", async () => {
    const port = new PlaywrightBrowserPort();
    const freshSession = async (): Promise<VerifySession> => {
      const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
      return { page: session.page, actor: CastActor.named("replay").whoCan(new BrowseTheWeb(session, [origin])), close: () => session.close() };
    };
    const result = await withSession(
      "secret-cut",
      async (session) =>
        runGoalBasedMission({
          actor: CastActor.named("goal").whoCan(new BrowseTheWeb(session, [origin])),
          judge: new ScriptedJudge([{ op: "done" }]),
          gen: new FakeGenerationGateway(),
          goal: "wait for the page",
          allowlist: [origin],
          startUrl: `${origin}/held`,
          successAssertion: { kind: "visible", target: { text: "Never shown" } },
          secrets: [SECRET],
          openFreshSession: freshSession,
          hangReplays: 1,
          renderWaitMs: 2_000,
          requestBoundMs: 1_000,
          hangProbeMs: 1_000,
          oracleTimeoutMs: 1_000,
          bounds: { maxDecisions: 3 },
        }),
      origin,
    );
    expect(result.hang?.signal.kind).toBe("ui-no-progress");
    expect(result.hang?.reproduction.ran).toBe(1);
    const all = JSON.stringify(result);
    for (const p of pieces) expect(all).not.toContain(p);
  }, 60_000);

  it("the action-delta capture's size cut falls between lines", async () => {
    await withSession("secret-cut", async (session) => {
      await session.page.setContent(`<main>${Array.from({ length: 9000 }, (_, i) => `<p>row ${i} ${pad(40)} ${SECRET}</p>`).join("")}</main>`);
      clean(await captureAria(session.page, { secrets: [SECRET], learned: new Set() }));
    });
  });
});
