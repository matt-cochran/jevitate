import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { annotationDraftPath, annotationStatus, approveJourneyAnnotations, confirmDemoAnnotations, journeyContentHash, previewJourneyAnnotations } from "./journey-annotate-api.js";

import * as journeyApi from "./journey-api.js";
import { approveCatalogItem, loadCatalog } from "./catalog-api.js";
import * as annotationApi from "./journey-annotate-api.js";
import * as demoReplay from "./journey-demo-api.js";
import { approveDemo, demoDraftPath } from "./demo-aspect-api.js";
import * as transactions from "./journey-annotation-approval-store.js";
import { journeyReviewHash } from "./journey-review.js";
import { makeApprovalConfirm, runAsMcpInvocation } from "./approval-provenance.js";
import { Command } from "commander";
import { registerJourneyAnnotateCommand } from "./journey-annotate-cli.js";
import type { CliDeps } from "./cli-shared.js";

vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

let dir: string;
const human = () => ({ env: {}, stdinIsTTY: () => true, stdoutIsTTY: () => true,
  prompt: vi.fn(async () => "sample"), user: () => "offline-test" });
const receiptPath = () => transactions.annotationApprovalPath(annotationDraftPath(dir, "sample"));
async function changeDraft(edit: (draft: Record<string, unknown>) => void) {
  const path = annotationDraftPath(dir, "sample");
  const draft = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  edit(draft);
  await writeFile(path, JSON.stringify(draft));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-annotation-approval-"));
  const journey: Journey = {
    metadata: { id: "sample", name: "Sample", promoted: false, params: [], createdAtIso: "2026-11-07T00:00:00Z" },
    recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [
      { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "Sample" } } } },
    ] }] },
  };
  const store = new FsJourneyStore(dir);
  await store.put(journey);
  const stored = (await store.get("sample"))!;
  await mkdir(join(dir, ".drafts"));
  await writeFile(annotationDraftPath(dir, "sample"), JSON.stringify({
    kind: "jevitate.journey-annotations.draft", version: 1, journeyId: "sample", journeyHash: journeyContentHash(stored),
    createdAtIso: "2026-11-07T00:00:00Z", provenance: { adapter: "human", model: "-", promptVersion: "1" },
    replay: { outcome: "completed", reachedSteps: 1, totalSteps: 1 }, goal: "Inspect the sample", steps: [],
  }));
  await writeFile(demoDraftPath(dir, "sample"), JSON.stringify({ kind: "jevitate.demo.draft", version: 1, id: "sample", aspect: "Inspect sample", env: "test", journeyHash: journeyContentHash(stored), createdAtIso: "2026-11-07T00:00:00Z", draft: {} }));
});
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await rm(dir, { recursive: true, force: true }); });

describe("native annotation approval without browser or model", () => {
  it("refuses a new API approval when no native terminal confirmation is supplied", async () => {
    const before = await readFile(join(dir, "sample.json"), "utf8");
    await expect(approveJourneyAnnotations(dir, "sample")).rejects.toMatchObject({ code: "E_APPROVAL_NEEDS_HUMAN" });
    expect(await readFile(join(dir, "sample.json"), "utf8")).toBe(before);
  });

  it("retains native approval after apply so a restarted wrapper does not need the consumed draft", async () => {
    // The old implementation ignores this third argument; the new native API must consume
    // actual confirmation dependencies, not a caller-supplied 'already approved' boolean.
    const options = { approval: { env: {}, stdinIsTTY: () => true, stdoutIsTTY: () => true,
      prompt: async () => "sample", user: () => "offline-test" } };
    await approveJourneyAnnotations(dir, "sample", options);
    await expect(approveJourneyAnnotations(dir, "sample")).resolves.toMatchObject({ id: "sample" });
  });
});

describe("annotation transaction fault boundaries", () => {
  it("native command refuses redirected approval and keeps Journey/draft bytes", async () => {
    const before = await readFile(join(dir, "sample.json"), "utf8");
    const program = new Command().exitOverride();
    const deps = { approval: { stdinIsTTY: () => false, stdoutIsTTY: () => false }, journeysDir: dir } as CliDeps;
    registerJourneyAnnotateCommand(program.command("journey"), program, deps);
    let output = "";
    program.configureOutput({ writeOut: (s) => { output += s; }, writeErr: () => {} });
    await program.parseAsync(["node", "jevitate", "journey", "annotate", "sample", "--dir", dir, "--approve", "--json"]);
    expect(output).toContain("E_APPROVAL_NEEDS_HUMAN");
    expect(await readFile(join(dir, "sample.json"), "utf8")).toBe(before);
    expect((await annotationStatus(dir, "sample")).state).toBe("pending-human");
  });

  it("shows the diff before one confirmation and resumes without prompting", async () => {
    const events: string[] = [];
    const approval = human();
    approval.prompt.mockImplementation(async () => { events.push("prompt"); return "sample"; });
    const status = await annotationStatus(dir, "sample");
    const result = await approveJourneyAnnotations(dir, "sample", { approval, reviewedHash: status.transaction!.hash, showChanges: () => { events.push("diff"); } });
    expect(events).toEqual(["diff", "prompt"]);
    expect(result.approval).toMatchObject({ phase: "applied", provenance: { channel: "tty", user: "offline-test" } });
    expect(result.changes.length).toBeGreaterThan(0);
    const again = await approveJourneyAnnotations(dir, "sample", { approval });
    expect(again.state).toBe("applied-current");
    expect(approval.prompt).toHaveBeenCalledTimes(1);
  });

  it.each(["wrong", ""])("refuses confirmation %j without a receipt", async (answer) => {
    const approval = human(); approval.prompt.mockResolvedValue(answer);
    await expect(approveJourneyAnnotations(dir, "sample", { approval })).rejects.toMatchObject({ code: "E_APPROVAL_NOT_CONFIRMED" });
    expect((await annotationStatus(dir, "sample")).approval).toBeNull();
  });

  it("refuses MCP even with injected terminal signals", async () => {
    const approval = human();
    await expect(runAsMcpInvocation(() => approveJourneyAnnotations(dir, "sample", { approval }))).rejects.toMatchObject({ code: "E_APPROVAL_NEEDS_HUMAN" });
    expect(approval.prompt).not.toHaveBeenCalled();
  });

  it("refuses stale reviewed hash without prompting", async () => {
    const approval = human();
    await expect(approveJourneyAnnotations(dir, "sample", { approval, reviewedHash: "0".repeat(64) })).rejects.toMatchObject({ code: "E_JOURNEY_ANNOTATIONS_TRANSACTION" });
    expect(approval.prompt).not.toHaveBeenCalled();
  });

  it.each(["draft", "journey"])("refuses %s changed during prompt", async (which) => {
    const approval = human();
    approval.prompt.mockImplementation(async () => {
      if (which === "draft") await changeDraft((d) => { d.goal = "A different reviewed goal"; });
      else { const store = new FsJourneyStore(dir); const j = (await store.get("sample"))!; j.metadata.name = "Changed concurrently"; await store.put(j); }
      return "sample";
    });
    await expect(approveJourneyAnnotations(dir, "sample", { approval })).rejects.toMatchObject({ code: "E_JOURNEY_ANNOTATIONS_TRANSACTION" });
    await expect(readFile(receiptPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["before-approved", "before-journey", "after-journey", "before-cleanup"])("recovers interruption %s without replaying a saved confirmation", async (boundary) => {
    const approval = human();
    const initial = await readFile(join(dir, "sample.json"), "utf8");
    if (boundary === "before-approved") vi.spyOn(transactions, "writeAnnotationApproval").mockRejectedValueOnce(new transactions.AnnotationTransactionError());
    if (boundary === "before-journey") vi.spyOn(FsJourneyStore.prototype, "putGuarded").mockRejectedValueOnce(new Error("injected"));
    if (boundary === "after-journey") {
      const original = transactions.writeAnnotationApproval;
      vi.spyOn(transactions, "writeAnnotationApproval").mockImplementation(async (...args) => {
        if (args[2].phase === "applied") throw new transactions.AnnotationTransactionError();
        return original(...args);
      });
    }
    if (boundary === "before-cleanup") vi.spyOn(transactions, "removeAnnotationDraft").mockRejectedValueOnce(new transactions.AnnotationTransactionError());
    await expect(approveJourneyAnnotations(dir, "sample", { approval })).rejects.toBeDefined();
    const state = await annotationStatus(dir, "sample");
    expect(state.state).toBe(boundary === "before-approved" ? "pending-human" : boundary === "before-cleanup" ? "applied-current" : "approved-pending-apply");
    const bytes = await readFile(join(dir, "sample.json"), "utf8");
    expect(() => JSON.parse(bytes)).not.toThrow();
    if (boundary === "before-approved" || boundary === "before-journey") expect(bytes).toBe(initial);
    vi.restoreAllMocks();
    const retry = human();
    expect((await approveJourneyAnnotations(dir, "sample", { approval: retry })).state).toBe("applied-current");
    expect(retry.prompt).toHaveBeenCalledTimes(boundary === "before-approved" ? 1 : 0);
  });

  it("refuses a conflicting writer after approval without overwriting its content", async () => {
    vi.spyOn(FsJourneyStore.prototype, "putGuarded").mockImplementationOnce(async (j, hash) => {
      const store = new FsJourneyStore(dir); const changed = (await store.get("sample"))!;
      changed.metadata.name = "Concurrent author"; await store.put(changed);
      vi.restoreAllMocks(); return store.putGuarded(j, hash);
    });
    await expect(approveJourneyAnnotations(dir, "sample", { approval: human() })).rejects.toBeDefined();
    expect((await new FsJourneyStore(dir).get("sample"))!.metadata.name).toBe("Concurrent author");
    expect((await annotationStatus(dir, "sample")).state).toBe("recovery-required");
    await expect(approveJourneyAnnotations(dir, "sample")).rejects.toBeDefined();
  });

  it.each(["draft", "receipt", "journey"])("refuses a symlinked %s", async (which) => {
    const path = which === "draft" ? annotationDraftPath(dir, "sample") : which === "receipt" ? receiptPath() : join(dir, "sample.json");
    const target = join(dir, "outside.json");
    await writeFile(target, which === "receipt" ? "{}" : await readFile(path));
    await rm(path, { force: true }); await symlink(target, path);
    const approval = human();
    await expect(approveJourneyAnnotations(dir, "sample", { approval })).rejects.toBeDefined();
    expect(approval.prompt).not.toHaveBeenCalled();
  });

  it.each(["{", '{"version":999}', '{"kind":"journey-annotation-approval","version":1}'])("rejects malformed or unsupported receipt %s", async (raw) => {
    await writeFile(receiptPath(), raw);
    expect((await annotationStatus(dir, "sample")).state).toBe("invalid");
    await expect(approveJourneyAnnotations(dir, "sample", { approval: human() })).rejects.toBeDefined();
  });

  it("requires confirmation even when the draft changes nothing", async () => {
    await changeDraft((d) => { delete d.goal; });
    const approval = human();
    const result = await approveJourneyAnnotations(dir, "sample", { approval });
    expect(result.changes).toEqual([]); expect(approval.prompt).toHaveBeenCalledTimes(1);
    expect(result.approval?.phase).toBe("applied");
  });

  it("recognizes applied approval after promotion bookkeeping without accepting wording changes", async () => {
    await approveJourneyAnnotations(dir, "sample", { approval: human() });
    const store = new FsJourneyStore(dir); const j = (await store.get("sample"))!;
    j.metadata.promoted = true;
    j.metadata.approval = { at: "2026-11-07T00:00:00Z", contentHash: journeyReviewHash(j), provenance: { channel: "tty", agentSignals: [] } };
    await store.put(j);
    expect((await annotationStatus(dir, "sample")).state).toBe("applied-current");
    j.metadata.goal = "Different intent"; await store.put(j);
    expect((await annotationStatus(dir, "sample")).state).toBe("stale");
  });

  it("uses native namespace/stable-ID normalization for the expected result", async () => {
    const store = new FsJourneyStore(dir); const j = (await store.get("sample"))!;
    j.metadata.id = "shared/sample"; await store.put(j);
    await mkdir(join(dir, ".drafts", "shared"));
    const draft = JSON.parse(await readFile(annotationDraftPath(dir, "sample"), "utf8"));
    draft.journeyId = "shared/sample"; draft.journeyHash = journeyContentHash((await store.get("shared/sample"))!);
    await writeFile(annotationDraftPath(dir, "shared/sample"), JSON.stringify(draft));
    const approval = human(); approval.prompt.mockResolvedValue("shared/sample");
    const result = await approveJourneyAnnotations(dir, "shared/sample", { approval });
    expect(result.state).toBe("applied-current");
    expect(JSON.parse(await readFile(join(dir, "shared", "sample.json"), "utf8")).metadata.id).toBe("sample");
    expect(result.transaction!.afterContentHash).toBe(journeyContentHash((await store.get("shared/sample"))!));
  });

  it("seals demo confirmation to the exact transaction and rejects lookalikes", async () => {
    const preview = await previewJourneyAnnotations(dir, "sample");
    const confirm = vi.fn(async () => ({ channel: "tty" as const, agentSignals: [] }));
    const authority = await confirmDemoAnnotations(dir, "sample", { kind: "demo", id: "sample", contentHash: preview.status.transaction!.afterReviewHash, waivers: [] }, confirm);
    await expect(approveJourneyAnnotations(dir, "sample", { demoAuthority: { ...authority } })).rejects.toBeDefined();
    expect((await approveJourneyAnnotations(dir, "sample", { demoAuthority: authority })).state).toBe("applied-current");
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("sealed native demo annotation authority", () => {
  it("retains existing explicit noninteractive demo provenance without making it human", async () => {
    const p = await previewJourneyAnnotations(dir, "sample");
    const authority = await confirmDemoAnnotations(dir, "sample", { kind: "demo", id: "sample", contentHash: p.status.transaction!.afterReviewHash, waivers: [] }, async () => ({ channel: "non-interactive", agentSignals: ["CODEX_TEST"], reason: "existing explicit demo test" }));
    const result = await approveJourneyAnnotations(dir, "sample", { demoAuthority: authority });
    expect(result.approval?.provenance).toMatchObject({ channel: "non-interactive", reason: "existing explicit demo test" });
    expect((await annotationStatus(dir, "sample")).approval?.provenance.channel).not.toBe("tty");
  });

  it("refuses a demo confirmation for a different proposed result before asking", async () => {
    const confirm = vi.fn(async () => ({ channel: "tty" as const, agentSignals: [] }));
    await expect(confirmDemoAnnotations(dir, "sample", { kind: "demo", id: "sample", contentHash: "0".repeat(64), waivers: [] }, confirm)).rejects.toBeDefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["during", "after"])("refuses a changed annotation result %s the demo confirmation", async (when) => {
    const p = await previewJourneyAnnotations(dir, "sample");
    const confirming = () => confirmDemoAnnotations(dir, "sample", { kind: "demo", id: "sample", contentHash: p.status.transaction!.afterReviewHash, waivers: [] }, async () => {
      if (when === "during") await changeDraft((d) => { d.goal = "Unseen annotation"; });
      return { channel: "tty", agentSignals: [] };
    });
    if (when === "during") await expect(confirming()).rejects.toBeDefined();
    else { const authority = await confirming(); await changeDraft((d) => { d.goal = "Unseen annotation"; }); await expect(approveJourneyAnnotations(dir, "sample", { demoAuthority: authority })).rejects.toBeDefined(); }
    expect((await new FsJourneyStore(dir).get("sample"))!.metadata.goal).toBeUndefined();
    await expect(readFile(receiptPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let a copied authority resume a nonhuman pending journal as a human", async () => {
    const p = await previewJourneyAnnotations(dir, "sample");
    const authority = await confirmDemoAnnotations(dir, "sample", { kind: "demo", id: "sample", contentHash: p.status.transaction!.afterReviewHash, waivers: [] }, async () => ({ channel: "non-interactive", agentSignals: [], reason: "existing demo" }));
    vi.spyOn(FsJourneyStore.prototype, "putGuarded").mockRejectedValueOnce(new Error("injected interruption"));
    await expect(approveJourneyAnnotations(dir, "sample", { demoAuthority: authority })).rejects.toBeDefined();
    await expect(approveJourneyAnnotations(dir, "sample", { demoAuthority: { ...authority } })).rejects.toMatchObject({ code: "E_JOURNEY_ANNOTATIONS_TRANSACTION" });
    await expect(approveJourneyAnnotations(dir, "sample")).rejects.toMatchObject({ code: "E_APPROVAL_NEEDS_HUMAN" });
    vi.restoreAllMocks();
    expect((await approveJourneyAnnotations(dir, "sample", { demoAuthority: authority })).approval?.provenance.channel).toBe("non-interactive");
  });
});

it("rejects a named-pipe draft without opening it or asking for approval", async () => {
  const path = annotationDraftPath(dir, "sample");
  const fifo = await fs.lstat(path);
  vi.spyOn(fifo, "isFile").mockReturnValue(false);
  vi.spyOn(fifo, "isFIFO").mockReturnValue(true);
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => String(args[0]) === path ? fifo : lstat(...args));
  const opening = vi.spyOn(fs, "open");
  const approval = human();
  await expect(approveJourneyAnnotations(dir, "sample", { approval })).rejects.toMatchObject({ code: "E_JOURNEY_ANNOTATIONS_TRANSACTION" });
  expect(approval.prompt).not.toHaveBeenCalled();
  expect(opening.mock.calls.some(([opened]) => String(opened) === path)).toBe(false);
});

it("returns a fixed failure without retaining raw persistence exception payloads", async () => {
  vi.spyOn(transactions, "writeAnnotationApproval").mockRejectedValueOnce(new Error("private-persistence-canary"));
  const error: unknown = await approveJourneyAnnotations(dir, "sample", { approval: human() }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(transactions.AnnotationTransactionError);
  expect(String(error)).not.toContain("private-persistence-canary");
  expect(error).not.toHaveProperty("cause");
});

it("native status command is read-only JSON and does not invoke confirmation", async () => {
  const before = await readFile(join(dir, "sample.json"), "utf8");
  const draftBefore = await readFile(annotationDraftPath(dir, "sample"), "utf8");
  const program = new Command().exitOverride(); const approval = human(); let output = "";
  registerJourneyAnnotateCommand(program.command("journey"), program, { approval, journeysDir: dir } as CliDeps);
  program.configureOutput({ writeOut: (s) => { output += s; }, writeErr: () => {} });
  await program.parseAsync(["node", "jevitate", "journey", "annotate", "sample", "--dir", dir, "--status", "--json"]);
  expect(JSON.parse(output)).toMatchObject({ ok: true, data: { kind: "journey-annotation-status", version: 1, state: "pending-human", approval: null } });
  expect(approval.prompt).not.toHaveBeenCalled();
  expect(await readFile(join(dir, "sample.json"), "utf8")).toBe(before);
  expect(await readFile(annotationDraftPath(dir, "sample"), "utf8")).toBe(draftBefore);
  await expect(readFile(receiptPath())).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not associate an older applied approval with a newly drafted transaction", async () => {
  await approveJourneyAnnotations(dir, "sample", { approval: human() });
  const previousReceipt = await readFile(receiptPath(), "utf8");
  const previous = await annotationStatus(dir, "sample");
  const current = (await new FsJourneyStore(dir).get("sample"))!;
  await writeFile(annotationDraftPath(dir, "sample"), JSON.stringify({
    kind: "jevitate.journey-annotations.draft", version: 1, journeyId: "sample", journeyHash: journeyContentHash(current),
    createdAtIso: "2026-11-07T01:00:00Z", provenance: { adapter: "human", model: "-", promptVersion: "1" },
    replay: { outcome: "completed", reachedSteps: 1, totalSteps: 1 }, goal: "A newly reviewed goal", steps: [],
  }));
  const status = await annotationStatus(dir, "sample");
  expect(status.state).toBe("pending-human");
  expect(status.transaction!.hash).not.toBe(previous.transaction!.hash);
  expect(status.approval).toBeNull();
  await expect(approveJourneyAnnotations(dir, "sample")).rejects.toMatchObject({ code: "E_APPROVAL_NEEDS_HUMAN" });
  expect(await readFile(receiptPath(), "utf8")).toBe(previousReceipt);
});

it("refuses a Journey changed after annotation apply before demo promotion", async () => {
  const current = (await new FsJourneyStore(dir).get("sample"))!;
  await writeFile(demoDraftPath(dir, "sample"), JSON.stringify({ kind: "jevitate.demo.draft", version: 1, id: "sample", aspect: "Inspect sample", env: "test", journeyHash: journeyContentHash(current), createdAtIso: "2026-11-07T00:00:00Z", draft: {} }));
  vi.spyOn(demoReplay, "demoJourney").mockResolvedValue({ id: "sample", outcome: "ok", totalSteps: 1, steps: [] });
  const apply = annotationApi.approveJourneyAnnotations;
  vi.spyOn(annotationApi, "approveJourneyAnnotations").mockImplementationOnce(async (...args) => {
    const result = await apply(...args);
    const store = new FsJourneyStore(dir); const changed = (await store.get("sample"))!;
    changed.metadata.goal = "A concurrent unreviewed goal"; await store.put(changed);
    return result;
  });
  await expect(approveDemo({ journeysDir: dir, id: "sample", outDir: join(dir, "output"), catalogDir: null,
    environment: { name: "test", baseUrl: "https://example.test", allowedOrigins: ["https://example.test"], source: "test" },
    confirm: async () => ({ channel: "tty", agentSignals: [] }),
  })).rejects.toBeDefined();
  const after = (await new FsJourneyStore(dir).get("sample"))!;
  expect(after.metadata.promoted).toBe(false);
  expect(after.metadata.approval).toBeUndefined();
});

it.each(["before-journey", "after-journey", "after-annotations", "after-promotion", "tty-before-journey"])("cold native demo resumes %s without an old capability or another confirmation", async (boundary) => {
  const current = (await new FsJourneyStore(dir).get("sample"))!;
  await writeFile(demoDraftPath(dir, "sample"), JSON.stringify({ kind: "jevitate.demo.draft", version: 1, id: "sample", aspect: "Inspect sample", env: "test", journeyHash: journeyContentHash(current), createdAtIso: "2026-11-07T00:00:00Z", draft: {} }));
  vi.spyOn(demoReplay, "demoJourney").mockResolvedValue({ id: "sample", outcome: "ok", totalSteps: 1, steps: [] });
  if (boundary === "before-journey" || boundary === "tty-before-journey") vi.spyOn(FsJourneyStore.prototype, "putGuarded").mockRejectedValueOnce(new Error("interrupted after approved journal"));
  if (boundary === "after-journey") {
    const write = transactions.writeAnnotationApproval;
    vi.spyOn(transactions, "writeAnnotationApproval").mockImplementation(async (...args) => {
      if (args[2].phase === "applied") throw new Error("interrupted before applied journal");
      return write(...args);
    });
  }
  if (boundary === "after-annotations") {
    const apply = annotationApi.approveJourneyAnnotations;
    vi.spyOn(annotationApi, "approveJourneyAnnotations").mockImplementationOnce(async (...args) => { await apply(...args); throw new Error("interrupted before promotion"); });
  }
  if (boundary === "after-promotion") {
    const promote = journeyApi.promoteJourney;
    vi.spyOn(journeyApi, "promoteJourney").mockImplementationOnce(async (...args) => { await promote(...args); throw new Error("interrupted before demo cleanup"); });
  }
  const options = { journeysDir: dir, id: "sample", outDir: join(dir, "output"), catalogDir: null,
    environment: { name: "test", baseUrl: "https://example.test", allowedOrigins: ["https://example.test"], source: "test" },
  };
  const tty = boundary === "tty-before-journey";
  const firstConfirm = tty ? makeApprovalConfirm(human()) : makeApprovalConfirm({ env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false }, { nonInteractiveReason: "explicit offline demo fixture" });
  await expect(approveDemo({ ...options, confirm: firstConfirm })).rejects.toBeDefined();
  expect(await annotationStatus(dir, "sample")).toMatchObject({ state: boundary === "after-annotations" || boundary === "after-promotion" ? "applied-current" : "approved-pending-apply", approval: { provenance: { channel: tty ? "tty" : "non-interactive" } } });
  if (!tty) await expect(approveJourneyAnnotations(dir, "sample")).rejects.toMatchObject({ code: "E_APPROVAL_NEEDS_HUMAN" });
  vi.restoreAllMocks();
  const freshRender = vi.fn(async () => ({ id: "sample", outcome: "ok", totalSteps: 1, steps: [] }));
  vi.doMock("./journey-demo-api.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./journey-demo-api.js")>(), demoJourney: freshRender }));
  vi.resetModules();
  try {
    const cold = await import("./demo-aspect-api.js");
    const confirm = vi.fn(async () => { throw new Error("saved approval must not prompt again"); });
    expect(cold.approveDemo).not.toBe(approveDemo);
    expect((await cold.approveDemo({ ...options, confirm })).outcome).toBe("approved");
    expect(confirm).not.toHaveBeenCalled();
    expect(freshRender).toHaveBeenCalledTimes(1);
    expect((await new FsJourneyStore(dir).get("sample"))!.metadata.approval?.provenance?.channel).toBe(tty ? "tty" : "non-interactive");
    await expect(readFile(demoDraftPath(dir, "sample"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { vi.doUnmock("./journey-demo-api.js"); vi.resetModules(); }
});

it.each(["unchanged", "changed"])("binds the final %s catalog waiver request to the original demo confirmation", async (mode) => {
  const catalogDir = join(dir, "catalog"); await mkdir(catalogDir);
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify({ operator: { description: "The report operator", role: "Operator" } }));
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([{ id: "inspect", trigger: "I open a report", motivation: "read its status", outcome: "I know the result", personas: ["operator"] }]));
  if (mode === "changed") {
    for (const kind of ["persona", "job"] as const) await approveCatalogItem(kind, await loadCatalog(catalogDir, dir), kind === "persona" ? "operator" : "inspect", { confirm: async (request) => makeApprovalConfirm({ ...human(), prompt: async () => request.id })(request) });
  }
  const store = new FsJourneyStore(dir); const current = (await store.get("sample"))!;
  current.metadata.job = "inspect"; current.metadata.persona = "operator";
  current.metadata.anchors = [{ name: "report", step: 1, stepId: current.recording.pages[0]!.steps[0]!.stepId }];
  await store.put(current);
  const hash = journeyContentHash((await store.get("sample"))!);
  await changeDraft((d) => { d.journeyHash = hash; });
  const demo = JSON.parse(await readFile(demoDraftPath(dir, "sample"), "utf8")); demo.journeyHash = hash;
  await writeFile(demoDraftPath(dir, "sample"), JSON.stringify(demo));
  vi.spyOn(demoReplay, "demoJourney").mockResolvedValue({ id: "sample", outcome: "ok", totalSteps: 1, steps: [] });
  if (mode === "changed") {
    const apply = annotationApi.approveJourneyAnnotations;
    vi.spyOn(annotationApi, "approveJourneyAnnotations").mockImplementationOnce(async (...args) => {
      const result = await apply(...args); const jobs = JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8"));
      jobs[0].trigger = "I reopen a changed report"; await writeFile(join(catalogDir, "jobs.json"), JSON.stringify(jobs)); return result;
    });
  }
  const call = approveDemo({ journeysDir: dir, id: "sample", outDir: join(dir, "output"), catalogDir, acceptUnvetted: "explicit fixture waiver",
    environment: { name: "test", baseUrl: "https://example.test", allowedOrigins: ["https://example.test"], source: "test" }, confirm: makeApprovalConfirm(human()),
  });
  if (mode === "changed") { await expect(call).rejects.toBeDefined(); expect((await store.get("sample"))!.metadata.promoted).toBe(false); }
  else { expect((await call).outcome).toBe("approved"); expect((await store.get("sample"))!.metadata.approval?.waivers).toHaveLength(1); }
});

it.each(["demo-draft", "annotation-draft", "waivers", "result", "transaction", "schema"])("refuses changed saved demo recovery %s without another confirmation", async (field) => {
  vi.spyOn(demoReplay, "demoJourney").mockResolvedValue({ id: "sample", outcome: "ok", totalSteps: 1, steps: [] });
  vi.spyOn(FsJourneyStore.prototype, "putGuarded").mockRejectedValueOnce(new Error("interrupted"));
  const options = { journeysDir: dir, id: "sample", outDir: join(dir, "output"), catalogDir: null,
    environment: { name: "test", baseUrl: "https://example.test", allowedOrigins: ["https://example.test"], source: "test" },
  };
  await expect(approveDemo({ ...options, confirm: makeApprovalConfirm({ env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false }, { nonInteractiveReason: "explicit offline fixture" }) })).rejects.toBeDefined();
  vi.restoreAllMocks();
  if (field === "demo-draft") {
    const demo = JSON.parse(await readFile(demoDraftPath(dir, "sample"), "utf8")); demo.aspect = "Changed context";
    await writeFile(demoDraftPath(dir, "sample"), JSON.stringify(demo));
  } else if (field === "annotation-draft") await changeDraft((d) => { d.goal = "Changed annotations"; });
  else {
    const record = JSON.parse(await readFile(receiptPath(), "utf8"));
    if (field === "waivers") record.origin.waivers.push({ flag: "--accept-unvetted", reason: "Unseen waiver" });
    if (field === "result") record.origin.reviewHash = "0".repeat(64);
    if (field === "transaction") record.transaction.hash = "0".repeat(64);
    if (field === "schema") record.version = 999;
    await writeFile(receiptPath(), JSON.stringify(record));
  }
  const before = await readFile(join(dir, "sample.json"), "utf8");
  const confirm = vi.fn(async () => { throw new Error("must refuse without new confirmation"); });
  const render = vi.spyOn(demoReplay, "demoJourney").mockRejectedValue(new Error("must not render"));
  await expect(approveDemo({ ...options, confirm })).rejects.toBeDefined();
  expect(confirm).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  expect(await readFile(join(dir, "sample.json"), "utf8")).toBe(before);
});

it("does not treat a standalone annotation journal as native demo consent", async () => {
  vi.spyOn(FsJourneyStore.prototype, "putGuarded").mockRejectedValueOnce(new Error("interrupted standalone approval"));
  await expect(approveJourneyAnnotations(dir, "sample", { approval: human() })).rejects.toBeDefined();
  vi.restoreAllMocks();
  const confirm = vi.fn(async () => { throw new Error("must not re-prompt"); });
  await expect(approveDemo({ journeysDir: dir, id: "sample", outDir: join(dir, "output"), catalogDir: null,
    environment: { name: "test", baseUrl: "https://example.test", allowedOrigins: ["https://example.test"], source: "test" }, confirm,
  })).rejects.toBeDefined();
  expect(confirm).not.toHaveBeenCalled();
});

it.each(["render", "promotion"])("preserves a demo record changed during %s", async (when) => {
  const changeDemo = async () => {
    const value = JSON.parse(await readFile(demoDraftPath(dir, "sample"), "utf8")); value.aspect = "Concurrent author";
    await writeFile(demoDraftPath(dir, "sample"), JSON.stringify(value));
  };
  vi.spyOn(demoReplay, "demoJourney").mockImplementation(async () => { if (when === "render") await changeDemo(); return { id: "sample", outcome: "ok", totalSteps: 1, steps: [] }; });
  if (when === "promotion") {
    const promote = journeyApi.promoteJourney;
    vi.spyOn(journeyApi, "promoteJourney").mockImplementationOnce(async (...args) => { const result = await promote(...args); await changeDemo(); return result; });
  }
  await expect(approveDemo({ journeysDir: dir, id: "sample", outDir: join(dir, "output"), catalogDir: null,
    environment: { name: "test", baseUrl: "https://example.test", allowedOrigins: ["https://example.test"], source: "test" }, confirm: makeApprovalConfirm(human()),
  })).rejects.toBeDefined();
  expect(JSON.parse(await readFile(demoDraftPath(dir, "sample"), "utf8")).aspect).toBe("Concurrent author");
  if (when === "render") expect((await new FsJourneyStore(dir).get("sample"))!.metadata.promoted).toBe(false);
});

it("rejects an applied record whose review hash contradicts its exact current after-content", async () => {
  await approveJourneyAnnotations(dir, "sample", { approval: human() });
  const record = JSON.parse(await readFile(receiptPath(), "utf8"));
  const fields = { draftHash: record.transaction.draftHash, beforeContentHash: record.transaction.beforeContentHash, afterContentHash: record.transaction.afterContentHash, afterReviewHash: "0".repeat(64) };
  record.transaction = transactions.annotationTransaction("sample", fields);
  await writeFile(receiptPath(), JSON.stringify(record));
  expect((await annotationStatus(dir, "sample")).state).toBe("invalid");
  await expect(approveJourneyAnnotations(dir, "sample")).rejects.toMatchObject({ code: "E_JOURNEY_ANNOTATIONS_TRANSACTION" });
});
