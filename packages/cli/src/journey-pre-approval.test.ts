import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Command } from "commander";
import { FsJourneyStore, journeyProofHash, type Journey } from "@jevitate/journey";
import { approveCatalogItem, loadCatalog } from "./catalog-api.js";
import { makeApprovalConfirm, type ApprovalConfirm } from "./approval-provenance.js";
import { promoteJourney } from "./journey-api.js";
import { approveJourneyAnnotations } from "./journey-annotate-api.js";
import { journeyPreApproval } from "./journey-pre-approval.js";
import { annotationDraftPath, journeyContentHash } from "./journey-annotate-api.js";
import { journeyReviewHash } from "./journey-review.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { writeVerifyRecord } from "./journey-review-store.js";
import { registerJourneyReview } from "./journey-cli/review.js";
import { registerPreApprovalAnalyzer } from "./pre-approval.js";
import type { CliDeps } from "./cli-shared.js";

let root: string;
let dir: string;
let unregister: Array<() => void>;
let stored: Journey;
const opts = () => ({ catalogDir: root, targetsFile: join(root, "targets.json") });
async function bytes(): Promise<Record<string, string>> {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const result: Record<string, string> = {};
  for (const file of files) if (file.isFile()) {
    const path = join(file.parentPath, file.name); result[relative(root, path)] = await readFile(path, "utf8");
  }
  return result;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-preapproval-")); dir = join(root, "journeys"); unregister = [];
  await writeFile(join(root, "personas.json"), JSON.stringify({ operator: { description: "An operator reviews a sample report.", role: "Operator" } }));
  await writeFile(join(root, "jobs.json"), JSON.stringify([{ id: "inspect", trigger: "I open a sample report", motivation: "review its status", outcome: "I know the report result", personas: ["operator"] }]));
  await writeFile(join(root, "targets.json"), JSON.stringify({}));
  const journey: Journey = {
    metadata: { id: "sample", name: "Read sample", params: [], promoted: false, createdAtIso: "2026-11-07T00:00:00Z", job: "inspect", persona: "operator",
      anchors: [{ name: "report", step: 1 }], goal: "Read the sample report", successCriteria: [{ description: "The report status is Ready", check: { kind: "textIncludes", target: { testId: "status" }, text: "Ready" } }],
      endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Ready" } }] },
    recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [{
      step: { kind: "navigate", url: "/", expect: { kind: "textIncludes", target: { testId: "status" }, text: "Ready" } },
      objective: "Read the report", expectedResult: "The report is Ready",
    }] }] },
  };
  const store = new FsJourneyStore(dir); await store.put(journey); stored = (await store.get("sample"))!;
  stored.metadata.anchors![0]!.stepId = stored.recording.pages[0]!.steps[0]!.stepId;
  await store.put(stored); stored = (await store.get("sample"))!;
  await writeVerifyRecord(dir, { journeyId: "sample", contentHash: journeyReviewHash(stored), proofHash: journeyProofHash(stored), verdict: "sensitive", summary: { sensitive: 1, insensitive: 0, unpaired: 0 }, at: "2026-11-07T00:00:00Z" });
});
afterEach(async () => { for (const stop of unregister) stop(); vi.restoreAllMocks(); process.exitCode = 0; await rm(root, { recursive: true, force: true }); });

async function draft(extra: Record<string, unknown> = {}) {
  await mkdir(join(dir, ".drafts"), { recursive: true });
  await writeFile(annotationDraftPath(dir, "sample"), JSON.stringify({
    kind: "jevitate.journey-annotations.draft", version: 1, journeyId: "sample", journeyHash: journeyContentHash(stored),
    createdAtIso: "2026-11-07T00:00:00Z", provenance: { adapter: "human", model: "-", promptVersion: "1" },
    replay: { outcome: "completed", reachedSteps: 1, totalSteps: 1 }, steps: [], goal: "Inspect the report status", ...extra,
  }));
}

describe("native read-only pre-approval projection", () => {
  it("separates pending owner actions from proof, preserving strict warnings and all native bytes", async () => {
    await draft(); const before = await bytes();
    const result = await journeyPreApproval(dir, "sample", opts());
    expect(result.blockers, JSON.stringify(result.review.attention)).toEqual([]);
    expect(result.readyForOwnerReview).toBe(true);
    expect(result.pendingActions.map((a) => a.kind)).toEqual(["persona-approve", "job-approve", "annotation-approve", "journey-promote"]);
    expect(result.candidate.source).toBe("annotation");
    expect(result.review.proof.verify).toMatchObject({ status: "recorded", stale: false, verdict: "sensitive" });
    expect((await reviewJourneyById(dir, "sample", { ...opts(), strict: true })).review.attention!.filter((a) => a.severity === "warn").length).toBeGreaterThan(0);
    expect(await bytes()).toEqual(before);
  });

  it("uses current candidate without fabricating missing historical annotation evidence", async () => {
    const result = await journeyPreApproval(dir, "sample", opts());
    expect(result.candidate).toMatchObject({ source: "current", annotationTransactionHash: null });
    expect(result.pendingActions.map((a) => a.kind)).not.toContain("annotation-approve");
  });

  it("blocks a candidate that removes an executable success check with a stale native proof", async () => {
    await draft({ successCriteria: ["The revised status is Complete"] });
    const result = await journeyPreApproval(dir, "sample", opts());
    expect(result.review.proof.verify).toMatchObject({ status: "recorded", stale: true });
    expect(result.readyForOwnerReview).toBe(false);
    expect(result.blockers.some((b) => b.code === "journey-attention")).toBe(true);
  });

  it.each(["missing-persona", "unknown-persona", "weak", "no-goal", "stale-proof"])("blocks %s alongside pending catalog approvals", async (failure) => {
    const changed = structuredClone(stored);
    if (failure === "missing-persona") delete changed.metadata.persona;
    if (failure === "unknown-persona") changed.metadata.persona = "absent";
    if (failure === "weak") changed.metadata.endState = [{ kind: "page", assertion: { kind: "visible", target: { testId: "status" } } }];
    if (failure === "no-goal") delete changed.metadata.goal;
    if (failure === "stale-proof") changed.metadata.endState = [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Other" } }];
    await new FsJourneyStore(dir).put(changed);
    expect((await journeyPreApproval(dir, "sample", opts())).readyForOwnerReview).toBe(false);
  });

  it("blocks malformed annotation status rather than falling back to current Journey", async () => {
    await draft(); await writeFile(annotationDraftPath(dir, "sample"), "{");
    const result = await journeyPreApproval(dir, "sample", opts());
    expect(result.blockers).toContainEqual({ code: "annotation-state", subject: { kind: "journey", id: "sample" }, index: null });
  });

  it("blocks unknown future warnings without inspecting their text", async () => {
    unregister.push(registerPreApprovalAnalyzer({ id: "future", appliesTo: ["journey"], analyze: () => [{ analyzer: "future", code: "new-warning", severity: "warn", requiresAcknowledgment: false, message: "Unvetted catalog links: owner will approve" }] }));
    const result = await journeyPreApproval(dir, "sample", opts());
    expect(result.readyForOwnerReview).toBe(false);
    expect(result.review.attention!.find((a) => a.text === "Unvetted catalog links: owner will approve")?.ownerActions).toBeUndefined();
  });

  it("blocks a registered analyzer impersonating a native catalog owner finding", async () => {
    unregister.push(registerPreApprovalAnalyzer({ id: "catalog-links", appliesTo: ["journey"], analyze: () => [{ analyzer: "catalog-links", code: "journey.unvetted", severity: "warn", requiresAcknowledgment: false, message: "Untrusted warning" }] }));
    const result = await journeyPreApproval(dir, "sample", opts());
    expect(result.readyForOwnerReview).toBe(false);
    expect(result.review.attention!.find((a) => a.text === "Untrusted warning")?.ownerActions).toBeUndefined();
  });

  it("refuses identity changes between the two read-only snapshots", async () => {
    let reads = 0;
    unregister.push(registerPreApprovalAnalyzer({ id: "mutating-test-boundary", appliesTo: ["journey"], async analyze() {
      if (++reads === 2) await new FsJourneyStore(dir).put({ ...stored, metadata: { ...stored.metadata, name: "Concurrent author" } });
      return [];
    } }));
    // Current native bytes are reloaded on each snapshot. Mutating at a later read must never
    // return a projection claiming the prior identity is still current.
    await expect(journeyPreApproval(dir, "sample", opts())).rejects.toBeDefined();
  });

  it("native command returns the distinct projection and rejects mixed flags", async () => {
    const program = new Command().exitOverride(); let output = "";
    program.configureOutput({ writeOut: (s) => { output += s; }, writeErr: () => {} });
    registerJourneyReview(program.command("journey"), program, { catalogDir: root, journeysDir: dir, targetsFile: join(root, "targets.json") } as CliDeps);
    await program.parseAsync(["node", "jevitate", "journey", "review", "sample", "--dir", dir, "--pre-approval", "--json"]);
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: { kind: "journey-pre-approval", version: 1 } });
    expect(JSON.parse(output).strict).toBeUndefined();
    output = "";
    await program.parseAsync(["node", "jevitate", "journey", "review", "sample", "--dir", dir, "--pre-approval", "--strict", "--json"]);
    expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: "E_JOURNEY_REVIEW_ARGS" } });
  });
});

const nativeFixtureConfirm: ApprovalConfirm = async (request) => makeApprovalConfirm({ env: {}, stdinIsTTY: () => true, stdoutIsTTY: () => true, user: () => "offline-fixture", prompt: async () => request.id })(request);
async function approveCatalogFixture() {
  await approveCatalogItem("persona", await loadCatalog(root, dir), "operator", { confirm: nativeFixtureConfirm });
  await approveCatalogItem("job", await loadCatalog(root, dir), "inspect", { confirm: nativeFixtureConfirm });
}

describe("owner queue and final native strict review remain distinct", () => {
  it("finishes only after actual native fixture confirmations and emits no redundant catalog action", async () => {
    await draft(); await approveCatalogFixture();
    const before = await journeyPreApproval(dir, "sample", opts());
    expect(before.pendingActions.map((a) => a.kind)).toEqual(["annotation-approve", "journey-promote"]);
    expect(before.readyForOwnerReview).toBe(true);
    await approveJourneyAnnotations(dir, "sample", { approval: { env: {}, stdinIsTTY: () => true, stdoutIsTTY: () => true, prompt: async () => "sample" } });
    await promoteJourney(dir, "sample", { catalogDir: root, confirm: nativeFixtureConfirm });
    const review = (await reviewJourneyById(dir, "sample", { ...opts(), strict: true })).review;
    expect(review.attention!.filter((a) => a.severity === "warn")).toEqual([]);
    const finished = await journeyPreApproval(dir, "sample", opts());
    expect(finished.readyForOwnerReview).toBe(true);
    expect(finished.pendingActions).toEqual([]);
  });

  it("reports stale native catalog and changed Journey approval as owner actions without hiding defects", async () => {
    await approveCatalogFixture();
    await promoteJourney(dir, "sample", { catalogDir: root, confirm: nativeFixtureConfirm });
    const jobs = JSON.parse(await readFile(join(root, "jobs.json"), "utf8"));
    jobs[0].trigger = "I reopen the sample report";
    await writeFile(join(root, "jobs.json"), JSON.stringify(jobs));
    const current = (await new FsJourneyStore(dir).get("sample"))!;
    current.metadata.goal = "Read the revised report description";
    await new FsJourneyStore(dir).put(current);
    const projection = await journeyPreApproval(dir, "sample", opts());
    expect(projection.readyForOwnerReview).toBe(true);
    expect(projection.pendingActions.map((a) => a.kind)).toEqual(["job-approve", "journey-promote"]);
    current.metadata.endState = [{ kind: "page", assertion: { kind: "visible", target: { testId: "status" } } }];
    await new FsJourneyStore(dir).put(current);
    expect((await journeyPreApproval(dir, "sample", opts())).readyForOwnerReview).toBe(false);
  });

  it("loads additional personas served by the job and blocks unknown references", async () => {
    const jobs = JSON.parse(await readFile(join(root, "jobs.json"), "utf8")); jobs[0].personas.push("absent");
    await writeFile(join(root, "jobs.json"), JSON.stringify(jobs));
    const result = await journeyPreApproval(dir, "sample", opts());
    expect(result.readyForOwnerReview).toBe(false);
    expect(result.blockers.some((b) => b.code === "catalog-finding" || b.code === "catalog-reference")).toBe(true);
  });

  it("blocks analysis errors, never treating a pending owner as a waiver", async () => {
    unregister.push(registerPreApprovalAnalyzer({ id: "broken-test-analyzer", appliesTo: ["job"], analyze() { throw new Error("offline injected failure"); } }));
    const result = await journeyPreApproval(dir, "sample", opts());
    expect(result.readyForOwnerReview).toBe(false);
    expect(result.blockers.some((b) => b.code === "catalog-finding")).toBe(true);
  });
});

it("blocks a differently named analyzer forging a built-in stale-job finding", async () => {
  await approveCatalogFixture();
  const jobs = JSON.parse(await readFile(join(root, "jobs.json"), "utf8"));
  jobs[0].trigger = "I reopen the sample report";
  await writeFile(join(root, "jobs.json"), JSON.stringify(jobs));
  unregister.push(registerPreApprovalAnalyzer({ id: "future-producer", appliesTo: ["job"], analyze: () => [{ analyzer: "catalog-links", code: "job.changed", severity: "warn", requiresAcknowledgment: false, message: "Untrusted producer pretending to be built in" }] }));
  const result = await journeyPreApproval(dir, "sample", opts());
  expect(result.readyForOwnerReview).toBe(false);
  expect(result.blockers.some((b) => b.code === "catalog-finding")).toBe(true);
});
