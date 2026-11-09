import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsInboxStore } from "@jevitate/inbox";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { ProfileManager } from "@jevitate/daemon";
import type { Locator } from "playwright";
import { runAsMcpInvocation } from "./approval-provenance.js";
import {
  approveHoldAtTerminal,
  checkHoldForResume,
  HoldError,
  HoldRecordSchema,
  heldOutcomeOf,
  holdRecordPath,
  readHoldRecord,
  registerHoldHooks,
  type HoldRecord,
} from "./journey-hold.js";
import { maskCheckpointUrl, readRunCheckpoint, restoreCheckpointUrl, writeRunCheckpoint } from "./journey-run-checkpoint.js";
import { asProof, E_HUMAN_STEP_IN_PROOF, ProofHoldRefusedError, RunHeldError, proofHoldRefusalBody, registerRunHooks, resetRunHooksForTests, runBeforeWriteHooks } from "./journey-run-hooks.js";
import { createCheckpointKey } from "./journey-verify-checkpoint.js";
import { callMcpTool, mcpToolDeps } from "./mcp-cli-bridge.js";
import { buildProgram } from "./program.js";

/**
 * #793/#799 unit acceptance: a hold is durable, value-free and signed; only a person at a terminal
 * answers it (approve_action over MCP refuses and never touches the file); a resume refuses
 * `E_HOLD_BINDING` for each binding that changed; an expired hold is `E_HOLD_EXPIRED`.
 */

const MARKER = "MARKER_REF-5521";
const SITE = "https://shop.test";
const T0 = Date.parse("2026-11-08T12:00:00.000Z");

let root: string;
let holdsDir: string;
let inboxDir: string;
let journeysDir: string;
let keyFile: string;
let clockNow: FakeClock;

function journey(label = "Checkout"): Journey {
  return {
    metadata: { id: "checkout", name: "Checkout", promoted: true, params: ["ref"], createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: {
      version: "1",
      site: SITE,
      pages: [
        {
          url: "/shop",
          steps: [
            { step: { kind: "navigate", url: "/shop?ref=${ref}", expect: { kind: "visible", target: { role: "heading", name: "Shop" } } } },
            { step: { kind: "click", target: { role: "button", name: "Add" }, expect: { kind: "visible", target: { text: "Added" } } } },
            { step: { kind: "click", target: { role: "button", name: label }, expect: { kind: "visible", target: { text: "Thanks" } } } },
            { step: { kind: "click", target: { role: "button", name: "Done" }, expect: { kind: "visible", target: { text: "Bye" } } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

/** A pending action on a page at `url`: all `onHold` reads from the locator is its page's address. */
function locatorAt(url: string): Locator {
  return { page: () => ({ url: () => url }) } as unknown as Locator;
}

/** Holds the run at step 3, as the run would: the `beforeWrite` gate asks, `onHold` persists. Returns the hold id. */
async function holdAtStep3(params: Record<string, string> = { ref: MARKER }): Promise<string> {
  const stored = await new FsJourneyStore(journeysDir).get("checkout");
  const err = await runBeforeWriteHooks({
    journey: stored!,
    params,
    channel: "mcp",
    mode: "automation",
    evidence: undefined,
    target: { origin: SITE },
    step: 3,
    kind: "click",
    locator: locatorAt(`${SITE}/shop?ref=${encodeURIComponent(params.ref ?? "")}`),
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RunHeldError);
  const held = heldOutcomeOf(err);
  expect(held).toMatchObject({ outcome: "held", code: "E_RUN_HELD", kind: "approval", step: 3 });
  return held!.holdId;
}

const tty = (id: string, over: { prompt?: string } = {}) => ({
  stdinIsTTY: () => true,
  stdoutIsTTY: () => true,
  prompt: async () => over.prompt ?? id,
  env: {},
  user: () => "person",
});

async function approve(id: string): Promise<HoldRecord> {
  return approveHoldAtTerminal({ id, holdsDir, keyFile, inboxDir, approval: tty(id) });
}

async function refusal(p: Promise<unknown>): Promise<HoldError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HoldError);
  return err as HoldError;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "jev-hold-"));
  holdsDir = join(root, "holds");
  inboxDir = join(root, "inbox");
  journeysDir = join(root, "journeys");
  keyFile = join(root, "home", ".jevitate", "verify-checkpoint.key");
  createCheckpointKey(keyFile);
  await new FsJourneyStore(journeysDir).put(journey());
  clockNow = new FakeClock({ startMs: T0 });
  installClock(clockNow);
  registerRunHooks("test-gate", { beforeWrite: (ctx) => (ctx.step === 3 ? { kind: "approval", reason: "a checkout needs a person" } : undefined) });
  registerHoldHooks({ holdsDir, keyFile, inboxDir });
});

afterEach(() => {
  resetRunHooksForTests();
  resetClock();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("a held run is durable, signed and value-free", () => {
  it("writes the §5.4 record and a checkpoint under the holds dir, and the inbox item with the same id; no MARKER_ in either file", async () => {
    const id = await holdAtStep3();
    const files = readdirSync(holdsDir).sort();
    expect(files).toEqual([`${id}.checkpoint.json`, `${id}.json`]);
    const record = readHoldRecord(holdsDir, id, Buffer.from(readFileSync(keyFile, "utf8"), "hex"));
    expect(HoldRecordSchema.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      version: 1,
      kind: "approval",
      journey: { id: "checkout" },
      target: { origin: SITE, trust: "unknown" },
      pending: { step: 3, control: 'click button "Checkout"' },
      checkpoint: `${id}.checkpoint.json`,
      createdAt: "2026-11-08T12:00:00.000Z",
      expiresAt: "2026-11-09T12:00:00.000Z",
    });
    expect(record.answer).toBeUndefined();
    for (const f of files) expect(readFileSync(join(holdsDir, f), "utf8").match(/MARKER_/g) ?? []).toHaveLength(0);
    const item = await new FsInboxStore(inboxDir, { version: "t", commit: "c", builtAt: "b" }).get(id);
    expect(item).toMatchObject({ id, kind: "approval", status: "pending", holdId: id, step: "3", journey: "checkout", agent: "mcp" });
    expect(JSON.stringify(item)).not.toContain("MARKER_");
  });

  it("a file changed outside jevitate is not trusted (E_HOLD_INTEGRITY)", async () => {
    const id = await holdAtStep3();
    const path = holdRecordPath(holdsDir, id);
    writeFileSync(path, readFileSync(path, "utf8").replace('"trust": "unknown"', '"trust": "test"'));
    expect((await refusal(approve(id))).code).toBe("E_HOLD_INTEGRITY");
  });

  it("the page address keeps names, never values, and is restored from the person's parameters", () => {
    const masked = maskCheckpointUrl(`${SITE}/shop?ref=${encodeURIComponent("MARKER_ a/b")}&n=param`, { ref: "MARKER_ a/b", other: "param" });
    expect(masked).not.toContain("MARKER_");
    expect(masked).toBe(`${SITE}/shop?ref={param-enc:ref}&n={param:other}`);
    expect(restoreCheckpointUrl(masked, { ref: "MARKER_ a/b", other: "param" })).toEqual({ url: `${SITE}/shop?ref=${encodeURIComponent("MARKER_ a/b")}&n=param` });
    expect(restoreCheckpointUrl(masked, { ref: "x" })).toEqual({ problem: "the page address needs the parameter(s) other" });
    expect(restoreCheckpointUrl(maskCheckpointUrl(`${SITE}/o/tok123`, {}, ["tok123"]), {})).toHaveProperty("problem");
  });
});

describe("0.30.0 §5.4: a proof's replay never holds", () => {
  it("the same pending action inside a proof ends E_HUMAN_STEP_IN_PROOF, inconclusive, and nothing is held: no record, checkpoint or inbox item", async () => {
    const stored = (await new FsJourneyStore(journeysDir).get("checkout"))!;
    const ctx = { journey: stored, params: { ref: MARKER }, channel: "mcp" as const, mode: "automation" as const, evidence: undefined, target: { origin: SITE }, step: 3, kind: "click", locator: locatorAt(`${SITE}/shop`) };
    const err = await asProof(() => runBeforeWriteHooks(ctx)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProofHoldRefusedError);
    expect(heldOutcomeOf(err)).toBeUndefined();
    const refused = err as ProofHoldRefusedError;
    expect(proofHoldRefusalBody(refused)).toMatchObject({ error: "inconclusive", outcome: "inconclusive", code: E_HUMAN_STEP_IN_PROOF, kind: "approval", step: 3, retryable: false, exitCode: 2 });
    expect(refused.message).toContain("step 3 needs a person (an approval hold)");
    expect(refused.message).not.toContain(MARKER);
    expect(existsSync(holdsDir) ? readdirSync(holdsDir) : []).toEqual([]);
    expect(await new FsInboxStore(inboxDir, { version: "t", commit: "c", builtAt: "b" }).getSummaries()).toEqual([]);
    // Outside a proof the same action holds, as before.
    expect(await holdAtStep3()).toMatch(/^hold-[0-9a-f]{16}$/);
  });
});

describe("only a person at a terminal answers a hold", () => {
  it("approve at a TTY with the id typed back writes the answer with tty provenance and resolves the inbox item", async () => {
    const id = await holdAtStep3();
    const answered = await approve(id);
    expect(answered.answer).toEqual({ decision: "approved", provenance: { channel: "tty", agentSignals: [], user: "person" }, at: "2026-11-08T12:00:00.000Z" });
    expect((await new FsInboxStore(inboxDir, { version: "t", commit: "c", builtAt: "b" }).get(id))?.status).toBe("approved");
  });

  it("refuses without a TTY, inside an MCP call, and on a wrong typed id; the file is unchanged", async () => {
    const id = await holdAtStep3();
    const before = readFileSync(holdRecordPath(holdsDir, id));
    const noTty = await refusal(approveHoldAtTerminal({ id, holdsDir, keyFile, approval: { ...tty(id), stdinIsTTY: () => false } }));
    expect(noTty.code).toBe("E_HUMAN_APPROVAL_REQUIRED");
    const inMcp = await refusal(runAsMcpInvocation(() => approveHoldAtTerminal({ id, holdsDir, keyFile, approval: tty(id) })));
    expect(inMcp.code).toBe("E_HUMAN_APPROVAL_REQUIRED");
    const wrong = await refusal(approveHoldAtTerminal({ id, holdsDir, keyFile, approval: tty(id, { prompt: "yes" }) }));
    expect(wrong.code).toBe("E_APPROVAL_NOT_CONFIRMED");
    expect(readFileSync(holdRecordPath(holdsDir, id)).equals(before)).toBe(true);
  });

  it("approve_action over MCP returns the existing refusal and the hold file is byte-identical before and after", async () => {
    const id = await holdAtStep3();
    const before = readFileSync(holdRecordPath(holdsDir, id));
    const { isError, body } = await callMcpTool(mcpToolDeps({ profiles: new ProfileManager("/unused") }, { inboxDir }), "approve_action", { id });
    expect(isError).toBe(true);
    expect(body).toEqual({ error: "human_approval_required", message: "approval is only permitted from the local jevitate ui" });
    expect(readFileSync(holdRecordPath(holdsDir, id)).equals(before)).toBe(true);
    expect(readHoldRecord(holdsDir, id, Buffer.from(readFileSync(keyFile, "utf8"), "hex")).answer).toBeUndefined();
  });

  it("`jevitate inbox approve <id>` without a TTY refuses as MCP does (E_HUMAN_APPROVAL_REQUIRED, exit 64) and leaves the file byte-identical", async () => {
    const id = await holdAtStep3();
    const before = readFileSync(holdRecordPath(holdsDir, id));
    const out: string[] = [];
    const program = buildProgram({ profiles: new ProfileManager("/unused"), inboxDir, approval: { stdinIsTTY: () => false, stdoutIsTTY: () => true } });
    program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => out.push(s) });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync(["inbox", "approve", id, "--holds-dir", holdsDir, "--json"], { from: "user" });
    const code = process.exitCode;
    process.exitCode = undefined;
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, error: { code: "E_HUMAN_APPROVAL_REQUIRED" } });
    expect(code).toBe(64);
    expect(readFileSync(holdRecordPath(holdsDir, id)).equals(before)).toBe(true);
  });

  it("queue_action over MCP cannot queue a `secret` item; a secret item never takes input", async () => {
    const deps = mcpToolDeps({ profiles: new ProfileManager("/unused") }, { inboxDir });
    const queued = await callMcpTool(deps, "queue_action", { run: "r", journey: "j", step: "1", reason: "x", agent: "a", kind: "secret" });
    expect(queued.body).toMatchObject({ error: "invalid_args" });
    expect(await new FsInboxStore(inboxDir, { version: "t", commit: "c", builtAt: "b" }).getSummaries()).toEqual([]);
    const store = new FsInboxStore(inboxDir, { version: "t", commit: "c", builtAt: "b" });
    await store.enqueue({ id: "hold-00000000000000aa", kind: "secret", status: "pending", run: "r", journey: "j", step: "2", reason: "a secret step", agent: "mcp", hasScreenshot: false, thread: [], createdAt: "2026-11-08T12:00:00.000Z", ttlSec: 60 });
    await expect(store.resolve("hold-00000000000000aa", { channel: "human", action: "resume", input: "MARKER_SECRET" })).rejects.toThrow(/illegal transition/);
    await expect(store.resolve("hold-00000000000000aa", { channel: "human", action: "resume" })).resolves.toMatchObject({ status: "resolved" });
  });
});

describe("a resume continues only what the person approved", () => {
  const resumeReq = (over: Partial<Parameters<typeof checkHoldForResume>[0]> = {}) => ({ id: "", journeysDir, params: { ref: MARKER }, holdsDir, keyFile, ...over });

  it("an approved hold whose bindings all match is resumable from step 3, at the page it was held on", async () => {
    const id = await holdAtStep3();
    await approve(id);
    const ok = await checkHoldForResume(resumeReq({ id }));
    expect(ok.record.pending.step).toBe(3);
    expect(ok.url).toBe(`${SITE}/shop?ref=${encodeURIComponent(MARKER)}`);
  });

  it("refuses E_HOLD_BINDING for a changed Journey hash", async () => {
    const id = await holdAtStep3();
    await approve(id);
    const changed = journey();
    await new FsJourneyStore(journeysDir).put({ ...changed, metadata: { ...changed.metadata, name: "Checkout, edited" } });
    const err = await refusal(checkHoldForResume(resumeReq({ id })));
    expect(err.code).toBe("E_HOLD_BINDING");
    expect(err.mismatches).toEqual(["journey"]);
    expect(err.message).not.toContain("MARKER_");
  });

  it("refuses E_HOLD_BINDING for a different paramsDigest", async () => {
    const id = await holdAtStep3();
    await approve(id);
    const err = await refusal(checkHoldForResume(resumeReq({ id, params: { ref: "MARKER_OTHER" } })));
    expect(err.code).toBe("E_HOLD_BINDING");
    expect(err.mismatches).toEqual(["params"]);
    expect(err.message).not.toContain("MARKER_");
  });

  it("refuses E_HOLD_BINDING for a different origin", async () => {
    const id = await holdAtStep3();
    await approve(id);
    const err = await refusal(checkHoldForResume(resumeReq({ id, environment: { baseUrl: "https://other.test", allowedOrigins: ["https://other.test"] } })));
    expect(err.code).toBe("E_HOLD_BINDING");
    expect(err.mismatches).toEqual(["target"]);
  });

  it("refuses E_HOLD_BINDING for a different pending step", async () => {
    const id = await holdAtStep3();
    await approve(id);
    const key = Buffer.from(readFileSync(keyFile, "utf8"), "hex");
    const cpPath = join(holdsDir, `${id}.checkpoint.json`);
    const cp = readRunCheckpoint(cpPath, key);
    if (cp.kind !== "read") throw new Error("no checkpoint");
    // The checkpoint (signed with the same key) now stands at step 4: not the action that was approved.
    writeRunCheckpoint(cpPath, key, { ...cp.body, step: 4 });
    const err = await refusal(checkHoldForResume(resumeReq({ id })));
    expect(err.code).toBe("E_HOLD_BINDING");
    expect(err.mismatches).toEqual(["pending"]);
  });

  it("refuses an unanswered hold (E_HOLD_NOT_APPROVED) and a rejected one (E_HOLD_REJECTED)", async () => {
    const id = await holdAtStep3();
    expect((await refusal(checkHoldForResume(resumeReq({ id })))).code).toBe("E_HOLD_NOT_APPROVED");
    await approveHoldAtTerminal({ id, holdsDir, keyFile, decision: "rejected", approval: tty(id) });
    expect((await refusal(checkHoldForResume(resumeReq({ id })))).code).toBe("E_HOLD_REJECTED");
  });

  it("an expired hold ends inconclusive with E_HOLD_EXPIRED, for the approval and for the resume", async () => {
    const id = await holdAtStep3();
    await approve(id);
    clockNow.setSystemTime(T0 + 24 * 60 * 60 * 1000 + 1);
    const err = await refusal(checkHoldForResume(resumeReq({ id })));
    expect(err.code).toBe("E_HOLD_EXPIRED");
    expect(err.outcome).toBe("inconclusive");
    const late = await holdAtStep3();
    clockNow.setSystemTime(T0 + 3 * 24 * 60 * 60 * 1000);
    expect((await refusal(approve(late))).code).toBe("E_HOLD_EXPIRED");
  });
});
