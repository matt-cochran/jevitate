import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb, type Actor } from "@jevitate/screenplay";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { runAdversarialMission } from "./adversarial.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
let session: BrowserSession;
let actor: Actor;

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-adversarial-"));
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [site.url]));
}, 120_000);
afterAll(async () => {
  await session.close();
  await site.close();
  await rm(profileDir, { recursive: true, force: true });
});

describe("runAdversarialMission — clean run", () => {
  test(
    "a well-behaved page under bounded misuse strategies reports 'clean'",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
      const generation = new FakeGenerationGateway();
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        strategies: ["ordering-violation", "repeat-rapid", "boundary-input"],
      });
      expect(result.outcome === "clean" || result.outcome === "cap").toBe(true);
    },
    120_000,
  );
});

describe("runAdversarialMission — hard defect", () => {
  test(
    "a console error stops the mission, keeps the Recording, and produces a triage narrative",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
      const generation = new FakeGenerationGateway({
        "triage.narrative": { summary: "console error observed", likelyCause: "client-side script error" },
      });

      // The HARD signal comes from the console listener, not the invariant's
      // return value: the invariant hook fires a real console.error and still
      // reports ok:true, proving the stop is driven by the independent oracle.
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        strategies: ["ordering-violation"],
        userInvariant: async (page) => {
          await page.evaluate(() => console.error("adversarial-synthetic-error"));
          return { ok: true };
        },
      });

      expect(result.outcome).toBe("defect");
      if (result.outcome === "defect") {
        expect(result.defect.signals.some((s) => s.kind === "console-error")).toBe(true);
        expect(result.defect.triage.summary).toContain("console error");
        expect(result.defect.recording).toBeDefined();
      }
    },
    120_000,
  );
});

describe("runAdversarialMission — model verdict is advisory only (guardrail #4)", () => {
  test(
    "Jev screaming 'looks broken' with no hard signal does NOT stop the mission or report a defect",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: true, probability: 0.99 } });
      const generation = new FakeGenerationGateway();
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        strategies: ["ordering-violation", "repeat-rapid"],
      });
      // No console error, no 5xx, no failed request, no broken invariant was
      // ever produced in this run — a maximally-confident "looks broken" from
      // the model alone must never surface as outcome:"defect".
      expect(result.outcome).not.toBe("defect");
    },
    120_000,
  );

  test(
    "even when an action IS taken and Jev is consulted, its 'looks broken' verdict is discarded (no hard signal → not a defect)",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: true, probability: 0.99 } });
      const generation = new FakeGenerationGateway();
      // boundary-input types an invalid value into the username field: a real
      // action runs, so the SOFT Noul augment is genuinely consulted — and its
      // maximally-confident "broken" verdict is discarded, never adjudicating.
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        strategies: ["boundary-input"],
      });
      expect(result.outcome).not.toBe("defect");
      expect(result.outcome === "clean" || result.outcome === "cap").toBe(true);
    },
    120_000,
  );
});
