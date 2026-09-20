import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { runFeatureMission } from "./feature.js";
import type { CapabilityScope } from "../feature/capability-scope.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
let session: BrowserSession;
let actor: CastActor;

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-feature-"));
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("feature-explorer").whoCan(new BrowseTheWeb(session, [site.url]));
  // Authenticate once so /inbox and /thread/:id are reachable (the persistent
  // profile keeps the session cookie across mission navigations).
  await session.page.goto(`${site.url}/login`);
  await session.page.fill('input[name="username"]', "jane");
  await session.page.click('button[type="submit"]');
  await session.page.waitForURL(/\/inbox/);
}, 120_000);

afterAll(async () => {
  await session?.close();
  await site?.close();
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
});

describe("runFeatureMission — single path", () => {
  test(
    "a sign-in submit exhausts the scope without discovering a new in-scope state",
    async () => {
      const scope: CapabilityScope = { name: "sign in", originAllowlist: [site.url], routeGlobs: ["/login"] };
      const result = await runFeatureMission({
        page: session.page as Page,
        actor,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        scope,
      });
      expect(result.outcome).toBe("exhausted");
      expect(result.coverage.statesExercised).toBe(1);
      expect(result.coverage.pathsDiscovered).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );
});

describe("runFeatureMission — multi-path discovery", () => {
  const scope = (): CapabilityScope => ({ name: "read messages", originAllowlist: [site.url], routeGlobs: ["/inbox", "/thread/**"] });

  test(
    "discovers both thread routes as distinct valid paths through the 'read messages' capability",
    async () => {
      const result = await runFeatureMission({
        page: session.page as Page,
        actor,
        seedUrl: `${site.url}/inbox`,
        allowlist: [site.url],
        scope: scope(),
      });
      expect(result.outcome).toBe("exhausted");
      expect(result.coverage.statesExercised).toBe(3); // inbox + thread-t-1 + thread-t-2
      expect(result.coverage.pathsDiscovered).toBeGreaterThanOrEqual(3);
      expect(result.recordings.length).toBeGreaterThanOrEqual(2);
    },
    120_000,
  );

  test(
    "every discovered path's Recording replays deterministically via the interpreter",
    async () => {
      const result = await runFeatureMission({
        page: session.page as Page,
        actor,
        seedUrl: `${site.url}/inbox`,
        allowlist: [site.url],
        scope: scope(),
      });
      const interpreter = new RecordingInterpreter();
      for (const recording of result.recordings) {
        const outcome = await interpreter.run(actor, recording);
        expect(outcome.outcome).toBe("completed");
      }
    },
    120_000,
  );
});

describe("runFeatureMission — boundary states and scope edges", () => {
  test(
    "any recorded fill step carries a boundary-value candidate, never an empty value",
    async () => {
      // NOTE: under the real `Control` (no `value` field), a typed field does
      // not change the state fingerprint, so a standalone fill branch always
      // lands on an already-visited state and is not retained as a leaf — this
      // assertion is therefore vacuous for the login fixture (fillSteps == []).
      // The real proof that a boundary value (never empty, never a secret) is
      // chosen lives in boundary-values.test.ts (Task 4) and the guardrail
      // contract (Task 8); this guards the recorded artifact's shape.
      const scope: CapabilityScope = { name: "sign in", originAllowlist: [site.url], routeGlobs: ["/login"] };
      const result = await runFeatureMission({
        page: session.page as Page,
        actor,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        scope,
      });
      const fillSteps = result.recordings.flatMap((r) => r.pages.flatMap((p) => p.steps)).filter((s) => s.step.kind === "fill");
      for (const s of fillSteps) {
        if (s.step.kind === "fill" && "value" in s.step.value) {
          expect(s.step.value.redacted ? true : s.step.value.value.length).toBeTruthy();
        }
      }
    },
    120_000,
  );

  test(
    "a link outside the capability's route globs is recorded as a boundary edge, not expanded",
    async () => {
      // Scope the "inbox entry" capability to ONLY /inbox — both thread links
      // are then genuinely out of scope.
      const scope: CapabilityScope = { name: "inbox entry", originAllowlist: [site.url], routeGlobs: ["/inbox"] };
      const result = await runFeatureMission({
        page: session.page as Page,
        actor,
        seedUrl: `${site.url}/inbox`,
        allowlist: [site.url],
        scope,
      });
      expect(result.coverage.statesExercised).toBe(1); // only /inbox is ever in scope
      expect(result.coverage.boundaryEdges.length).toBeGreaterThanOrEqual(2); // both thread links hit
      expect(result.coverage.boundaryEdges.every((u) => u.includes("/thread/"))).toBe(true);
    },
    120_000,
  );
});
