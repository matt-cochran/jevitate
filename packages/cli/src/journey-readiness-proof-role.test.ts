import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, journeyProofHash, type Journey } from "@jevitate/journey";
import { approveCatalogItem, loadCatalog } from "./catalog-api.js";
import { makeApprovalConfirm, type ApprovalConfirm } from "./approval-provenance.js";
import { promoteJourney } from "./journey-api.js";
import { buildJourneyReview, journeyReviewHash, renderReviewText, type JourneyVerifyRecord } from "./journey-review.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { writeVerifyRecord } from "./journey-review-store.js";
import { runJourneyReadiness } from "./journey-readiness.js";
import { withJourneyRunRecord } from "./journey-run-record.js";

/**
 * Owner decision "Proof role" (2026-11-09): job gates, proof advisory. `journey readiness` gates on the
 * latest run's `job.attainment` (doneCheckPolicy decides an `unverified` one); under the default
 * `mutationProofPolicy: advisory` a missing, stale or insensitive proof is the checks-strength line and
 * never blocks readiness or fails `review --strict`; `require-sensitive` still gates on it.
 * #808: an item only a person's approval settles is `awaiting-human`, not a strict-review loop.
 * #816: a proof is only blamed on a changed Journey when the Journey changed.
 */

let root: string;
let dir: string;
let stored: Journey;
const opts = () => ({ catalogDir: root, targetsFile: join(root, "targets.json") });
const readiness = () => runJourneyReadiness({ id: "sample", journeysDir: dir, ...opts() }, { cwd: () => root });
const confirm: ApprovalConfirm = async (request) => makeApprovalConfirm({ env: {}, stdinIsTTY: () => true, stdoutIsTTY: () => true, user: () => "offline-fixture", prompt: async () => request.id })(request);

async function project(config: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "project.json"), JSON.stringify(config));
}

async function proof(verdict: string, over: Partial<JourneyVerifyRecord> = {}): Promise<void> {
  const current = (await new FsJourneyStore(dir).get("sample"))!;
  await writeVerifyRecord(dir, { journeyId: "sample", contentHash: journeyReviewHash(current), proofHash: journeyProofHash(current), verdict, countsForGate: true, summary: { sensitive: 1, insensitive: verdict === "insensitive" ? 1 : 0, unpaired: 0 }, at: "2026-11-09T00:00:00Z", ...over });
}

/** One recorded run of the Journey as it stands, with this job verdict (as `journey run` writes it). */
async function ran(job: { attainment: string; basis: string } | undefined): Promise<void> {
  const current = (await new FsJourneyStore(dir).get("sample"))!;
  await withJourneyRunRecord({ channel: "cli", id: "sample", params: {}, logsRoot: join(root, "logs") }, async (recorder) => {
    recorder.noteJourney(current);
    return { outcome: "ok", ...(job === undefined ? {} : { job }) };
  });
}

beforeEach(async () => {
  // The suite turns run records off (vitest.config.ts); these tests are about them.
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  installClock(new FakeClock({ startMs: Date.UTC(2026, 10, 9, 12) }));
  root = await mkdtemp(join(tmpdir(), "jev-proof-role-"));
  dir = join(root, "journeys");
  await writeFile(join(root, "personas.json"), JSON.stringify({ operator: { description: "An operator reviews a sample report.", role: "Operator" } }));
  await writeFile(join(root, "jobs.json"), JSON.stringify([{ id: "inspect", trigger: "I open a sample report", motivation: "review its status", outcome: "I know the report result", personas: ["operator"] }]));
  await writeFile(join(root, "targets.json"), JSON.stringify({}));
  const journey: Journey = {
    metadata: {
      id: "sample", name: "Read sample", params: [], promoted: false, createdAtIso: "2026-11-07T00:00:00Z", job: "inspect", persona: "operator",
      anchors: [{ name: "report", step: 1 }], goal: "Read the sample report", successCriteria: [{ description: "The report status is Ready", check: { kind: "textIncludes", target: { testId: "status" }, text: "Ready" } }],
      endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Ready" } }],
    },
    recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "textIncludes", target: { testId: "status" }, text: "Ready" } }, objective: "Read the report", expectedResult: "The report is Ready" }] }] },
  };
  const store = new FsJourneyStore(dir);
  await store.put(journey);
  stored = (await store.get("sample"))!;
  stored.metadata.anchors![0]!.stepId = stored.recording.pages[0]!.steps[0]!.stepId;
  await store.put(stored);
  await approveCatalogItem("persona", await loadCatalog(root, dir), "operator", { confirm });
  await approveCatalogItem("job", await loadCatalog(root, dir), "inspect", { confirm });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetClock();
  await rm(root, { recursive: true, force: true });
});

const check = (r: Awaited<ReturnType<typeof readiness>>, name: string) => r.checks.find((c) => c.check === name);

describe("readiness gates on the job (owner decision: job gates)", () => {
  it("leads with the job: achieved on the latest run passes", async () => {
    await proof("sensitive");
    await ran({ attainment: "achieved", basis: "done-check" });
    const r = await readiness();
    expect(r.checks[0]).toMatchObject({ check: "job", state: "pass" });
    expect(r.verdict).toBe("technically-ready");
  });

  it("not-achieved blocks (exit 1), naming the run to fix", async () => {
    await proof("sensitive");
    await ran({ attainment: "not-achieved", basis: "done-check" });
    const r = await readiness();
    expect(check(r, "job")).toMatchObject({ state: "fail" });
    expect(r.verdict).toBe("blocked");
    expect(r.blockers.map((b) => b.check)).toEqual(["job"]);
  });

  it("unverified under doneCheckPolicy require (the default) gates with the reason and the fix (exit 2)", async () => {
    await proof("sensitive");
    let r = await readiness();
    expect(check(r, "job")).toMatchObject({ state: "not-run" });
    expect(r.verdict).toBe("incomplete");
    expect(r.blockers[0]).toMatchObject({ check: "job", why: "job attainment unverified: no run of this Journey is recorded" });
    await ran({ attainment: "unverified", basis: "no-check" });
    r = await readiness();
    expect(check(r, "job")).toMatchObject({ state: "inconclusive" });
    expect(r.verdict).toBe("inconclusive");
    expect(r.blockers[0]!.next).toMatch(/add a "done" check to the linked job in \.jevitate\/jobs\.json/);
    expect(r.next[0]).toBe(r.blockers[0]!.next);
  });

  it("unverified under doneCheckPolicy advisory shows and does not gate; a run record from before 0.30.0 reads unverified", async () => {
    await project({ doneCheckPolicy: "advisory" });
    await proof("sensitive");
    await ran(undefined);
    const r = await readiness();
    expect(check(r, "job")).toMatchObject({ state: "not-run", advisory: true });
    expect(check(r, "job")!.detail).toMatch(/^unverified \(not-recorded\)/);
    expect(r.verdict).toBe("technically-ready");
  });
});

describe("the proof is advisory by default (owner decision: proof advisory)", () => {
  it("a missing or insensitive proof neither blocks readiness nor fails review --strict", async () => {
    await ran({ attainment: "achieved", basis: "done-check" });
    let r = await readiness();
    expect(check(r, "proof")).toMatchObject({ state: "not-run", advisory: true });
    expect(r.verdict).toBe("technically-ready");
    await proof("insensitive");
    r = await readiness();
    expect(check(r, "proof")).toMatchObject({ state: "fail", advisory: true });
    expect(check(r, "proof")!.detail).toMatch(/advisory: checks strength only, it does not gate/);
    expect(r.verdict).toBe("technically-ready");
    expect(r.blockers).toEqual([]);
    const review = (await reviewJourneyById(dir, "sample", { ...opts(), strict: true, readiness: true })).review;
    expect(review.attention!.filter((a) => a.severity === "warn")).toEqual([]);
    expect(review.attention!.map((a) => a.text)).toContain("Checks strength: the mutation proof is insensitive (some checks cannot fail)");
  });

  it("an unwaived inconclusive proof does not gate either under advisory (owner clarification 2026-11-09); it does under require-sensitive", async () => {
    await ran({ attainment: "achieved", basis: "done-check" });
    await proof("inconclusive", { reason: "the unmutated replay failed" });
    let r = await readiness();
    expect(check(r, "proof")).toMatchObject({ state: "inconclusive", advisory: true });
    expect(r.verdict).toBe("technically-ready");
    const review = (await reviewJourneyById(dir, "sample", { ...opts(), strict: true, readiness: true })).review;
    expect(review.attention!.filter((a) => a.severity === "warn")).toEqual([]);
    await project({ mutationProofPolicy: "require-sensitive" });
    r = await readiness();
    expect(r.verdict).not.toBe("technically-ready");
    expect(r.blockers.map((b) => b.check)).toContain("proof");
  });

  it("under require-sensitive a missing or insensitive proof still blocks", async () => {
    await project({ mutationProofPolicy: "require-sensitive" });
    await ran({ attainment: "achieved", basis: "done-check" });
    const missing = await readiness();
    expect(missing.verdict).not.toBe("technically-ready");
    expect(missing.blockers.map((b) => b.check)).toContain("proof");
    await proof("insensitive");
    const r = await readiness();
    expect(r.verdict).toBe("blocked");
    expect(r.blockers.map((b) => b.check)).toContain("proof");
    const review = (await reviewJourneyById(dir, "sample", { ...opts(), strict: true })).review;
    expect(review.attention!.some((a) => a.severity === "warn" && /insensitive/.test(a.text))).toBe(true);
  });

  it("the review sheet leads with the job verdict, and the proof is a checks-strength line", async () => {
    await proof("sensitive");
    await ran({ attainment: "achieved", basis: "done-check" });
    const { review } = await reviewJourneyById(dir, "sample", opts());
    expect(review.job).toMatchObject({ attainment: "achieved", basis: "done-check", doneCheckPolicy: "require" });
    const sheet = renderReviewText(review, { color: false });
    const lines = sheet.split("\n");
    expect(lines.findIndex((l) => l.startsWith("Job "))).toBeLessThan(lines.findIndex((l) => /NEEDS YOUR ATTENTION/.test(l)));
    expect(sheet).toMatch(/checks strength: sensitive/);
  });
});

describe("#808: a stale approval with fresh evidence is a human handoff, not a strict-review loop", () => {
  async function renamedAfterPromotion(): Promise<void> {
    await proof("sensitive");
    await ran({ attainment: "achieved", basis: "done-check" });
    await promoteJourney(dir, "sample", { catalogDir: root, confirm });
    const current = (await new FsJourneyStore(dir).get("sample"))!;
    current.metadata.name = `${current.metadata.name} (renamed)`;
    await new FsJourneyStore(dir).put(current);
  }

  it("an approved, technically clean Journey passes strict review and is technically ready", async () => {
    await proof("sensitive");
    await ran({ attainment: "achieved", basis: "done-check" });
    await promoteJourney(dir, "sample", { catalogDir: root, confirm });
    expect((await reviewJourneyById(dir, "sample", { ...opts(), strict: true })).review.attention!.filter((a) => a.severity === "warn")).toEqual([]);
    const r = await readiness();
    expect(r.verdict).toBe("technically-ready");
    expect(r.awaitingHuman).toEqual([]);
  });

  it("a name-only change keeps strict review failing, but readiness hands over the owner's hash-bound commands", async () => {
    await renamedAfterPromotion();
    const { review } = await reviewJourneyById(dir, "sample", { ...opts(), strict: true });
    expect(review.proof.verify).toMatchObject({ stale: false, verdict: "sensitive" });
    expect(review.attention!.some((a) => a.severity === "warn")).toBe(true);
    const r = await readiness();
    expect(r.verdict).toBe("technically-ready");
    expect(check(r, "review-strict")).toMatchObject({ state: "awaiting-human" });
    expect(r.blockers).toEqual([]);
    expect(r.awaitingHuman.map((a) => a.next)).toContain(`jevitate journey promote sample --reviewed-hash ${review.contentHash}`);
    // Repeating strict review cannot clear it, so it is never the remedy offered.
    expect(r.next).not.toContain("jevitate journey review sample --strict");
  });

  it("a stale executable proof under require-sensitive stays technically blocked: no promote command", async () => {
    await project({ mutationProofPolicy: "require-sensitive" });
    await renamedAfterPromotion();
    const current = (await new FsJourneyStore(dir).get("sample"))!;
    current.metadata.endState = [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Done" } }];
    await new FsJourneyStore(dir).put(current);
    await ran({ attainment: "achieved", basis: "done-check" });
    const r = await readiness();
    expect(r.verdict).not.toBe("technically-ready");
    expect(r.next.some((n) => n.startsWith("jevitate journey promote"))).toBe(false);
  });
});

describe("#816: a proof is blamed on the Journey only when the Journey changed", () => {
  it("an unchanged Journey whose receipt another engine's proof identity wrote: stale cause engine, not 'the Journey changed'", async () => {
    await project({ mutationProofPolicy: "require-sensitive" });
    await proof("sensitive", { proofHash: "f".repeat(64), engine: { version: "0.28.3", commit: "78affb1" } });
    const { review } = await reviewJourneyById(dir, "sample", { ...opts(), strict: true });
    expect(review.proof.verify).toMatchObject({ stale: true, staleCause: "engine" });
    const warn = review.attention!.find((a) => /mutation proof/i.test(a.text))!;
    expect(warn).toMatchObject({ severity: "warn" });
    expect(warn.text).not.toMatch(/the Journey changed/);
    expect(warn.text).toMatch(/another jevitate engine/);
    expect(warn.hint).toMatch(/jevitate version that recorded the proof/);
    const r = await readiness();
    expect(check(r, "proof")!.detail).toMatch(/recorded by another jevitate engine: the Journey is unchanged/);
  });

  it("the engine cause is grounded in the receipt's stored producer; a receipt naming none is engine-unknown", async () => {
    await proof("sensitive", { proofHash: "f".repeat(64), engine: { version: "0.28.3", commit: "78affb1" } });
    let { review } = await reviewJourneyById(dir, "sample", opts());
    expect(review.proof.verify).toMatchObject({ staleCause: "engine", recordedBy: { version: "0.28.3", commit: "78affb1" } });
    expect(review.attention!.find((a) => /mutation proof/i.test(a.text))!.text).toContain("(0.28.3, 78affb1)");
    await proof("sensitive", { proofHash: "f".repeat(64) });
    ({ review } = await reviewJourneyById(dir, "sample", opts()));
    expect(review.proof.verify).toMatchObject({ staleCause: "engine-unknown" });
    expect(review.proof.verify).not.toHaveProperty("recordedBy");
  });

  it("under require-sensitive a current receipt that names no engine never counts; one that names it does", async () => {
    await project({ mutationProofPolicy: "require-sensitive" });
    await ran({ attainment: "achieved", basis: "done-check" });
    await proof("sensitive");
    let review = (await reviewJourneyById(dir, "sample", opts())).review;
    expect(review.proof.policy).toMatchObject({ passed: false });
    expect(review.proof.policy!.reason).toMatch(/does not say which engine recorded it/);
    expect((await readiness()).verdict).not.toBe("technically-ready");
    await proof("sensitive", { engine: { version: "0.30.0", commit: "abc1234" } });
    review = (await reviewJourneyById(dir, "sample", opts())).review;
    expect(review.proof.policy).toMatchObject({ passed: true });
    expect((await readiness()).verdict).toBe("technically-ready");
  });

  it("a Journey whose executable content changed is still 'the Journey changed'", async () => {
    await proof("sensitive");
    const current = (await new FsJourneyStore(dir).get("sample"))!;
    current.metadata.endState = [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Done" } }];
    await new FsJourneyStore(dir).put(current);
    const { review } = await reviewJourneyById(dir, "sample", opts());
    expect(review.proof.verify).toMatchObject({ stale: true, staleCause: "journey-changed" });
    expect(review.attention!.find((a) => /mutation proof/i.test(a.text))).toMatchObject({ severity: "info", text: "The mutation proof is out of date: the Journey changed after it ran" });
  });

  it("changed read requests are named as such", () => {
    const record: JourneyVerifyRecord = { journeyId: "sample", contentHash: journeyReviewHash(stored), proofHash: journeyProofHash(stored), verdict: "sensitive", summary: {}, at: "2026-11-09T00:00:00Z" };
    const review = buildJourneyReview(stored, { lastVerify: record, safety: { readRequests: ["POST /api/search"] } });
    expect(review.proof.verify).toMatchObject({ stale: true, staleCause: "read-policy" });
  });
});

it("never writes into the project while reviewing (read-only)", async () => {
  await proof("sensitive");
  const before = await readFile(join(dir, "sample.json"), "utf8").catch(() => null);
  await readiness();
  expect(await readFile(join(dir, "sample.json"), "utf8").catch(() => null)).toBe(before);
});
