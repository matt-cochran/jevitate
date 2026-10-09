import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { JourneyProposalSchema, type Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import type { HealAttempt, ProposedRevisionDraft } from "@jevitate/runtime";
import { journeyReviewHash } from "./journey-review.js";
import {
  JourneyProposalInvalidError,
  JourneyProposalNotFoundError,
  JourneyProposalProofError,
  checkProposal,
  proposalPath,
  proposedJourney,
  readJourneyProposal,
  rejectJourneyProposal,
  rejectedProposalPath,
  requireJourneyProposal,
  writeJourneyProposal,
} from "./journey-proposal-store.js";

/** #453 — the proposed-revision sidecar: written beside the journeys, one pending per Journey, never a secret. */

const CLICK_BEFORE: Step = { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } };
const CLICK_AFTER: Step = { ...CLICK_BEFORE, kind: "click", target: { testId: "publish-now" } } as Step;
const FILL: Step = { kind: "fill", target: { label: "Title" }, value: { redacted: false, value: "TOPSECRET-LITERAL" }, expect: { kind: "visible", target: { label: "Title" } } };

function baseJourney(): Journey {
  return {
    metadata: { id: "pub", name: "Publish", promoted: false, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
    recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/editor", steps: [{ step: FILL }, { step: CLICK_BEFORE }] }] },
  };
}

function draftOf(base: Journey, after: Step = CLICK_AFTER): ProposedRevisionDraft {
  const page = base.recording.pages[0]!;
  return {
    recording: { ...base.recording, pages: [{ ...page, steps: [page.steps[0]!, { ...page.steps[1]!, step: after }] }] },
    steps: [
      {
        index: 1,
        before: CLICK_BEFORE,
        after,
        attempt: 1,
        hypothesis: "test id 'publish' → 'publish-now' (src/ui/Toolbar.tsx:42)",
        evidence: [{ id: "e1", kind: "test-id", before: "publish", after: "publish-now", file: "src/ui/Toolbar.tsx", line: 42 }],
      },
    ],
  };
}

const ATTEMPT: HealAttempt = {
  n: 1,
  stepIndex: 1,
  source: "change-evidence",
  hypothesis: "test id 'publish' → 'publish-now'",
  evidence: [{ id: "e1", kind: "test-id", before: "publish", after: "publish-now" }],
  candidate: CLICK_AFTER,
  observation: { screenshot: "logs/pub.heal/1.png" },
  result: "accepted",
  usage: { modelCalls: 0, ms: 5 },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-453c-"));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-09T10:00:00.000Z") }));
});
afterEach(() => resetClock());

const write = (base = baseJourney(), draft = draftOf(base)) =>
  writeJourneyProposal(dir, { journeyId: "pub", base, draft, attempts: [ATTEMPT], changes: { range: "main..HEAD", notes: ["renamed the publish button"] } });

describe("#453 writeJourneyProposal", () => {
  it("writes a schema-valid proposal at the sidecar path", async () => {
    const w = await write();
    expect(JourneyProposalSchema.safeParse(JSON.parse(await readFile(w.path, "utf8"))).success).toBe(true);
    expect(w.path).toBe(proposalPath(dir, "pub"));
  });

  it("names the proposal by a 12-hex id", async () => {
    expect((await write()).proposalId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("hides every literal value in the step diffs and the attempt log", async () => {
    const base = baseJourney();
    const fillAfter = { ...FILL, target: { label: "Headline" } } as Step;
    const draft: ProposedRevisionDraft = {
      recording: { ...base.recording, pages: [{ ...base.recording.pages[0]!, steps: [{ step: fillAfter }, base.recording.pages[0]!.steps[1]!] }] },
      steps: [{ index: 0, before: FILL, after: fillAfter, attempt: 1, hypothesis: "label renamed", evidence: [] }],
    };
    const w = await writeJourneyProposal(dir, { journeyId: "pub", base, draft, attempts: [{ ...ATTEMPT, stepIndex: 0, candidate: fillAfter }], changes: {} });
    const p = JSON.parse(await readFile(w.path, "utf8"));
    expect(JSON.stringify([p.steps, p.attempts]).includes("TOPSECRET-LITERAL")).toBe(false);
  });

  it("scrubs the run's secret values from every string", async () => {
    const base = baseJourney();
    const w = await writeJourneyProposal(dir, { journeyId: "pub", base, draft: draftOf(base), attempts: [ATTEMPT], changes: { notes: ["token hunter2 leaked"] }, secrets: ["hunter2"] });
    expect((await readFile(w.path, "utf8")).includes("hunter2")).toBe(false);
  });

  it("refuses a revision that changes an assertion", async () => {
    const base = baseJourney();
    const changed = { ...CLICK_AFTER, expect: { kind: "textIncludes", target: { role: "status" }, text: "Whatever" } } as Step;
    await expect(write(base, draftOf(base, changed))).rejects.toBeInstanceOf(JourneyProposalProofError);
  });

  it("writes nothing when it refuses", async () => {
    const base = baseJourney();
    const changed = { ...CLICK_AFTER, expect: { kind: "visible", target: { testId: "x" } } } as Step;
    await write(base, draftOf(base, changed)).catch(() => undefined);
    expect(existsSync(proposalPath(dir, "pub"))).toBe(false);
  });

  it("keeps one pending proposal per Journey, naming the one it replaced", async () => {
    const first = await write();
    const base = baseJourney();
    const other = { ...CLICK_BEFORE, target: { testId: "publish-2" } } as Step;
    const second = await write(base, draftOf(base, other));
    expect(second.supersededProposal).toBe(first.proposalId);
  });
});

describe("#453 readJourneyProposal / requireJourneyProposal", () => {
  it("reads back the id that was written", async () => {
    const w = await write();
    expect((await readJourneyProposal(dir, "pub"))?.proposalId).toBe(w.proposalId);
  });

  it("is null when none is pending", async () => {
    expect(await readJourneyProposal(dir, "pub")).toBeNull();
  });

  it("refuses an unknown proposal id as not found", async () => {
    await write();
    await expect(requireJourneyProposal(dir, "pub", "aaaaaaaaaaaa")).rejects.toBeInstanceOf(JourneyProposalNotFoundError);
  });

  it("refuses an edited file whose hash no longer matches", async () => {
    const w = await write();
    const file = JSON.parse(await readFile(w.path, "utf8"));
    file.proposedHash = "0".repeat(64);
    await writeFile(w.path, JSON.stringify(file));
    expect(checkProposal(baseJourney(), (await readJourneyProposal(dir, "pub"))!)).toBeInstanceOf(JourneyProposalProofError);
  });
});

describe("#453 rejectJourneyProposal", () => {
  const provenance = { channel: "tty" as const, agentSignals: [], user: "mc" };

  it("moves the file to .rejected", async () => {
    const w = await write();
    await rejectJourneyProposal(dir, "pub", w.proposalId, { reason: "wrong button", provenance });
    expect([existsSync(proposalPath(dir, "pub")), existsSync(rejectedProposalPath(dir, "pub", w.proposalId))]).toEqual([false, true]);
  });

  it("records the reason and provenance", async () => {
    const w = await write();
    await rejectJourneyProposal(dir, "pub", w.proposalId, { reason: "wrong button", provenance });
    const rec = JSON.parse(await readFile(rejectedProposalPath(dir, "pub", w.proposalId), "utf8"));
    expect([rec.reason, rec.provenance.user, rec.rejectedAt]).toEqual(["wrong button", "mc", "2026-10-09T10:00:00.000Z"]);
  });
});

describe("#453 review: the heal floor holds on write, read and accept", () => {
  /** The pending proposal with its recording's step 2 replaced by `after`, its hash recomputed (a hand edit). */
  async function editedTo(after: Step, base = baseJourney()) {
    await write(base);
    const p = (await readJourneyProposal(dir, "pub"))!;
    const page = p.recording.pages[0]!;
    const recording = { ...p.recording, pages: [{ ...page, steps: [page.steps[0]!, { ...page.steps[1]!, step: after }] }] };
    return { ...p, recording, proposedHash: journeyReviewHash(proposedJourney(base, { recording })) };
  }

  it("refuses to accept a proposal edited to retarget a click onto a destructive control", async () => {
    const edited = await editedTo({ ...CLICK_BEFORE, target: { role: "button", name: "Delete account" } } as Step);
    expect(checkProposal(baseJourney(), edited)).toBeInstanceOf(JourneyProposalProofError);
  });

  it("refuses to store a retargeted click whose recorded expectRequests expect a POST", async () => {
    const base = baseJourney();
    const page = base.recording.pages[0]!;
    base.recording = { ...base.recording, pages: [{ ...page, steps: [page.steps[0]!, { ...page.steps[1]!, expectRequests: [{ kind: "requestMade", method: "POST", pathGlob: "/api/publish" }] }] }] };
    const draft = draftOf(base);
    await expect(writeJourneyProposal(dir, { journeyId: "pub", base, draft, attempts: [ATTEMPT], changes: {} })).rejects.toBeInstanceOf(JourneyProposalProofError);
  });

  it("refuses to accept a proposal whose retargeted navigate leaves the Journey's origin", async () => {
    const nav: Step = { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { testId: "editor" } } };
    const base = baseJourney();
    const page = base.recording.pages[0]!;
    base.recording = { ...base.recording, pages: [{ ...page, steps: [page.steps[0]!, { step: nav }] }] };
    const draft: ProposedRevisionDraft = {
      recording: { ...base.recording, pages: [{ ...page, steps: [page.steps[0]!, { step: { ...nav, url: "/editor-2" } as Step }] }] },
      steps: [{ index: 1, before: nav, after: { ...nav, url: "/editor-2" } as Step, attempt: 1, hypothesis: "route renamed", evidence: [] }],
    };
    await writeJourneyProposal(dir, { journeyId: "pub", base, draft, attempts: [ATTEMPT], changes: {} });
    const p = (await readJourneyProposal(dir, "pub"))!;
    const recording = { ...p.recording, pages: [{ ...p.recording.pages[0]!, steps: [p.recording.pages[0]!.steps[0]!, { step: { ...nav, url: "https://evil.test/editor" } as Step }] }] };
    const edited = { ...p, recording, proposedHash: journeyReviewHash(proposedJourney(base, { recording })) };
    expect(checkProposal(base, edited)).toBeInstanceOf(JourneyProposalProofError);
  });
});

describe("#453 review: proposals are never read or written through a symbolic link", () => {
  it("refuses to write when .proposals is a symlink", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "jev-453-elsewhere-"));
    await symlink(elsewhere, join(dir, ".proposals"), "dir");
    await expect(write()).rejects.toBeInstanceOf(JourneyProposalInvalidError);
  });

  it("refuses to read a proposal file that is a symlink", async () => {
    const w = await write();
    const target = join(dir, "real.json");
    await writeFile(target, await readFile(w.path, "utf8"));
    await mkdir(join(dir, ".proposals", "x"), { recursive: true });
    await symlink(target, join(dir, ".proposals", "x", "pub.json"));
    await expect(readJourneyProposal(dir, "x/pub")).rejects.toBeInstanceOf(JourneyProposalInvalidError);
  });
});

describe("#453 review: committed proposals hold no credential", () => {
  it("scrubs a credential-shaped value from a change note and a hypothesis", async () => {
    const base = baseJourney();
    const key = "sk-live0123456789abcdefABCDEF";
    const draft = draftOf(base);
    const w = await writeJourneyProposal(dir, { journeyId: "pub", base, draft: { ...draft, steps: [{ ...draft.steps[0]!, hypothesis: `label pasted ${key}` }] }, attempts: [ATTEMPT], changes: { notes: [`rotated ${key}`] } });
    expect((await readFile(w.path, "utf8")).includes(key)).toBe(false);
  });
});

describe("#467 step ids in proposals", () => {
  const withIds = (): Journey => {
    const base = baseJourney();
    const page = base.recording.pages[0]!;
    return { ...base, recording: { ...base.recording, pages: [{ ...page, steps: [{ ...page.steps[0]!, stepId: "s-fill01" }, { ...page.steps[1]!, stepId: "s-click1" }] }] } };
  };
  const namedDraft = (base: Journey, stepId: string): ProposedRevisionDraft => {
    const d = draftOf(base);
    return { ...d, steps: d.steps.map((s) => ({ ...s, stepId })) };
  };

  it("keeps the healed step's id in the proposed recording", async () => {
    const base = withIds();
    await write(base, namedDraft(base, "s-click1"));
    expect((await readJourneyProposal(dir, "pub"))?.recording.pages[0]!.steps[1]!.stepId).toBe("s-click1");
  });

  it("names each changed step by its stepId beside its index", async () => {
    const base = withIds();
    await write(base, namedDraft(base, "s-click1"));
    expect((await readJourneyProposal(dir, "pub"))?.steps[0]).toMatchObject({ index: 1, stepId: "s-click1" });
  });

  it("carries the broken step's stepId on each attempt", async () => {
    const base = withIds();
    await writeJourneyProposal(dir, { journeyId: "pub", base, draft: namedDraft(base, "s-click1"), attempts: [{ ...ATTEMPT, stepId: "s-click1" }], changes: {} });
    expect((await readJourneyProposal(dir, "pub"))?.attempts[0]?.stepId).toBe("s-click1");
  });

  it("refuses a proposal whose step id is not the stored step's at that index", async () => {
    const base = withIds();
    await expect(write(base, namedDraft(base, "s-fill01"))).rejects.toBeInstanceOf(JourneyProposalProofError);
  });

  it("checkProposal refuses a pending proposal whose step id was edited", async () => {
    const base = withIds();
    await write(base, namedDraft(base, "s-click1"));
    const p = (await readJourneyProposal(dir, "pub"))!;
    expect(checkProposal(base, { ...p, steps: p.steps.map((s) => ({ ...s, stepId: "s-other1" })) })).toBeInstanceOf(JourneyProposalProofError);
  });
});
