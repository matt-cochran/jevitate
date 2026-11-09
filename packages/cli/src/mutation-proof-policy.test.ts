import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, journeyProofHash, JourneyReviewSchema, type Journey } from "@jevitate/journey";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { ProfileManager } from "@jevitate/daemon";
import { buildJourneyReview, journeyReviewHash, renderReviewText, type JourneyVerifyRecord } from "./journey-review.js";
import { evaluateMutationProofPolicy, mutationReceiptDigest, ProofWaiverSchema, type ProofWaiver } from "./mutation-proof-policy.js";
import { journeyProofContext, journeyProofHashForContext, type JourneyProofContext } from "./journey-proof-context.js";
import { readProofWaiver, writeVerifyRecord, proofWaiverPath } from "./journey-review-store.js";
import { buildProgram } from "./program.js";
import { runAsMcpInvocation, type ApprovalDeps } from "./approval-provenance.js";
import { loadProjectConfig } from "./project-config.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { runJourneyReadiness } from "./journey-readiness.js";

function journey(): Journey {
  return { metadata: { id: "read", name: "Read", params: [], promoted: false, createdAtIso: "2026-10-26T00:00:00Z", goal: "Read status", successCriteria: [{ description: "Status is ready" }], endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Ready" } }] }, recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [] }] } };
}
function record(j = journey(), summary = { sensitive: 0, unpaired: 5, cascade: 0 }): JourneyVerifyRecord {
  return { journeyId: j.metadata.id, contentHash: journeyReviewHash(j), proofHash: journeyProofHash(j), verdict: "inconclusive", summary, at: "2026-10-26T00:00:00Z" };
}
function waiver(j = journey(), r = record(j)): ProofWaiver {
  return { v: 1, journeyId: j.metadata.id, contentHash: journeyReviewHash(j), proofHash: journeyProofHash(j), receiptDigest: mutationReceiptDigest(r), reason: "Read-only fixture is covered by a separate release check", at: "2026-10-26T00:01:00Z", provenance: { channel: "tty", agentSignals: [], user: "reviewer" } };
}
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "jev-708-")); installClock(new FakeClock({ startMs: Date.parse("2026-10-26T01:00:00Z") })); });
afterEach(() => { resetClock(); process.exitCode = undefined; });

describe("a proof is bound to the target's read requests", () => {
  const readRequests = ["/api/estimate"];
  const proved = (j: Journey, proofContext?: JourneyProofContext): JourneyVerifyRecord => ({ ...record(j), ...(proofContext === undefined ? {} : { proofContext }), proofHash: journeyProofHashForContext(j, proofContext) });
  const fresh = (rec: JourneyVerifyRecord, current?: readonly string[]): string => evaluateMutationProofPolicy({ journey: journey(), contentHash: journeyReviewHash(journey()), record: rec, ...(current === undefined ? {} : { readRequests: current }) }).freshness;

  it("a receipt records them, in one order, and none at all leaves it as it was", () => {
    expect(journeyProofContext(undefined, undefined, ["/b", "/a", "/a"])).toEqual({ readRequests: ["/a", "/b"] });
    expect(journeyProofContext(undefined, undefined, [])).toBeUndefined();
    expect(journeyProofContext(undefined, undefined, undefined)).toBeUndefined();
  });

  it("adding one, changing one or dropping one stales the receipt; the same set in another order does not", () => {
    const j = journey();
    const none = proved(j);
    const some = proved(j, journeyProofContext(undefined, undefined, readRequests));
    expect(fresh(none)).toBe("fresh");
    expect(fresh(none, readRequests)).toBe("stale");
    expect(fresh(some, readRequests)).toBe("fresh");
    expect(fresh(some, ["/api/other"])).toBe("stale");
    expect(fresh(some)).toBe("stale");
    const two = proved(j, journeyProofContext(undefined, undefined, ["/a", "/b"]));
    expect(fresh(two, ["/b", "/a"])).toBe("fresh");
  });

  it("the review sheet reads the target's current ones, and its browser context still counts", () => {
    const j = journey();
    const emulation = { device: "iPhone 15" };
    const rec = proved(j, journeyProofContext(undefined, emulation, readRequests));
    expect(rec.proofContext).toEqual({ emulation, readRequests });
    expect(buildJourneyReview(j, { lastVerify: rec, safety: { readRequests } }).proof.verify).toMatchObject({ stale: false });
    expect(buildJourneyReview(j, { lastVerify: rec, safety: { readRequests: ["/api/other"] } }).proof.verify).toMatchObject({ stale: true });
    expect(buildJourneyReview(j, { lastVerify: rec }).proof.policy?.freshness).toBe("stale");
  });

  it("journey review over a real targets file: changing it after the proof stales the proof", async () => {
    const dir = join(root, "journeys");
    const targetsFile = join(root, "targets.json");
    const j = journey();
    await new FsJourneyStore(dir).put(j);
    const write = (list: readonly string[]): Promise<void> => writeFile(targetsFile, JSON.stringify({ [new URL(j.recording.site).origin]: { safety: { readRequests: list } } }));
    await writeVerifyRecord(dir, proved(j, journeyProofContext(undefined, undefined, readRequests)));
    await write(readRequests);
    expect((await reviewJourneyById(dir, j.metadata.id, { targetsFile, catalogDir: null })).review.proof.policy?.freshness).toBe("fresh");
    await write(["/api/other"]);
    expect((await reviewJourneyById(dir, j.metadata.id, { targetsFile, catalogDir: null })).review.proof.policy?.freshness).toBe("stale");
  });
});

describe("#708 shared mutation proof policy", () => {
  for (const summary of [{ sensitive: 0, unpaired: 5, cascade: 0 }, { sensitive: 6, unpaired: 0, cascade: 1 }]) {
    for (const mode of ["advisory", "require-attempt", "require-sensitive"] as const) {
      it(`handles reported shape ${JSON.stringify(summary)} under ${mode} in JSON and text`, () => {
        const j = journey(); const r = record(j, summary);
        const review = buildJourneyReview(j, { lastVerify: r, proofPolicy: mode });
        expect(JourneyReviewSchema.parse(review).proof.policy?.passed).toBe(mode === "advisory");
        expect(review.attention?.some((a) => a.severity === "warn" && a.text.includes("Mutation proof policy"))).toBe(mode !== "advisory");
        expect(renderReviewText(review)).not.toMatch(/mutation proof inconclusive ✓/);
        expect(renderReviewText(review)).toContain("inconclusive");
      });
    }
  }
  it("classifies zero-sensitive unpaired read-only Journeys explicitly", () => {
    expect(evaluateMutationProofPolicy({ journey: journey(), contentHash: journeyReviewHash(journey()), record: record() }).classification).toBe("non-mutation-testable");
  });
  it("a fresh inconclusive waiver satisfies require-attempt but cannot override require-sensitive", () => {
    for (const mode of ["advisory", "require-attempt", "require-sensitive"] as const) {
      const p = evaluateMutationProofPolicy({ journey: journey(), contentHash: journeyReviewHash(journey()), record: record(), mode, waiver: waiver() });
      expect(p.waiver.status).toBe("valid"); expect(p.passed).toBe(mode !== "require-sensitive");
    }
  });
  it.each(["contentHash", "proofHash", "receiptDigest"] as const)("rejects stale waiver %s", (key) => {
    const p = evaluateMutationProofPolicy({ journey: journey(), contentHash: journeyReviewHash(journey()), record: record(), mode: "require-attempt", waiver: { ...waiver(), [key]: "f".repeat(64) } });
    expect(p.passed).toBe(false); expect(p.waiver.status).toBe("stale"); expect(p.waiverRequired).toBe(true);
  });
  it("re-running the same proof invalidates the old waiver and changes the public digest", () => {
    const base = { journey: journey(), contentHash: journeyReviewHash(journey()), mode: "require-attempt" as const, waiver: waiver() };
    const old = evaluateMutationProofPolicy({ ...base, record: record() });
    const next = evaluateMutationProofPolicy({ ...base, record: { ...record(), at: "2026-10-26T00:02:00Z" } });
    expect(next.passed).toBe(false); expect(next.digest).not.toBe(old.digest);
  });
  it("keeps its public digest stable across JSON key order and changes it for policy drift", () => {
    const input = { journey: journey(), contentHash: journeyReviewHash(journey()), record: record() };
    const base = evaluateMutationProofPolicy(input);
    expect(evaluateMutationProofPolicy({ ...input, record: { ...record(), summary: { cascade: 0, unpaired: 5, sensitive: 0 } } }).digest).toBe(base.digest);
    expect(evaluateMutationProofPolicy({ ...input, mode: "require-sensitive" }).digest).not.toBe(base.digest);
  });
  it("only fresh sensitive receipts that count for the gate, and name their engine (#816), satisfy require-sensitive", () => {
    const j = journey(); const h = journeyReviewHash(j);
    const engine = { version: "0.30.0", commit: "abc1234" };
    expect(evaluateMutationProofPolicy({ journey: j, contentHash: h, mode: "require-sensitive", record: { ...record(), verdict: "sensitive", countsForGate: true, engine } }).passed).toBe(true);
    for (const r of [null, { ...record(), verdict: "sensitive", countsForGate: true }, { ...record(), verdict: "insensitive" }, { ...record(), verdict: "sensitive", countsForGate: true, proofHash: "f".repeat(64) }, { ...record(), verdict: "sensitive", countsForGate: false }]) expect(evaluateMutationProofPolicy({ journey: j, contentHash: h, mode: "require-sensitive", record: r, waiver: waiver() }).passed).toBe(false);
  });
  it("review and policy both reject a receipt recorded for another Journey", () => {
    const review = buildJourneyReview(journey(), { proofPolicy: "require-sensitive", lastVerify: { ...record(), journeyId: "other", verdict: "sensitive" } });
    expect(review.proof.verify.status === "recorded" && review.proof.verify.stale).toBe(true);
    expect(review.proof.policy?.freshness).toBe("stale");
    expect(renderReviewText(review)).not.toContain("checks strength: sensitive ✓");
  });
  it("binds proof-plan changes even when the receipt and waiver are unchanged", () => {
    const j = journey(); j.metadata.endState = [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Other" } }];
    const p = evaluateMutationProofPolicy({ journey: j, contentHash: journeyReviewHash(j), mode: "require-attempt", record: record(), waiver: waiver() });
    expect(p.freshness).toBe("stale"); expect(p.passed).toBe(false);
  });
  it.each(["mcp", "ci", "non-interactive"])("rejects %s provenance in persisted waivers", (channel) => {
    expect(ProofWaiverSchema.safeParse({ ...waiver(), provenance: { channel, agentSignals: [] } }).success).toBe(false);
  });
  it("config rejects unknown policy instead of silently weakening it", async () => {
    await writeFile(join(root, "project.json"), JSON.stringify({ mutationProofPolicy: "relaxed" }));
    expect(() => loadProjectConfig(root)).toThrow("mutationProofPolicy");
  });
});

describe("#708 terminal-only waiver", () => {
  async function invoke(approval: ApprovalDeps, reason = "read-only release receipt reviewed", mcp = false, proof = record()) {
    const dir = join(root, "journeys"); await new FsJourneyStore(dir).put(journey()); await writeVerifyRecord(dir, proof);
    let out = ""; let err = "";
    const p = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), journeysDir: dir, approval });
    p.configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { err += s; } }); p.exitOverride();
    const run = () => p.parseAsync(["journey", "waive-proof", "read", "--reason", reason], { from: "user" }).then(() => undefined);
    if (mcp) await runAsMcpInvocation(run); else await run();
    return { out, err, dir, waiver: await readProofWaiver(dir, "read") };
  }
  const human = (): ApprovalDeps => ({ env: {}, stdinIsTTY: () => true, stdoutIsTTY: () => true, prompt: async () => "read", user: () => "reviewer" });
  it("records exact hashes, reason and typed-terminal provenance", async () => {
    const r = await invoke(human()); expect(process.exitCode).toBe(0); expect(r.waiver?.receiptDigest).toBe(mutationReceiptDigest(record())); expect(r.waiver?.provenance.channel).toBe("tty");
  });
  it("refuses MCP even when the host has a terminal", async () => { const r = await invoke(human(), "reviewed", true); expect(r.waiver).toBeNull(); expect(process.exitCode).toBe(64); });
  it("refuses CI even with a terminal", async () => { const r = await invoke({ ...human(), env: { CI: "true" } }); expect(r.waiver).toBeNull(); expect(process.exitCode).toBe(64); });
  it("refuses noninteractive confirmation", async () => { const r = await invoke({ ...human(), stdinIsTTY: () => false }); expect(r.waiver).toBeNull(); expect(process.exitCode).toBe(64); });
  it("refuses blank reasons", async () => { const r = await invoke(human(), " "); expect(r.waiver).toBeNull(); expect(process.exitCode).toBe(64); });
  it("refuses an incorrect typed confirmation", async () => { const r = await invoke({ ...human(), prompt: async () => "wrong" }); expect(r.waiver).toBeNull(); expect(process.exitCode).toBe(64); });
  it("refuses a stale attempt before requesting confirmation", async () => {
    let prompts = 0;
    const r = await invoke({ ...human(), prompt: async () => { prompts++; return "read"; } }, "reviewed", false, { ...record(), proofHash: "f".repeat(64) });
    expect(r.waiver).toBeNull(); expect(process.exitCode).toBe(64); expect(prompts).toBe(0);
  });
  it("refuses when the proof changes during terminal confirmation", async () => {
    const r = await invoke({ ...human(), prompt: async () => { await writeVerifyRecord(join(root, "journeys"), { ...record(), at: "2026-10-26T00:02:00Z" }); return "read"; } });
    expect(r.waiver).toBeNull(); expect(process.exitCode).toBe(64);
  });
  it("fails closed for malformed waiver sidecars", async () => {
    const dir = join(root, "journeys"); await mkdir(join(dir, ".proof-waivers"), { recursive: true }); await writeFile(proofWaiverPath(dir, "read"), JSON.stringify({ ...waiver(), reason: "" }));
    await expect(readProofWaiver(dir, "read")).rejects.toThrow("valid human mutation-proof waiver");
  });
  it("read API and readiness use the project policy and exact waiver", async () => {
    const r = await invoke(human()); await writeFile(join(root, "project.json"), JSON.stringify({ mutationProofPolicy: "require-attempt" }));
    const reviewed = await reviewJourneyById(r.dir, "read", { catalogDir: root });
    expect(reviewed.review.proof.policy?.passed).toBe(true);
    const receipt = await runJourneyReadiness({ id: "read", journeysDir: r.dir, catalogDir: root });
    expect(receipt.checks.find((c) => c.check === "proof")?.state).toBe("pass");
  });
});
