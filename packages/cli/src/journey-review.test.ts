import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { registerJourneyVerify, type JourneyVerifySeams } from "./journey-cli/verify.js";
import { readVerifyRecord } from "./journey-review-store.js";
import { __resetTerminalResultForTests, type TerminalResultDeps } from "./terminal-result.js";
import { FsJourneyStore, JourneyReviewSchema, applyAnnotationDraft, journeyProofHash, type AnnotationDraft, type Journey } from "@jevitate/journey";
import { legacyProofVerdict } from "@jevitate/domain";
import { buildJourneyReview, journeyLegacyReviewHash, journeyReviewHash, renderReviewMarkdown, renderReviewText, reviewSheetHash, type JourneyVerifyRecord } from "./journey-review.js";

/** #432 — the review sheet builder: one assertion per test, per section. */

const SITE = "https://shop.example.test";
const LITERAL_SECRET = "hunter2-literal-value";
const SECRET_KEY_NAME = "SHOP_PASSWORD_ENV_KEY";

export function fixtureJourney(overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id: "buy-pro",
      name: "Buy the Pro plan",
      description: "Signs in and buys the Pro plan",
      promoted: false,
      params: ["email", "password"],
      createdAtIso: "2026-10-01T00:00:00.000Z",
      goal: "Buy the Pro plan",
      successCriteria: [{ description: "The order is confirmed", check: { kind: "textIncludes", target: { role: "status" }, text: "Order confirmed" } }],
      parameters: [{ name: "email", description: "the buyer's login" }, { name: "password", secret: true }],
      secretRefs: [{ manager: "env", key: SECRET_KEY_NAME, origin: SITE, field: "password" }],
      endState: [
        { kind: "responseStatus", method: "POST", pathGlob: "/api/orders", status: { class: 2 } },
        { kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "plan" }, text: "Pro" } },
      ],
      ...overrides,
    },
    recording: {
      version: "1.0.0",
      site: SITE,
      pages: [
        {
          url: `${SITE}/login`,
          steps: [
            { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { label: "Email" } } }, objective: "Open the sign-in page" },
            { step: { kind: "fill", target: { label: "Email" }, value: { var: "email" }, expect: { kind: "visible", target: { label: "Email" } } } },
            { step: { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: { kind: "visible", target: { role: "button", name: "Sign in" } } } },
            {
              step: { kind: "fill", target: { label: "API token" }, value: { redacted: false, value: LITERAL_SECRET }, expect: { kind: "visible", target: { role: "button", name: "Sign in" } } },
            },
            { step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "urlIncludes", text: "/plans" } } },
          ],
        },
        {
          url: `${SITE}/plans`,
          steps: [
            {
              step: { kind: "click", target: { role: "button", name: "Activate Pro" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Order confirmed" } },
              objective: "Pay for the plan",
              expectedResult: "The order is confirmed",
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/orders", status: { class: 2 } }],
              delta: { verdict: "relevant-change", why: "status changed", changes: ["status: Order confirmed"], requests: ["POST /api/orders → 201", "GET https://cdn.example.test/plan.json → 200"], overheadMs: 3 },
            },
            { step: { kind: "click", target: { role: "button", name: "Sign out" }, expect: { kind: "urlIncludes", text: "/login" } } },
          ],
        },
      ],
    },
  };
}

const VERIFY: JourneyVerifyRecord = {
  journeyId: "buy-pro",
  contentHash: journeyReviewHash(fixtureJourney()),
  proofHash: journeyProofHash(fixtureJourney()),
  verdict: "sensitive",
  // M5: a 0.30.0 receipt names the target origin it ran on.
  target: { origin: new URL(SITE).origin },
  summary: { sensitive: 3, insensitive: 0, cascade: 0, notApplied: 0, error: 0, unpaired: 1 },
  at: "2026-10-02T00:00:00.000Z",
};

const review = buildJourneyReview(fixtureJourney(), { safety: { paid: ["/^Activate/"] }, lastVerify: VERIFY, approvedSnapshot: null });

describe("#432 buildJourneyReview", () => {
  it("is schema-valid JSON", () => {
    expect(JourneyReviewSchema.safeParse(JSON.parse(JSON.stringify(review))).success).toBe(true);
  });

  it("summary: carries the goal", () => {
    expect(review.summary.goal).toBe("Buy the Pro plan");
  });

  it("uses the target's explicit read-request policy consistently for lint and displayed side effects", () => {
    const journey = fixtureJourney({ endState: [] });
    journey.recording.pages = [{
      url: `${SITE}/companies`,
      steps: [{
        step: {
          kind: "click",
          target: { testId: "open-companies" },
          expect: { kind: "visible", target: { testId: "companies-table" } },
        },
        objective: "Open the companies table",
        expectedResult: "The companies table is visible",
        expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/v1/tool/crm-companies/query", status: { class: 2 } }],
        delta: {
          verdict: "relevant-change",
          why: "companies loaded",
          changes: ["companies table visible"],
          requests: ["POST /api/v1/tool/crm-companies/query → 200"],
          overheadMs: 1,
        },
      }],
    }];

    const reviewed = buildJourneyReview(journey, { safety: { readRequests: ["/api/v1/tool/crm-companies/query"] } });

    expect(reviewed.proof.lint.findings.some((finding) => finding.rule === "no-persistence-check")).toBe(false);
    expect(reviewed.sideEffects.writeRequests).toEqual([]);
  });

  it("summary: carries the success criteria with their checks", () => {
    expect(review.summary.successCriteria).toEqual([{ description: "The order is confirmed", check: "textIncludes:role=status|Order confirmed" }]);
  });

  it("summary: flags steps without an objective", () => {
    expect(review.summary.missingIntent).toEqual([expect.stringMatching(/^5 of 7 step\(s\) have no objective/)]);
  });

  it("summary: flags a missing goal and success criteria", () => {
    const bare = buildJourneyReview(fixtureJourney({ goal: undefined, successCriteria: undefined }));
    expect(bare.summary.missingIntent.slice(0, 2)).toEqual([expect.stringMatching(/^no goal/), expect.stringMatching(/^no success criteria/)]);
  });

  it("steps: the action in plain words with its target control, objective and expected result", () => {
    expect(review.steps[5]).toMatchObject({
      number: 6,
      action: 'click button "Activate Pro"',
      target: { role: "button", name: "Activate Pro" },
      objective: "Pay for the plan",
      expectedResult: "The order is confirmed",
    });
  });

  it("steps: the parameters each step uses", () => {
    expect(review.steps.map((s) => s.params)).toEqual([[], ["email"], ["password"], [], [], [], []]);
  });

  it("side effects: the expected write requests (recorded, expected, end state)", () => {
    expect(review.sideEffects.writeRequests).toEqual([
      { method: "POST", endpoint: "/api/orders", source: "recorded", step: 6 },
      { method: "POST", endpoint: "/api/orders", source: "expect-request", step: 6 },
      { method: "POST", endpoint: "/api/orders", source: "end-state" },
    ]);
  });

  it("side effects: controls matching the safety rules, with their rule ids", () => {
    expect(review.sideEffects.riskyControls.map((c) => `${c.step}:${c.control}:${c.ruleId}`)).toEqual(["6:Activate Pro:paid:/^Activate/", "7:Sign out:builtin:session-end"]);
  });

  it("side effects: the origins it touches", () => {
    expect(review.sideEffects.origins).toEqual([SITE, "https://cdn.example.test"]);
  });

  it("inputs: parameters by name, secrets marked", () => {
    expect(review.inputs.params).toEqual([
      { name: "email", description: "the buyer's login", secret: false },
      { name: "password", secret: true },
    ]);
  });

  it("inputs: secret references by field and manager only", () => {
    expect(review.inputs.secrets).toEqual([{ field: "password", manager: "env", origin: SITE }]);
  });

  it("proof: the end-state checks", () => {
    expect(review.proof.endState).toEqual(["responseStatus:POST /api/orders=2xx", "reloadThen:textIncludes:testId=plan|Pro"]);
  });

  it("proof: per-step assertions, the weak ones marked", () => {
    expect(review.proof.stepAssertions.filter((a) => a.weak).map((a) => a.step)).toEqual([1, 2, 3, 4]);
  });

  it("proof: the lint result", () => {
    expect(review.proof.lint.errors).toBe(review.proof.lint.findings.filter((f) => f.level === "error").length);
  });

  it("proof: the last mutation-proof verdict when one is recorded", () => {
    expect(review.proof.verify).toMatchObject({ status: "recorded", verdict: "sensitive", stale: false });
  });

  it("proof: a 0.29.0 receipt's legacy word reads as sensitive (d-vocab-migration)", () => {
    const r = buildJourneyReview(fixtureJourney(), { lastVerify: { ...VERIFY, verdict: legacyProofVerdict("sensitive") } });
    expect(r.proof.verify).toMatchObject({ status: "recorded", verdict: "sensitive" });
  });

  it("proof: the sheet shows the proof as a checks-strength line, with whether it counts for a strict gate", () => {
    const uncounted = renderReviewText(buildJourneyReview(fixtureJourney(), { lastVerify: VERIFY, approvedSnapshot: null }), { color: false, width: 400 });
    expect(uncounted).toContain("checks strength: sensitive ✓ (does not count for a strict gate: the target cannot be reset)");
    expect(uncounted).not.toMatch(/\bproven\b/);
    const counted = renderReviewText(buildJourneyReview(fixtureJourney(), { lastVerify: { ...VERIFY, countsForGate: true }, approvedSnapshot: null }), { color: false, width: 400 });
    expect(counted).toContain("checks strength: sensitive ✓");
    expect(counted).not.toContain("does not count");
    const full = renderReviewText(buildJourneyReview(fixtureJourney(), { lastVerify: { ...VERIFY, countsForGate: true }, approvedSnapshot: null }), { color: false, width: 400, full: true });
    expect(full).toContain("Mutation proof (checks strength): sensitive");
    expect(full).toContain("counts for a strict gate");
  });

  it("proof: a proof recorded for other content is stale", () => {
    const r = buildJourneyReview(fixtureJourney(), { lastVerify: { ...VERIFY, proofHash: "0".repeat(64) } });
    expect(r.proof.verify).toMatchObject({ status: "recorded", stale: true });
  });

  it("proof: not verified, with how to run it, when none is recorded", () => {
    expect(buildJourneyReview(fixtureJourney()).proof.verify).toEqual({ status: "not-verified", hint: expect.stringContaining("jevitate journey verify buy-pro --mutate") });
  });

  it("change: first approval when never approved", () => {
    expect(review.changeSinceApproval).toEqual({ kind: "first-approval" });
  });

  it("change: a diff against the approved snapshot", () => {
    const approved = fixtureJourney();
    const current = fixtureJourney({ endState: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/orders", status: { class: 2 } }] });
    const r = buildJourneyReview(current, { approvedSnapshot: approved });
    expect(r.changeSinceApproval).toMatchObject({ kind: "diff", changed: true, assertions: { added: [], removed: ["end state: reloadThen:textIncludes:testId=plan|Pro"] } });
  });

  it("change: unchanged since an approval whose bookkeeping differs", () => {
    const approved = fixtureJourney();
    const current = fixtureJourney({ promoted: true, approval: { contentHash: journeyReviewHash(approved), at: "2026-10-03T00:00:00.000Z" } });
    expect(buildJourneyReview(current, { approvedSnapshot: approved }).changeSinceApproval).toMatchObject({ kind: "diff", changed: false });
  });

  it("change: an approval whose snapshot is missing is compared by hash", () => {
    const current = fixtureJourney({ promoted: true, approval: { contentHash: "a".repeat(64), at: "2026-10-03T00:00:00.000Z" } });
    expect(buildJourneyReview(current).changeSinceApproval).toEqual({ kind: "snapshot-missing", approvedHash: "a".repeat(64), approvedAt: "2026-10-03T00:00:00.000Z", changed: true });
  });

  it("change: a legacy v1 hash still authorizes the unchanged Journey", () => {
    const bare = fixtureJourney();
    const current = fixtureJourney({ promoted: true, approval: { contentHash: journeyLegacyReviewHash(bare), at: "2026-10-03T00:00:00.000Z" } });
    expect(buildJourneyReview(current).changeSinceApproval).toMatchObject({ kind: "snapshot-missing", changed: false });
  });

  it("content hash: the review hash, which promoting does not change", () => {
    expect(review.contentHash).toBe(journeyReviewHash(fixtureJourney({ promoted: true, acceptedWeak: { reason: "x", rules: [] } })));
  });
});

describe("#523 a mutation proof goes stale only when executable content changes", () => {
  /** What `journey annotate --approve` writes: goal, criteria wording, step objective and expected result. */
  function annotated(): Journey {
    const draft: AnnotationDraft = {
      kind: "jevitate.journey-annotations.draft",
      version: 1,
      journeyId: "buy-pro",
      journeyHash: "0".repeat(64),
      createdAtIso: "2026-10-04T00:00:00.000Z",
      provenance: { adapter: "human", model: "-", promptVersion: "1" },
      replay: { outcome: "completed", reachedSteps: 7, totalSteps: 7 },
      goal: "Upgrade to the Pro plan",
      successCriteria: ["The order is confirmed", "A receipt is shown"],
      steps: [{ index: 1, step: "fill Email", objective: "Enter the login email", expectedResult: "The email is filled" }],
    };
    return applyAnnotationDraft(fixtureJourney(), draft).journey;
  }
  const PROOF: JourneyVerifyRecord = { ...VERIFY, proofHash: journeyProofHash(fixtureJourney()) };

  it("the proof stays fresh after an annotation-only change", () => {
    expect(buildJourneyReview(annotated(), { lastVerify: PROOF }).proof.verify).toMatchObject({ status: "recorded", stale: false });
  });

  it("the proof goes stale when a step's target changes", () => {
    const j = fixtureJourney();
    const s = j.recording.pages[1]!.steps[0]!.step;
    if (s.kind === "click") s.target = { role: "button", name: "Buy Pro" };
    expect(buildJourneyReview(j, { lastVerify: PROOF }).proof.verify).toMatchObject({ stale: true });
  });

  it("an old record without planner identity must be reverified even when the content is unchanged", () => {
    const { proofHash: _proofHash, ...legacy } = VERIFY;
    expect(buildJourneyReview(fixtureJourney(), { lastVerify: legacy }).proof.verify).toMatchObject({ stale: true });
  });

  it("the approval still goes stale on an annotation change (journeyReviewHash)", () => {
    expect(journeyReviewHash(annotated())).not.toBe(journeyReviewHash(fixtureJourney()));
  });
});

describe("#432 secrets never appear in the sheet", () => {
  const outputs = { json: JSON.stringify(review), markdown: renderReviewMarkdown(review), text: renderReviewText(review) };
  for (const [kind, out] of Object.entries(outputs)) {
    it(`${kind}: no credential-field literal`, () => {
      expect(out).not.toContain(LITERAL_SECRET);
    });
    it(`${kind}: no secret-manager key`, () => {
      expect(out).not.toContain(SECRET_KEY_NAME);
    });
  }
});

describe("#497 a recorded display label that reads as a credential hides the typed literal", () => {
  it("a fill whose only credential hint is its display label shows no literal", () => {
    const j = fixtureJourney();
    const page = j.recording.pages[0]!;
    const withDisplay = {
      ...j,
      recording: { ...j.recording, pages: [{ ...page, steps: [{ step: { kind: "fill" as const, target: { testId: "field-7", display: { role: "textbox", name: "Password" } }, value: { redacted: false as const, value: "hunter2-literal" } } }, ...page.steps] }, ...j.recording.pages.slice(1)] },
    };
    expect(renderReviewText(buildJourneyReview(withDisplay))).not.toContain("hunter2-literal");
  });
});

describe("#432 rendering", () => {
  it("markdown snapshot of the fixture Journey", () => {
    expect(renderReviewMarkdown(review)).toMatchSnapshot();
  });

  it("a rendered sheet names its content hash (markdown)", () => {
    expect(reviewSheetHash(renderReviewMarkdown(review))).toBe(review.contentHash);
  });

  it("a rendered sheet names its content hash (text)", () => {
    expect(reviewSheetHash(renderReviewText(review))).toBe(review.contentHash);
  });

  it("a JSON sheet names its content hash", () => {
    expect(reviewSheetHash(JSON.stringify(review))).toBe(review.contentHash);
  });

  it("a sheet naming no hash is refused", () => {
    expect(() => reviewSheetHash("# nothing here")).toThrow(/names no content hash/);
  });
});

describe("#565 review sheet: parameter-relative checks", () => {
  const withEmailCheck = (): Journey => {
    const j = fixtureJourney();
    j.recording.pages[0]!.steps[1]!.step = { kind: "fill", target: { label: "Email" }, value: { var: "email" }, expect: { kind: "valueEquals", target: { label: "Email" }, value: { var: "email" } } };
    return j;
  };
  const emailCheck = (j: Journey) => buildJourneyReview(j).proof.stepAssertions.find((a) => a.step === 2)!;

  it("a check naming a non-secret parameter is not weak", () => {
    expect(emailCheck(withEmailCheck()).weak).toBe(false);
  });

  it("a check naming a parameter shows the reference, not a value", () => {
    expect(emailCheck(withEmailCheck()).text).toBe('"Email" has the value of email');
  });

  it("a check naming a secret parameter is weak", () => {
    const j = withEmailCheck();
    j.recording.pages[0]!.steps[1]!.step = { kind: "fill", target: { label: "Email" }, value: { var: "email" }, expect: { kind: "valueEquals", target: { label: "Email" }, value: { var: "password" } } };
    expect(emailCheck(j).weak).toBe(true);
  });
});

describe("#659 — a waitFor step's documented result in the review sheet", () => {
  it("the review's lint proof has no intent-uncovered finding for it", () => {
    const base = fixtureJourney();
    const waitPage = {
      url: `${SITE}/handoff`,
      steps: [
        {
          step: { kind: "waitFor" as const, target: { testId: "conversation-handoff" }, state: "visible" as const },
          objective: "Wait for the populated asynchronous handoff before extraction",
          expectedResult: "The populated handoff is visible before any extraction.",
        },
      ],
    };
    const journey: Journey = { ...base, recording: { ...base.recording, pages: [...base.recording.pages, waitPage] } };
    expect(buildJourneyReview(journey).proof.lint.findings.some((f) => f.rule === "intent-uncovered")).toBe(false);
  });
});

describe("d-vocab-migration: `journey verify --json` carries verdict and verdictLegacy", () => {
  type Run = NonNullable<JourneyVerifySeams["run"]>;
  type RunResult = Awaited<ReturnType<Run>>;
  const ID = "save-text";
  const passed = { outcome: "ok", output: {} } as RunResult;
  const requestBroken = { outcome: "quarantined", reason: "step 3 request check failed", outcomeFailures: [{ where: "step-request", step: 3, checkIndex: 0 }], blockedWrites: [{ method: "POST", path: "/api/save" }] } as unknown as RunResult;
  const stepBroken = { outcome: "quarantined", reason: "step 2 postcondition failed", at: 1, failurePhase: "postcondition" } as RunResult;
  const NAV = { step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } };
  const FILL = { step: { kind: "fill", target: { label: "Text" }, value: { redacted: false, value: "hello" }, expect: { kind: "valueEquals", target: { label: "Text" }, value: "hello" } } };
  const SAVE = {
    step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "count", target: { testId: "status" }, min: 0 } },
    delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 },
    expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } }],
  };
  const journeyOf = (steps: readonly unknown[]): Journey =>
    ({ metadata: { id: ID, name: "Save text", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00.000Z" }, recording: { version: "1", site: "http://127.0.0.1:9", pages: [{ url: "/editor", steps }] } }) as unknown as Journey;
  const terminal = (): TerminalResultDeps => ({
    exit: () => undefined,
    terminateBrowsers: () => undefined,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    writeResult: (path) => path,
    engine: () => ({ version: "0.0.0-test" }) as ReturnType<TerminalResultDeps["engine"]>,
    onFatalError: () => () => undefined,
    onProcessExit: () => () => undefined,
    installKillSwitch: () => undefined,
    sharedProcess: () => false,
  });
  /** The base reports each step's end, so the proof has a pace (and runs its independence and closing replays). */
  const FAKE_ACTOR = { ability: () => ({ session: { page: {} } }) };
  type Observed = { observer?: { beforeStep?: (s: never) => Promise<void>; afterStep?: (s: never) => Promise<void> } };
  /** Replay 1 is the base, replay 2 the independence replay; then one per mutation in plan order (skip, block-write, stale fill), each breaking its paired check. */
  const proving = (): Run => {
    let raw = 0;
    const answers = [requestBroken, requestBroken, stepBroken];
    return (async (options: Observed) => {
      raw += 1;
      if (raw === 1) {
        for (const index of [0, 1, 2]) {
          await options.observer?.beforeStep?.({ index, actor: FAKE_ACTOR } as never);
          await options.observer?.afterStep?.({ index, actor: FAKE_ACTOR, outcome: "done" } as never);
        }
        return passed;
      }
      return raw === 2 ? passed : (answers[raw - 3] ?? passed);
    }) as unknown as Run;
  };

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-vocab-verify-"));
    installClock(new FakeClock({ startMs: Date.parse("2026-11-09T12:00:00.000Z") }));
    __resetTerminalResultForTests();
  });
  afterEach(async () => {
    resetClock();
    __resetTerminalResultForTests();
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function verifyJson(run: Run): Promise<{ verdict: string; verdictLegacy: string }> {
    const out: string[] = [];
    const program = new Command();
    program.configureOutput({ writeOut: (s) => void out.push(s), writeErr: () => undefined });
    registerJourneyVerify(program.command("journey"), program, { profiles: new ProfileManager("/unused"), journeysDir: dir, dbPath: join(dir, "no-site-policy.sqlite") }, { run, terminal: terminal() });
    await program.parseAsync(["journey", "verify", ID, "--mutate", "--json"], { from: "user" });
    return (JSON.parse(out.join("")) as { data: { verdict: string; verdictLegacy: string } }).data;
  }

  it("a sensitive proof: verdict 'sensitive', verdictLegacy 'proven', exit 0, and the receipt stores the new word", async () => {
    await new FsJourneyStore(dir).put(journeyOf([NAV, FILL, SAVE]));
    const data = await verifyJson(proving());
    expect({ verdict: data.verdict, verdictLegacy: data.verdictLegacy }).toEqual({ verdict: "sensitive", verdictLegacy: "proven" });
    expect(process.exitCode).toBe(0);
    expect(await readVerifyRecord(dir, ID)).toMatchObject({ verdict: "sensitive", countsForGate: false });
  });

  it("an inconclusive proof: both are 'inconclusive'", async () => {
    await new FsJourneyStore(dir).put(journeyOf([NAV]));
    const data = await verifyJson((async () => passed) as unknown as Run);
    expect({ verdict: data.verdict, verdictLegacy: data.verdictLegacy }).toEqual({ verdict: "inconclusive", verdictLegacy: "inconclusive" });
    expect(process.exitCode).toBe(2);
  });
});
