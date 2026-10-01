import { describe, expect, it } from "vitest";
import type { Answer, JudgmentPort, Question } from "@jevitate/ai-core";
import { analyzeClaims, type GuardProbe } from "./claims.js";
import { controlKey } from "./adjudicate.js";
import type { FrictionPoint } from "./friction.js";
import { parseProductFacts, type ProductFacts } from "./product-facts.js";
import { loadV1Rubric } from "./rubric/v1/index.js";
import type { SignalStep } from "./signals.js";
import type { AnalysisOutcome, Control, UxEvidence, UxFinding } from "./types.js";

/**
 * #198 ACCEPTANCE — the edge-case fixture set. Each fixture page plants ONE real problem the grader
 * must catch and ONE look-alike non-problem it must not flag (seeded from the hand-adjudicated
 * preveti cases: an admin queue's Approve/Reject without confirmation was a WRONG finding, and the
 * grader missed that a plan's price was wrong). The pipeline runs over the evidence a live run
 * records — the screens, the guard probes (each destructive control clicked with writes blocked),
 * the friction and the run's steps — with a deterministic scripted Jev. What this proves is the
 * PIPELINE and code's verification; the Jev answers here are scripted, so the real model's
 * categorization and the two-question grade cutoffs still need a real-model calibration pass.
 * The served counterpart (cli `ux-claims-served.test.ts`) runs the same pages through a real browser.
 */

const appContext = { appClass: "admin", persona: "operator", job: "run the workspace" } as const;
const rubric = loadV1Rubric();

let nextIndex = 0;
function control(role: string, name: string, enabled = true): Control {
  const index = nextIndex++;
  return { index, role, name, tag: role === "link" ? "a" : "button", inputType: null, enabled, summary: `${role} "${name}"${enabled ? "" : " (disabled)"}` };
}

function screen(id: string, path: string, controls: Control[], visibleText: string): UxEvidence {
  return {
    screenId: id,
    url: `https://app.example.com${path}`,
    controls,
    visibleText,
    appContext,
    job: appContext.job,
    history: [],
    behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 },
    a11yFacts: { controls: [] },
  };
}

function probe(s: UxEvidence, c: Control, guard: GuardProbe["guard"], blockedWrites: string[]): GuardProbe {
  return {
    screenId: s.screenId,
    route: new URL(s.url).pathname,
    control: `${c.role} "${c.name}"`,
    controlKey: controlKey(c),
    status: "probed",
    guard,
    blockedWrites,
    detail: guard === "none" ? `no guard; blocked ${blockedWrites.join(", ")}` : `guarded by ${guard}`,
  };
}

/** Scripted Jev: every grade "yes, needed to ship", every duplicate "new", friction typed by `types`. */
function scriptedJev(types: Record<string, { type: string; target?: string }> = {}): JudgmentPort & { calls: number; questions: string[] } {
  const port = {
    calls: 0,
    questions: [] as string[],
    async systemOne({ questions }: { questions: Record<string, Question> }) {
      port.calls++;
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        port.questions.push(key);
        if (key.endsWith("::need") || key.endsWith("::ship")) out[key] = { kind: "noul", value: true, probability: 0.9 };
        else if (key.startsWith("dup::")) out[key] = { kind: "choice", value: "new", confidence: 0.9 };
        else if (key.endsWith("::type") || key.endsWith("::target")) {
          if (q.kind !== "choice") throw new Error("not a choice");
          const instr = q.instructions ?? "";
          const hit = Object.entries(types).find(([frag]) => instr.includes(frag))?.[1];
          if (key.endsWith("::type")) out[key] = { kind: "choice", value: hit?.type ?? "not-a-problem", confidence: 0.8 };
          else {
            const want = hit?.target;
            const opt = want === undefined ? "none" : (q.options.find((o) => (q.descriptions?.[o] ?? "").includes(want)) ?? "none");
            out[key] = { kind: "choice", value: opt, confidence: 0.8 };
          }
        } else throw new Error(`unexpected question ${key}`);
      }
      return out;
    },
  };
  return port;
}

interface Fixture {
  readonly name: string;
  readonly screens: UxEvidence[];
  readonly probes?: GuardProbe[];
  readonly facts?: ProductFacts;
  readonly friction?: FrictionPoint[];
  readonly steps?: SignalStep[];
  readonly jev?: Record<string, { type: string; target?: string }>;
  /** The planted real problem: a finding of this claim type mentioning this text. */
  readonly mustCatch: { type: string; mentions: string };
  /** The look-alike: no finding may mention it. */
  readonly mustNotFlag: string;
}

const PRICING_FACTS = parseProductFacts({
  version: 1,
  plans: [
    { name: "Starter", prices: [{ amount: 29, interval: "month" }], trialDays: 14 },
    { name: "Pro", prices: [{ amount: 149, interval: "month" }], trialDays: 14 },
  ],
  journeys: [{ name: "Set up a workspace", routes: ["/onboarding", "/pricing"] }],
  pages: [{ route: "/onboarding", nextStep: "Create project", alternatives: ["Import", "Skip for now"] }],
});

function fixtures(): Fixture[] {
  // 1. Admin queue: Approve/Reject act at once (routine, reversible — the look-alike); Delete user does too (the real problem).
  const approve = control("button", "Approve");
  const reject = control("button", "Reject");
  const del = control("button", "Delete user");
  const queue = screen("queue-1", "/admin/queue", [approve, reject, del], "Review queue\nAda Lovelace — pending\nApprove Reject\nDelete user");
  // The run approved one item, then rejected one: Jev (wrongly) calls the Reject click an unguarded destructive action.
  const queueSteps: SignalStep[] = [
    { step: 1, op: "click", target: 'button "Approve"', actOk: true, url: queue.url },
    { step: 2, op: "click", target: 'button "Reject"', actOk: true, url: queue.url },
    { step: 3, op: "click", target: 'button "Reject"', actOk: true, url: queue.url },
  ];
  const queueFriction: FrictionPoint[] = [
    { id: "retry@2-3", kind: "retry", impact: "slowed", steps: [2, 3], screenIds: ["queue-1"], routes: ["/admin/queue"], detail: "click on Reject repeated 2 times (steps 2, 3)" },
  ];

  // 2. Members: "More actions" (…) opens a menu whose Remove asks for confirmation (look-alike); Remove all members does not.
  const more = control("button", "More actions");
  const removeAll = control("button", "Remove all members");
  const removeItem = control("menuitem", "Remove");
  const members = screen("members-1", "/members", [more, removeAll], "Members\nGrace Hopper\n…\nRemove all members");
  const membersMenu = screen("members-2", "/members", [more, removeItem, removeAll], "Members\nGrace Hopper\nRemove\nRemove all members");

  // 3. Pricing: Pro shows the wrong price (real); Starter's price and a saving are right (look-alikes).
  const upgrade = control("button", "Upgrade to Pro");
  const pricing = screen("pricing-1", "/pricing", [upgrade], "Plans\nStarter $29/month\nPro $129/month\nSave $240 a year with annual billing");

  // 4. Danger zone: Delete workspace acts at once (real); Delete draft opens a confirmation dialog (look-alike).
  const delWs = control("button", "Delete workspace");
  const delDraft = control("button", "Delete draft");
  const danger = screen("danger-1", "/settings/danger", [delDraft, delWs], "Danger zone\nDelete draft\nDelete workspace");

  // 5. Onboarding: the intended next step is obvious and taken (look-alike: no next-step claim);
  //    the trial length contradicts the facts (real).
  const create = control("button", "Create project");
  const importBtn = control("button", "Import");
  const skip = control("link", "Skip for now");
  const docs = control("link", "Read the docs");
  const onboarding = screen("onboarding-1", "/onboarding", [create, importBtn, skip, docs], "Welcome\nStart your 7-day free trial\nCreate project\nImport\nSkip for now\nRead the docs");
  const onboardingSteps: SignalStep[] = [{ step: 1, op: "click", target: 'button "Create project"', actOk: true, url: onboarding.url }];

  return [
    {
      name: "admin queue without confirmation",
      screens: [queue],
      // The live probe clicks every DESTRUCTIVE control (the safety vocabulary): Delete user only.
      probes: [probe(queue, del, "none", ["DELETE /api/users/:id"])],
      steps: queueSteps,
      friction: queueFriction,
      jev: { "Reject repeated": { type: "destructive-unguarded", target: "Reject" } },
      mustCatch: { type: "destructive-unguarded", mentions: "Delete user" },
      mustNotFlag: "Reject",
    },
    {
      name: "a … control that already confirms",
      screens: [members, membersMenu],
      probes: [probe(members, removeAll, "none", ["DELETE /api/members"]), probe(membersMenu, removeItem, "native-dialog", [])],
      mustCatch: { type: "destructive-unguarded", mentions: "Remove all members" },
      mustNotFlag: '"Remove"',
    },
    {
      name: "a wrong price vs the product facts",
      screens: [pricing],
      probes: [],
      facts: PRICING_FACTS,
      mustCatch: { type: "fact-conflict", mentions: "$129" },
      mustNotFlag: "Starter",
    },
    {
      name: "a destructive action without a guard",
      screens: [danger],
      probes: [probe(danger, delDraft, "dom-dialog", []), probe(danger, delWs, "none", ["DELETE /api/workspace"])],
      mustCatch: { type: "destructive-unguarded", mentions: "Delete workspace" },
      mustNotFlag: "Delete draft",
    },
    {
      name: "an obvious-next-step page",
      screens: [onboarding],
      probes: [],
      facts: PRICING_FACTS,
      steps: onboardingSteps,
      mustCatch: { type: "fact-conflict", mentions: "7-day" },
      mustNotFlag: "Create project",
    },
  ];
}

function mentions(f: UxFinding): string {
  return JSON.stringify([f.observation, f.controls, f.quotes, f.claim?.target ?? "", f.contributing ?? []]);
}

async function run(fx: Fixture): Promise<{ outcome: Extract<AnalysisOutcome, { kind: "analyzed" }>; jev: ReturnType<typeof scriptedJev> }> {
  const jev = scriptedJev(fx.jev);
  const outcome = await analyzeClaims(
    {
      screens: fx.screens,
      rubric,
      appContext,
      judgmentBudget: 10,
      ...(fx.probes === undefined ? {} : { probes: fx.probes }),
      ...(fx.facts === undefined ? {} : { facts: fx.facts }),
      ...(fx.friction === undefined ? {} : { friction: fx.friction }),
      ...(fx.steps === undefined ? {} : { steps: fx.steps }),
    },
    { judge: jev },
  );
  if (outcome.kind !== "analyzed") throw new Error(`analysis failed: ${outcome.reason}`);
  return { outcome, jev };
}

describe("#198 acceptance: every planted problem caught, no look-alike flagged", () => {
  for (const fx of fixtures()) {
    it(fx.name, async () => {
      const { outcome } = await run(fx);
      const caught = outcome.findings.filter((f) => f.claim?.type === fx.mustCatch.type && mentions(f).includes(fx.mustCatch.mentions));
      expect(caught, JSON.stringify(outcome.findings.map((f) => f.observation))).toHaveLength(1);
      expect(caught[0]!.quality?.label).toBe("actionable");
      const flagged = outcome.findings.filter((f) => mentions(f).includes(fx.mustNotFlag));
      expect(flagged.map((f) => f.observation)).toEqual([]);
      // Every shown finding was verified by code, and its prose is the template's (no generation).
      for (const f of outcome.findings) {
        expect(f.claim?.verifiedBy).toBeTruthy();
        expect(f.observation).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    });
  }

  it("the admin queue's Reject claim is REFUTED by code (Reject is not destructive: the probe registry has no entry for it) and counted, not shown", async () => {
    const { outcome } = await run(fixtures()[0]!);
    const reject = outcome.claims!.items.find((i) => i.target?.includes("Reject"));
    expect(reject).toMatchObject({ type: "destructive-unguarded", source: "friction", status: "refuted" });
    expect(outcome.suppressed?.find((s) => s.reason === "unverified")?.detail).toMatch(/Reject|not a destructive control/);
  });

  it("the … menu's guarded Remove and the confirmed Delete draft are refuted with the guard named", async () => {
    const members = (await run(fixtures()[1]!)).outcome.claims!.items.find((i) => i.target === 'menuitem "Remove"');
    expect(members).toMatchObject({ status: "refuted" });
    expect(members!.reason).toMatch(/confirm dialog/);
    const draft = (await run(fixtures()[3]!)).outcome.claims!.items.find((i) => i.target === 'button "Delete draft"');
    expect(draft!.reason).toMatch(/dialog/);
  });

  it("the obvious next step is refuted (on the page, enabled, and taken) — not flagged as unclear", async () => {
    const { outcome } = await run(fixtures()[4]!);
    const next = outcome.claims!.items.find((i) => i.type === "next-step-unclear");
    expect(next).toMatchObject({ status: "refuted", source: "product-facts" });
    expect(next!.reason).toMatch(/run took it/);
  });
});

describe("#198: next-step claims verified by code", () => {
  it("an intended next step that no control names is caught; one present but disabled is caught as disabled", async () => {
    const facts = parseProductFacts({ version: 1, pages: [{ route: "/setup", nextStep: "Connect data source" }, { route: "/billing", nextStep: "Add card" }] });
    const setup = screen("setup-1", "/setup", [control("button", "Back"), control("link", "Help")], "Set up\nBack Help");
    const billing = screen("billing-1", "/billing", [control("button", "Add card", false)], "Billing\nAdd card");
    const outcome = await analyzeClaims({ screens: [setup, billing], rubric, appContext, judgmentBudget: 5, facts, probes: [] }, { judge: scriptedJev() });
    if (outcome.kind !== "analyzed") throw new Error(outcome.reason);
    expect(outcome.findings.map((f) => [f.route, f.claim?.type, f.claim?.verifiedBy, f.observation])).toEqual([
      ["/billing", "next-step-unclear", "product-facts", 'The intended next step button "Add card" on /billing is disabled.'],
      ["/setup", "next-step-unclear", "product-facts", '/setup does not offer the intended next step "Connect data source" (product facts): no control on the page names it.'],
    ]);
  });
});
