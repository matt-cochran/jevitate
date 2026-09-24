import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb, type Actor } from "@jevitate/screenplay";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { runAdversarialMission } from "./adversarial.js";

let site: { url: string; close(): Promise<void> };
let session: BrowserSession;
let actor: Actor;

beforeAll(async () => {
  site = await startServer();
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [site.url]));
}, 120_000);
afterAll(async () => {
  await session.close();
  await site.close();
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
        bounds: { maxDecisions: 4 },
        strategies: ["exercise-controls", "double-submit", "ordering-violation", "boundary-input"],
      });
      expect(result.outcome).toBe("clean");
      expect(result.defects).toEqual([]);
      // Clean is earned: the run exercised the target's controls and submitted its form.
      expect(result.coverage.sufficient).toBe(true);
      expect(result.coverage.forms).toEqual({ found: 1, submitted: 1 });
      expect(result.coverage.controls.exercised).toBe(result.coverage.controls.total);
    },
    120_000,
  );
});

describe("runAdversarialMission — the seed itself cannot be loaded (#128)", () => {
  test(
    "a net::ERR_UNSAFE_PORT on the first navigation ends scope-unreachable/inconclusive with target-unreachable, never crashed",
    async () => {
      const url = "http://127.0.0.1:1/";
      const browserPort = new PlaywrightBrowserPort();
      const badSession = await browserPort.open({ headless: true, allowedOrigins: [url], baseUrl: url });
      try {
        const badActor = CastActor.named("unreachable-tester").whoCan(new BrowseTheWeb(badSession, [url]));
        const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
        const result = await runAdversarialMission({
          page: badSession.page,
          actor: badActor,
          judgment,
          generation: new FakeGenerationGateway(),
          seedUrl: url,
          allowlist: [url],
          bounds: { maxDecisions: 4 },
          strategies: ["exercise-controls"],
        });
        expect(result.stop).toBe("scope-unreachable");
        expect(result.outcome).toBe("inconclusive");
        expect(result.failure?.kind).toBe("target-unreachable");
        expect(result.failure?.message).toMatch(/^target unreachable \(.*unsafe port.*\)$/i);
        expect(result.defects).toEqual([]);
      } finally {
        await badSession.close();
      }
    },
    30_000,
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
        bounds: { maxDecisions: 4 },
        strategies: ["ordering-violation"],
        userInvariant: async (page) => {
          await page.evaluate(() => console.error("adversarial-synthetic-error"));
          return { ok: true };
        },
      });

      expect(result.outcome).toBe("defects-found");
      expect(result.defects[0]?.signals.some((s) => s.kind === "console-error")).toBe(true);
      expect(result.defects[0]?.triage).toMatchObject({ status: "available", summary: "console error observed" });
      expect(result.recording.pages.length).toBeGreaterThan(0);
      // The shared transcript explains every step: the seed load (the invariant already fires
      // there), then the strategy step — the run did NOT stop at the first defect, and the
      // repeat is the same fingerprint, so it is one defect with two occurrences.
      expect(result.transcript).toHaveLength(2);
      expect(result.transcript[0]).toMatchObject({ strategy: "seed-load" });
      expect(result.transcript[1]).toMatchObject({ chosenBy: "strategy", strategy: "ordering-violation", confidence: null });
      expect(result.transcript[1]?.reason).toMatch(/^defect: .*adversarial-synthetic-error/);
      expect(result.defects).toHaveLength(1);
      expect(result.defects[0]).toMatchObject({ firstSeenStep: 1, occurrences: 2, occurrenceSteps: [1, 2] });
    },
    120_000,
  );

  test(
    "a real HTTP 5xx during misuse still stops the mission (5xx scoping did not mask it)",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
      const generation = new FakeGenerationGateway({
        "triage.narrative": { summary: "server error observed", likelyCause: "backend 500" },
      });
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        bounds: { maxDecisions: 4 },
        strategies: ["ordering-violation"],
        // A 5xx sub-resource load: the response listener sees the 500 and gates
        // it as a hard `http-5xx` signal — even though the console-error path is
        // now scoped to exclude 4xx.
        userInvariant: async (page) => {
          await page.evaluate(async () => {
            await fetch("/adversarial/boom").catch(() => undefined);
          });
          return { ok: true };
        },
      });
      expect(result.outcome).toBe("defects-found");
      expect(result.defects[0]?.signals.some((s) => s.kind === "http-5xx")).toBe(true);
    },
    120_000,
  );
});

describe("runAdversarialMission — a legit 4xx during misuse is NOT a defect (#29)", () => {
  test(
    "a 4xx resource load the app returns by design does NOT report a defect",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
      const generation = new FakeGenerationGateway();
      // Misuse legitimately hits a gated/absent route that returns 404. Chromium
      // logs "Failed to load resource: ...404" to the console, but the spec
      // scopes the HTTP hard-signal to 5xx — a 4xx is EXPECTED under misuse and
      // must never false-positive as a defect. The invariant reports ok:true, so
      // the only thing that could gate is the (now-scoped) console signal.
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        bounds: { maxDecisions: 4 },
        strategies: ["exercise-controls", "double-submit", "ordering-violation"],
        userInvariant: async (page) => {
          await page.evaluate(async () => {
            await fetch("/adversarial/notfound").catch(() => undefined);
          });
          return { ok: true };
        },
      });
      expect(result.outcome).toBe("clean");
    },
    120_000,
  );
});

describe("runAdversarialMission — a console error correlated with a captured 4xx is advisory (#88)", () => {
  test(
    "the app's OWN console.error logged right after a 403/404 is reported as an advisory signal, never a defect",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
      const generation = new FakeGenerationGateway();
      // Unlike #29's browser-generated resource-load echo, this is the APP'S OWN console.error call
      // (an HTTP client logging a non-2xx it just received) — the exact pattern #88 reported false
      // positives for. It must correlate to the 404 that preceded it and be reported advisory, not
      // filed as a defect and not counted toward `defects-found`.
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        bounds: { maxDecisions: 4 },
        strategies: ["exercise-controls", "double-submit", "ordering-violation"],
        userInvariant: async (page) => {
          await page.evaluate(async () => {
            const r = await fetch("/adversarial/notfound");
            console.error("ManageBillingToolApi.request failed: {message: Response returned an error code", r.status);
          });
          return { ok: true };
        },
      });
      expect(result.outcome).toBe("clean");
      expect(result.defects).toEqual([]);
      expect(result.advisories.length).toBeGreaterThan(0);
      expect(result.advisories[0]).toMatchObject({ kind: "console-error", status: 404 });
    },
    120_000,
  );
});

describe("runAdversarialMission — a run that proved nothing is never clean (#64)", () => {
  test(
    "a run that never submitted the form and touched little of the page is inconclusive, with its coverage",
    async () => {
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        bounds: { maxDecisions: 3 },
        strategies: ["ordering-violation", "repeat-rapid", "nav-during-pending"],
      });
      expect(result.defects).toEqual([]);
      expect(result.outcome).toBe("inconclusive");
      expect(result.failure?.kind).toBe("insufficient-coverage");
      expect(result.coverage).toMatchObject({
        sufficient: false,
        controls: { total: 2, exercised: 0, ratio: 0 },
        forms: { found: 1, submitted: 0 },
      });
      expect(result.coverage.shortfalls).toEqual([
        "no target control was exercised",
        "0/2 target controls exercised (0%), below the 25% threshold",
        "no form was submitted (1 found)",
      ]);
      expect(result.coverage.strategies["ordering-violation"]).toEqual({ applied: 0, foundNothing: 1 });
      expect(result.coverage.strategies["nav-during-pending"]).toEqual({ applied: 1, foundNothing: 0 });
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
        bounds: { maxDecisions: 4 },
        strategies: ["ordering-violation", "repeat-rapid"],
      });
      // No console error, no 5xx, no failed request, no broken invariant was
      // ever produced in this run — a maximally-confident "looks broken" from
      // the model alone must never surface as outcome:"defect".
      expect(result.outcome).not.toBe("defects-found");
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
        bounds: { maxDecisions: 4 },
        strategies: ["boundary-input", "exercise-controls", "double-submit"],
      });
      expect(result.defects).toEqual([]);
      expect(result.outcome).toBe("clean");
    },
    120_000,
  );
});

describe("runAdversarialMission — the outcome is a typed result, never a throw (owner ruling 1)", () => {
  test(
    "an unavailable triage narrative keeps the defect with its raw evidence and marks triage unavailable",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
      const generation = {
        async generate(): Promise<never> {
          throw new Error("provider unavailable (503)");
        },
      };
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        bounds: { maxDecisions: 4 },
        strategies: ["ordering-violation"],
        userInvariant: async (page) => {
          await page.evaluate(() => console.error("triage-helper-down"));
          return { ok: true };
        },
      });
      expect(result.outcome).toBe("defects-found");
      expect(result.defects).toHaveLength(1);
      expect(result.defects[0]?.signals.some((s) => s.detail.includes("triage-helper-down"))).toBe(true);
      expect(result.defects[0]?.triage).toEqual({
        status: "unavailable",
        reason: "triage generation failed: provider unavailable (503)",
      });
      // The transcript and Recording are always kept.
      expect(result.transcript.length).toBeGreaterThan(0);
      expect(result.recording.pages.length).toBeGreaterThan(0);
    },
    120_000,
  );

  test(
    "an engine failure mid-run returns `crashed` with the partial transcript and Recording — never clean",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
      let calls = 0;
      const entries: number[] = [];
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation: new FakeGenerationGateway(),
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        bounds: { maxDecisions: 4 },
        strategies: ["boundary-input", "boundary-input"],
        onTranscriptEntry: (e) => entries.push(e.step),
        userInvariant: async () => {
          calls += 1;
          if (calls === 2) throw new Error("engine exploded");
          return { ok: true };
        },
      });
      expect(result.outcome).toBe("crashed");
      expect(result.failure).toMatchObject({ kind: "exception", message: "engine exploded" });
      expect(result.failure?.stack).toContain("engine exploded");
      // Attributed from evidence: thrown from code under jevitate's roots, no crash signal.
      expect(result.crash?.attribution.attribution).toBe("jevitate");
      expect(result.crash?.evidence.pageCrashed).toBe(false);
      expect(result.heap.length).toBeGreaterThan(0);
      // The step before the failure survived — in the result AND through the incremental seam.
      expect(result.transcript).toHaveLength(1);
      expect(entries).toEqual([1]);
      expect(result.recording.pages.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

describe("runAdversarialMission — horizontal-overflow hard signal (#149)", () => {
  test(
    "at a 375px viewport, /responsive/overflow is a hard defect attributed to [data-testid=wide], with a stable fingerprint",
    async () => {
      const browserPort = new PlaywrightBrowserPort();
      const narrowSession = await browserPort.open({
        headless: true,
        allowedOrigins: [site.url],
        baseUrl: site.url,
        viewport: { width: 375, height: 812 },
      });
      try {
        const narrowActor = CastActor.named("responsive-adversary").whoCan(new BrowseTheWeb(narrowSession, [site.url]));
        const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
        const result = await runAdversarialMission({
          page: narrowSession.page,
          actor: narrowActor,
          judgment,
          generation: new FakeGenerationGateway(),
          seedUrl: `${site.url}/responsive/overflow`,
          allowlist: [site.url],
          bounds: { maxDecisions: 1 },
          strategies: ["exercise-controls"],
        });
        const overflowDefects = result.defects.filter((d) => d.kind === "horizontal-overflow");
        expect(overflowDefects).toHaveLength(1);
        expect(overflowDefects[0]!.title).toContain("[data-testid=wide]");
        expect(overflowDefects[0]!.route).toBe("/responsive/overflow");
        expect(overflowDefects[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      } finally {
        await narrowSession.close();
      }
    },
    30_000,
  );

  test("at a 1280px viewport, the same page is clean (no horizontal-overflow defect)", async () => {
    const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
    const result = await runAdversarialMission({
      page: session.page,
      actor,
      judgment,
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/responsive/overflow`,
      allowlist: [site.url],
      bounds: { maxDecisions: 1 },
      strategies: ["exercise-controls"],
    });
    expect(result.defects.filter((d) => d.kind === "horizontal-overflow")).toEqual([]);
  }, 30_000);
});
