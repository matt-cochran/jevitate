import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { startServer } from "@jevitate/example-site";
import {
  assertAuthorizedExploreTarget,
  UnauthorizedExploreTargetError,
  BoundsTracker,
  resolveBounds,
  decide,
  FillHelper,
  PROMPT_INJECTION_GUARD,
  runGoalBasedMission,
  type Snapshot,
  type Control,
} from "./index.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * @jevitate/explore — guardrail refusal contract (design §6, BINDING).
 *
 * ONE readable place that asserts each guardrail REFUSES. It adds no new
 * production logic — it reuses the same primitives and fakes as the per-module
 * tests (those remain the exhaustive source of truth). Mirrors
 * packages/runtime/src/slice1-invariants.test.ts.
 */

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

const fakeControl: Control = {
  index: 0,
  descriptor: { role: "textbox", name: "Password" },
  stability: "high",
  role: "textbox",
  name: "Password",
  tag: "input",
  inputType: "password",
  enabled: true,
  summary: 'textbox "Password"',
};
const fakeSnapshot: Snapshot = {
  url: "http://127.0.0.1:3000/login?token=hunter2",
  controls: [fakeControl],
  truncated: false,
  signature: "sig",
};

describe("explore — guardrail refusal contract (design §6)", () => {
  it("#1 authorized-target-only: an off-allowlist origin is REFUSED before anything runs", () => {
    expect(() =>
      assertAuthorizedExploreTarget("https://prod.example.com/", ["http://127.0.0.1:3000"]),
    ).toThrow(UnauthorizedExploreTargetError);
    // and an empty allowlist authorizes nothing (fail-closed).
    expect(() => assertAuthorizedExploreTarget("http://127.0.0.1:3000/", [])).toThrow(
      UnauthorizedExploreTargetError,
    );
  });

  it("#2 bounded + fail-closed: the tracker REFUSES a decision/action past the cap, and the loop stops", async () => {
    // Unit half: the ceiling refuses the N+1th.
    const t = new BoundsTracker(resolveBounds({ maxDecisions: 1, maxActions: 1 }));
    t.countDecision();
    expect(t.mayDecide()).toBe(false);
    t.countAction();
    expect(t.mayAct()).toBe(false);

    // Loop half: a judge that never says done stops as exhausted at the cap.
    const run = await withSession(
      "inv-bounded-",
      async (session) => {
        const actor = CastActor.named("i").whoCan(new BrowseTheWeb(session, [site.url]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "wait" }]),
          gen: new FakeGenerationGateway(),
          goal: "never finish",
          allowlist: [site.url],
          startUrl: `${site.url}/login`,
          successAssertion: { kind: "urlIncludes", text: "/inbox" },
          bounds: { maxDecisions: 2 }, // below MAX_QUIET_WAITS: the budget ends it first
          oracleTimeoutMs: 300,
        });
      },
      site.url,
    );
    expect(run.run.stop).toBe("exhausted");
    expect(run.outcome).toBe("exhausted");
  });

  it("#3 no secrets to models: a registered secret cannot reach a judgment OR a generation payload", async () => {
    // Judgment payload.
    let judgmentDump = "";
    const spyJudge: JudgmentPort = {
      async systemOne(args) {
        judgmentDump = JSON.stringify(args.state);
        return { action: { kind: "choice", value: "done", confidence: 1 } };
      },
    };
    await decide(spyJudge, {
      goal: "log in with hunter2",
      snapshot: fakeSnapshot,
      history: ["typed hunter2"],
      secrets: ["hunter2"],
    });
    expect(judgmentDump).not.toContain("hunter2");

    // Generation payload.
    let genDump = "";
    const spyGen = {
      async generate(_k: "form.value", input: unknown) {
        genDump = JSON.stringify(input);
        return {
          output: { text: "ok" },
          provenance: { adapter: "fake" as const, model: "f", promptVersion: "1", latencyMs: 0, responseHash: "h" },
        };
      },
    };
    const helper = new FillHelper(spyGen as unknown as ConstructorParameters<typeof FillHelper>[0]);
    await helper.valueFor({
      fieldLabel: "Password",
      goal: "use hunter2",
      visibleContext: "value is hunter2",
      secrets: ["hunter2"],
    });
    expect(genDump).not.toContain("hunter2");
  });

  it("#4 independent oracle: a model `done` on the wrong page does NOT count as success", async () => {
    const result = await withSession(
      "inv-oracle-",
      async (session) => {
        const actor = CastActor.named("i").whoCan(new BrowseTheWeb(session, [site.url]));
        return runGoalBasedMission({
          actor,
          judge: new ScriptedJudge([{ op: "done" }]), // claims done immediately on /login
          gen: new FakeGenerationGateway(),
          goal: "reach the inbox",
          allowlist: [site.url],
          startUrl: `${site.url}/login`,
          successAssertion: { kind: "urlIncludes", text: "/inbox" },
          oracleTimeoutMs: 300,
        });
      },
      site.url,
    );
    expect(result.assertionPassed).toBe(false);
    expect(result.outcome).not.toBe("succeeded");
  });

  it("#5 prompt-injection guard: the guard string is present in every model prompt", async () => {
    let controls: string[] = [];
    const spyJudge: JudgmentPort = {
      async systemOne(args) {
        controls = args.state.controls;
        return { action: { kind: "choice", value: "wait", confidence: 1 } };
      },
    };
    await decide(spyJudge, { goal: "x", snapshot: fakeSnapshot, history: [] });
    expect(controls[0]).toBe(PROMPT_INJECTION_GUARD);
  });
});
