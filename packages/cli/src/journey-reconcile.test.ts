import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { DoneReading } from "@jevitate/adjudicator";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { Locator } from "playwright";
import { approveHoldAtTerminal, heldOutcomeOf, HoldError, registerHoldHooks, resumeHold } from "./journey-hold.js";
import { reconcileBeforeRetry, reconcileLinkedJob } from "./journey-reconcile.js";
import { registerRunHooks, resetRunHooksForTests, runBeforeWriteHooks } from "./journey-run-hooks.js";
import { createCheckpointKey } from "./journey-verify-checkpoint.js";
import type { BrowserPort, ReadDoneCheckInput } from "./journey-done-check.js";
import { exitCodeForError } from "./exit-codes.js";

/** #795: reconcile before a retry or resume reads the job's done check in a fresh context; already true stops it. */

const MARKER = "MARKER_REF-7781";
const SITE = "https://shop.test";
const DONE = { version: 1, at: "/orders", check: "textIncludes:testId=orders|placed" } as const;

function journeyOf(job?: string): Journey {
  return {
    metadata: { id: "checkout", name: "Checkout", promoted: true, params: ["ref"], ...(job === undefined ? {} : { job }), createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: {
      version: "1",
      site: SITE,
      pages: [
        {
          url: "/shop",
          steps: [
            { step: { kind: "navigate", url: "/shop?ref=${ref}", expect: { kind: "visible", target: { role: "heading", name: "Shop" } } } },
            { step: { kind: "click", target: { role: "button", name: "Add" }, expect: { kind: "visible", target: { text: "Added" } } } },
            { step: { kind: "click", target: { role: "button", name: "Checkout" }, expect: { kind: "visible", target: { text: "Thanks" } } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

const reading = (value: boolean | { known: false }): DoneReading => ({
  value: typeof value === "boolean" ? { known: true, value } : { known: false, reason: "session-unavailable" },
  session: "fresh",
  at: "pre",
  durationMs: 1,
});
const readerOf = (value: boolean | { known: false }) => vi.fn(async (_i: ReadDoneCheckInput) => reading(value));
const port: BrowserPort = { openContext: async () => Promise.reject(new Error("the fake reader never opens one")) };
const job = { id: "place-order", status: "approved", done: DONE } as never;

describe("reconcileBeforeRetry", () => {
  it("a check that reads true stops the retry: already-true", async () => {
    const read = readerOf(true);
    const r = await reconcileBeforeRetry({ journey: journeyOf("place-order"), job, auth: {}, browserPort: port, read });
    expect(r).toMatchObject({ proceed: false, basis: "already-true", code: "E_RECONCILE_ALREADY_DONE" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(exitCodeForError("E_RECONCILE_ALREADY_DONE")).toBe(2);
  });

  it("a check that reads false lets the retry proceed", async () => {
    expect(await reconcileBeforeRetry({ journey: journeyOf("place-order"), job, auth: {}, browserPort: port, read: readerOf(false) })).toEqual({ proceed: true });
  });

  it("an unknown reading stops the retry: reading-unknown", async () => {
    const r = await reconcileBeforeRetry({ journey: journeyOf("place-order"), job, auth: {}, browserPort: port, read: readerOf({ known: false }) });
    expect(r).toMatchObject({ proceed: false, basis: "reading-unknown", code: "E_RECONCILE_UNREADABLE" });
    expect(exitCodeForError("E_RECONCILE_UNREADABLE")).toBe(2);
  });

  it("a reader that throws is unknown, and a job with no done check proceeds without reading", async () => {
    const throwing = vi.fn(async () => Promise.reject(new Error(`boom ${MARKER}`)));
    expect(await reconcileBeforeRetry({ journey: journeyOf("place-order"), job, auth: {}, browserPort: port, read: throwing })).toMatchObject({ basis: "reading-unknown" });
    const read = readerOf(true);
    expect(await reconcileBeforeRetry({ journey: journeyOf(), job: undefined, auth: {}, read })).toEqual({ proceed: true });
    expect(await reconcileBeforeRetry({ journey: journeyOf("place-order"), job: { id: "x", status: "approved" } as never, auth: {}, read })).toEqual({ proceed: true });
    expect(read).not.toHaveBeenCalled();
  });

  it("no message carries a param value", async () => {
    for (const v of [true, { known: false } as const]) {
      const r = await reconcileBeforeRetry({ journey: journeyOf("place-order"), job, auth: {}, params: { ref: MARKER }, browserPort: port, read: readerOf(v) });
      expect(JSON.stringify(r)).not.toContain("MARKER_");
    }
  });
});

describe("inbox resume reconciles first", () => {
  let root: string;
  let holdsDir: string;
  let inboxDir: string;
  let journeysDir: string;
  let catalogDir: string;
  let keyFile: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "jev-reconcile-"));
    holdsDir = join(root, "holds");
    inboxDir = join(root, "inbox");
    journeysDir = join(root, "journeys");
    catalogDir = join(root, ".jevitate");
    keyFile = join(root, "home", ".jevitate", "verify-checkpoint.key");
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(join(catalogDir, "jobs.json"), JSON.stringify({ jobs: [{ id: "place-order", trigger: "When I want it", motivation: "I want to buy", outcome: "I can see my order", done: DONE }] }));
    createCheckpointKey(keyFile);
    await new FsJourneyStore(journeysDir).put(journeyOf("place-order"));
    installClock(new FakeClock({ startMs: Date.parse("2026-11-08T12:00:00.000Z") }));
    registerRunHooks("test-gate", { beforeWrite: (ctx) => (ctx.step === 3 ? { kind: "approval", reason: "a checkout needs a person" } : undefined) });
    registerHoldHooks({ holdsDir, keyFile, inboxDir });
  });
  afterEach(() => {
    resetRunHooksForTests();
    resetClock();
    rmSync(root, { recursive: true, force: true });
  });

  async function approvedHold(): Promise<string> {
    const stored = await new FsJourneyStore(journeysDir).get("checkout");
    const err = await runBeforeWriteHooks({
      journey: stored!,
      params: { ref: MARKER },
      channel: "mcp",
      mode: "automation",
      evidence: undefined,
      target: { origin: SITE },
      step: 3,
      kind: "click",
      locator: { page: () => ({ url: () => `${SITE}/shop?ref=${encodeURIComponent(MARKER)}` }) } as unknown as Locator,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const id = heldOutcomeOf(err)!.holdId;
    await approveHoldAtTerminal({ id, holdsDir, keyFile, inboxDir, approval: { stdinIsTTY: () => true, stdoutIsTTY: () => true, prompt: async () => id, env: {}, user: () => "person" } });
    return id;
  }

  it("a hold whose job already reads true does not open a browser or re-run the pending write", async () => {
    const id = await approvedHold();
    const factory = vi.fn(() => {
      throw new Error("the run's browser must not open");
    });
    const err = await resumeHold({
      id,
      journeysDir,
      params: { ref: MARKER },
      holdsDir,
      keyFile,
      inboxDir,
      catalogDir,
      browserPortFactory: factory as never,
      reconcileBrowserPort: port,
      reconcileRead: readerOf(true),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HoldError);
    expect(err).toMatchObject({ code: "E_RECONCILE_ALREADY_DONE", outcome: "inconclusive" });
    expect(factory).not.toHaveBeenCalled();
    expect(JSON.stringify((err as HoldError).message)).not.toContain("MARKER_");
  });

  it("an unknown reading stops the resume too; reconcileLinkedJob finds the job through the catalog", async () => {
    const id = await approvedHold();
    const factory = vi.fn();
    await expect(resumeHold({ id, journeysDir, params: { ref: MARKER }, holdsDir, keyFile, inboxDir, catalogDir, browserPortFactory: factory as never, reconcileBrowserPort: port, reconcileRead: readerOf({ known: false }) })).rejects.toMatchObject({ code: "E_RECONCILE_UNREADABLE" });
    expect(factory).not.toHaveBeenCalled();
    const stored = (await new FsJourneyStore(journeysDir).get("checkout"))!;
    expect(await reconcileLinkedJob({ catalogDir, journeysDir, journey: stored, auth: {}, browserPort: port, read: readerOf(false) })).toEqual({ proceed: true });
  });
});
