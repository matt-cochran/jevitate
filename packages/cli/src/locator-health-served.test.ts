import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Recording, TargetDescriptor } from "@jevitate/recording";
import { RecordingInterpreter, type InterpretResult } from "@jevitate/interpreter";
import { computeDescriptor } from "@jevitate/recorder";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { useSkippingTime, withSession } from "../../explore/src/testkit.js";
import { analyzeRecording, type LocatorHealthDetail } from "./locator-health.js";
import { DEFAULT_TEST_ID_ATTRIBUTES } from "./project-config.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #470 acceptance: a served page with one button that has a data-testid, one with only a role and a
 * name, and one reachable only by css. Each is recorded by the recorder's real ladder and replayed by
 * the interpreter; locator health over the replay names each step's rung and level, sums them, and
 * suggests a fix naming the css-only element.
 */

const HTML = `<!doctype html><html><head><title>New contact</title></head><body><main>
  <h1>New contact</h1>
  <section>
    <button type="button" data-testid="save-contact">Save</button>
    <button type="button">Publish</button>
    <div class="icon" style="width: 24px; height: 24px" onclick="this.dataset.clicked = '1'"></div>
  </section>
</main></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const heading = { kind: "visible" as const, target: { role: "heading", name: "New contact" } };

let health: LocatorHealthDetail;
let replay: InterpretResult;

beforeAll(async () => {
  await withSession(
    "jev-locator-health-",
    async (session) => {
      const page = session.page;
      await page.goto(`${origin}/contacts/new`);
      const targets: TargetDescriptor[] = [];
      for (const selector of ["[data-testid=save-contact]", "button:not([data-testid])", "div.icon"]) {
        const handle = await page.$(selector);
        if (handle === null) throw new Error(`fixture lacks ${selector}`);
        targets.push((await computeDescriptor(page, handle)).descriptor);
      }
      const recording: Recording = {
        version: "1",
        site: origin,
        pages: [
          {
            url: "/contacts/new",
            steps: [
              { stepId: "s-open", step: { kind: "navigate", url: "/contacts/new", expect: heading } },
              ...targets.map((target, i) => ({ stepId: `s-click-${i}`, step: { kind: "click" as const, target, expect: heading } })),
            ],
          },
        ],
      };
      const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [origin]));
      replay = await new RecordingInterpreter().run(actor, recording, {});
      health = analyzeRecording(recording, { testIdAttributes: DEFAULT_TEST_ID_ATTRIBUTES, journeyId: "new-contact", ...(replay.resolved === undefined ? {} : { resolved: replay.resolved }) });
    },
    origin,
  );
}, 120_000);

describe("locator health of a recorded and replayed Journey", () => {
  it("the replay completes", () => {
    expect(replay.outcome, JSON.stringify(replay)).toBe("completed");
  });

  it("every step reports the rung the replay resolved it by", () => {
    expect(health.steps.map((s) => [s.source, s.rung])).toEqual([
      ["resolved", "testId"],
      ["resolved", "role+name"],
      ["resolved", "css"],
    ]);
  });

  it("the summary is 1 high, 1 medium-or-high and 1 low", () => {
    expect(health.steps.map((s) => s.level)).toEqual(["high", expect.stringMatching(/^(high|medium)$/), "low"]);
  });

  it("only the data-testid step is on a stable locator", () => {
    expect(health.steps.map((s) => s.stability)).toEqual(["stable", "brittle", "brittle"]);
  });

  it("a suggestion names the css-only element and its route", () => {
    const css = health.steps[2]!.locator.replace(/^css=/, "");
    expect(health.suggestions.find((s) => s.key.includes("|css|"))?.fix).toBe(
      `add data-testid="contacts-div" to the element at css ${JSON.stringify(css)} on /contacts/new and give it an accessible name (visible text or aria-label)`,
    );
  });
});
