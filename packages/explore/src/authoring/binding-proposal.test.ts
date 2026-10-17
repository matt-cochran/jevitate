import { describe, expect, test } from "vitest";
import type { RecordedStep, Recording } from "@jevitate/recording";
import { JourneySchema } from "@jevitate/journey";
import type { AuthoringTake } from "./binding-proposal.js";
import { BindingProposalError, proposeBindings } from "./binding-proposal.js";

/**
 * Two fictional takes of a comment-reply flow: sign in (username + password), open a thread, the
 * page shows the thread id in an attribute and a subject line, fill the reply, choose the account to
 * reply as, click Send. Thread, subject, reply and account differ between the takes; the password
 * (deliberately captured as a value here, as a mis-recorded secret would be) does not.
 */
const PASSWORD = "Hunter2-correct-horse";

interface TakeSpec {
  thread: string;
  subject: string;
  reply: string;
  account: string;
  summary?: string;
}

function take(t: TakeSpec): AuthoringTake {
  const thread: RecordedStep[] = [
    {
      stepId: "s-open",
      step: {
        kind: "navigate",
        url: `https://app.example.test/threads/${t.thread}`,
        expect: { kind: "attr", target: { testId: "thread-header" }, name: "data-thread-id", value: t.thread },
      },
    },
    { stepId: "s-subj", step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "thread-subject" }, text: t.subject } } },
    {
      stepId: "s-reply",
      step: { kind: "fill", target: { label: "Reply" }, value: { redacted: true, length: t.reply.length }, expect: { kind: "valueEquals", target: { label: "Reply" }, value: t.reply } },
    },
    ...(t.summary === undefined
      ? []
      : [
          {
            stepId: "s-summary",
            step: { kind: "fill", target: { label: "Summary" }, value: { redacted: true, length: t.summary.length }, expect: { kind: "visible", target: { label: "Summary" } } },
          } satisfies RecordedStep,
        ]),
    {
      stepId: "s-account",
      step: { kind: "select", target: { label: "Account" }, value: { redacted: true, length: t.account.length }, expect: { kind: "visible", target: { label: "Account" } } },
    },
    { stepId: "s-send", step: { kind: "click", target: { role: "button", name: "Send" }, expect: { kind: "visible", target: { testId: "sent-toast" } } } },
  ];
  const recording: Recording = {
    version: "1.0",
    site: "https://app.example.test",
    intent: "Reply to a support thread",
    startedAtIso: "2026-10-17T00:00:00.000Z",
    pages: [
      {
        url: "https://app.example.test/login",
        steps: [
          { stepId: "s-user", step: { kind: "fill", target: { label: "Username" }, value: { redacted: true, length: 18 }, expect: { kind: "visible", target: { label: "Username" } } } },
          { stepId: "s-pass", step: { kind: "fill", target: { label: "Password" }, value: { redacted: true, length: PASSWORD.length }, expect: { kind: "visible", target: { label: "Password" } } } },
          { stepId: "s-signin", step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "urlIncludes", text: "/threads" } } },
        ],
      },
      { url: `https://app.example.test/threads/${t.thread}`, steps: thread },
    ],
  };
  const values: Record<string, string> = { "s-user": "agent@example.test", "s-pass": PASSWORD, "s-reply": t.reply, "s-account": t.account };
  if (t.summary !== undefined) values["s-summary"] = t.summary;
  return { recording, values };
}

const TAKE_A: TakeSpec = { thread: "T-1042", subject: "Billing question", reply: "Thanks — we refunded the duplicate charge.", account: "acct-support" };
const TAKE_B: TakeSpec = { thread: "T-2077", subject: "Shipping delay", reply: "Your parcel ships on Monday.", account: "acct-billing" };

const proposal = proposeBindings([take(TAKE_A), take(TAKE_B)]);
const draftSteps = (proposal.draft?.recording.pages ?? []).flatMap((p) => p.steps);
const draftIndex = (stepId: string): number => draftSteps.findIndex((s) => s.stepId === stepId);

describe("proposeBindings over two takes of a reply flow", () => {
  test("names the reply text as a text parameter", () => {
    expect(proposal.params.find((p) => p.stepIds.includes("s-reply"))).toMatchObject({ name: "reply", kind: "text" });
  });

  test("names the account choice as a select parameter", () => {
    expect(proposal.params.find((p) => p.stepIds.includes("s-account"))).toMatchObject({ name: "account", kind: "select" });
  });

  test("names the thread in the URL as a url parameter", () => {
    expect(proposal.params.find((p) => p.stepIds.includes("s-open"))).toMatchObject({ name: "thread", kind: "url" });
  });

  // The thread id is an OUTPUT: the page shows it in an attribute before the first write, and in
  // every take it equals that take's thread parameter — so it is both extracted and checked.
  test("proposes the thread id shown in the header as an extract output tied to the thread parameter", () => {
    expect(proposal.outputs).toEqual([expect.objectContaining({ key: "thread_id", fromStepId: "s-open", attr: "data-thread-id", tiedTo: "thread" })]);
  });

  test("places the identity check on the thread before the first fill", () => {
    const identity = proposal.checks.find((c) => c.reason === "identity");
    expect(draftIndex(identity?.stepId ?? "")).toBeLessThan(draftIndex("s-reply"));
  });

  test("tags the identity check pre-write with a {var} operand", () => {
    expect(proposal.checks.find((c) => c.reason === "identity")).toMatchObject({
      phase: "pre-write",
      assertion: { kind: "attr", name: "data-thread-id", value: { var: "thread" } },
    });
  });

  test("checks the composer holds exactly the supplied reply after filling", () => {
    expect(proposal.checks.find((c) => c.stepId === "s-reply")).toMatchObject({
      phase: "post-write",
      assertion: { kind: "valueEquals", target: { label: "Reply" }, value: { var: "reply" } },
    });
  });

  test("stops before the Send step", () => {
    expect(proposal.stopBefore).toBe("s-send");
  });

  test("treats the password field as a handback, never a constant", () => {
    expect(proposal.handbacks).toContainEqual({ stepId: "s-pass", reason: "credential-field" });
  });

  test("treats the username beside a password as a credential handback", () => {
    expect(proposal.handbacks).toContainEqual({ stepId: "s-user", reason: "credential-context" });
  });

  test("never carries the password anywhere in the proposal", () => {
    expect(JSON.stringify(proposal)).not.toContain(PASSWORD);
  });

  test("never carries the typed reply text anywhere in the proposal evidence", () => {
    expect(JSON.stringify({ ...proposal, draft: undefined })).not.toContain(TAKE_A.reply);
  });

  test("leaves the subject line that varies but is tied to no parameter for human review", () => {
    expect(proposal.ambiguities).toContainEqual(expect.objectContaining({ kind: "untied-observation", stepIds: ["s-subj"] }));
  });

  test("produces a draft the Journey schema accepts", () => {
    expect(JourneySchema.safeParse(proposal.draft).success).toBe(true);
  });

  test("ends the draft before the Send step", () => {
    expect(draftSteps.map((s) => s.stepId)).not.toContain("s-send");
  });

  test("does not promote the draft", () => {
    expect(proposal.draft?.metadata.promoted).toBe(false);
  });

  test("gives the draft no approval", () => {
    expect(proposal.draft?.metadata.approval).toBeUndefined();
  });

  test("templates the thread navigation with the thread parameter in the draft", () => {
    expect(draftSteps[draftIndex("s-open")]?.step).toMatchObject({ url: "https://app.example.test/threads/${thread}" });
  });

  test("extracts the thread id right after the step that observed it in the draft", () => {
    expect(draftSteps[draftIndex("s-open") + 1]?.step).toMatchObject({ kind: "extract", as: "thread_id", attr: "data-thread-id" });
  });

  test("is deterministic for the same takes", () => {
    expect(JSON.stringify(proposeBindings([take(TAKE_A), take(TAKE_B)]))).toBe(JSON.stringify(proposal));
  });
});

describe("proposeBindings refusals and ambiguity", () => {
  test("refuses fewer than two takes", () => {
    expect(() => proposeBindings([take(TAKE_A)])).toThrow(expect.objectContaining({ code: "E_PROPOSAL_TOO_FEW_TAKES" }) as BindingProposalError);
  });

  test("refuses takes that did not record the same steps", () => {
    const short = take(TAKE_B);
    short.recording.pages[1].steps.splice(1, 1);
    expect(() => proposeBindings([take(TAKE_A), short])).toThrow(expect.objectContaining({ code: "E_PROPOSAL_MISALIGNED" }) as BindingProposalError);
  });

  test("reports two parameters that took the same value in every take as ambiguous", () => {
    const p = proposeBindings([take({ ...TAKE_A, summary: TAKE_A.reply }), take({ ...TAKE_B, summary: TAKE_B.reply })]);
    expect(p.ambiguities).toContainEqual(expect.objectContaining({ kind: "identical-param-columns", stepIds: ["s-reply", "s-summary"] }));
  });
});

// #564: the proposal's credential test is the recorder's shared `isSecretField` pattern.
describe("proposeBindings — the shared credential pattern (#564)", () => {
  function relabel(t: AuthoringTake, label: string): AuthoringTake {
    const recording = structuredClone(t.recording);
    for (const s of recording.pages.flatMap((p) => p.steps)) {
      if (s.stepId === "s-pass" && s.step.kind === "fill") s.step.target = { label };
    }
    return { recording, values: t.values };
  }

  test("a 'Security code' field is a credential handback", () => {
    const p = proposeBindings([relabel(take(TAKE_A), "Security code"), relabel(take(TAKE_B), "Security code")]);
    expect(p.handbacks).toContainEqual({ stepId: "s-pass", reason: "credential-field" });
  });

  test("a look-alike ('Pinned note') is not", () => {
    const p = proposeBindings([relabel(take(TAKE_A), "Pinned note"), relabel(take(TAKE_B), "Pinned note")]);
    expect(p.handbacks).not.toContainEqual({ stepId: "s-pass", reason: "credential-field" });
  });
});
