import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey, type JourneyReview } from "@jevitate/journey";
import { runJourneyReadiness, type JourneyReadinessDeps } from "./journey-readiness.js";
import type { JourneyChainDeps, JourneyChainResult } from "./journey-chain.js";
import type { RunJourneyProgrammaticallyOptions } from "./journey-api.js";

/**
 * #581 — `journey readiness`: a report over a Journey (or a linked pair). Every runner is faked, so
 * the suite proves the receipt's verdicts and refusals without opening a browser.
 */

type Run = NonNullable<JourneyReadinessDeps["run"]>;
type Chain = NonNullable<JourneyReadinessDeps["chain"]>;
type Verify = NonNullable<JourneyReadinessDeps["verify"]>;
type Review = NonNullable<JourneyReadinessDeps["review"]>;

interface ReviewOverrides {
  attention?: JourneyReview["attention"];
  missingIntent?: string[];
  catalog?: JourneyReview["catalog"];
  verify?: unknown;
  change?: unknown;
}

const GOOD_CATALOG = {
  linked: true,
  job: { id: "publish-post", status: "approved" },
  persona: { id: "editor", status: "approved" },
  unvetted: [],
  needsReReview: [],
};

const PROVEN = { status: "recorded", verdict: "proven", at: "2026-01-01T00:00:00Z", stale: false, summary: { mutation: 1 } };

function recording(url = "/editor"): Journey["recording"] {
  return { version: "1.0.0", site: "https://example.test", pages: [{ url, steps: [] }] };
}

const END_STATE = [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }] as const;

function journey(id: string, metadata: Partial<Journey["metadata"]> = {}, rec: Journey["recording"] = recording()): Journey {
  return {
    metadata: { id, name: `Journey ${id}`, promoted: false, params: [], createdAtIso: "2026-01-01T00:00:00Z", endState: [...END_STATE], ...metadata },
    recording: rec,
  };
}

/** A step asserting its own target is visible — the `own-target-visible` lint error. */
function weakJourney(id: string): Journey {
  return journey(id, {}, {
    version: "1.0.0",
    site: "https://example.test",
    pages: [{ url: "/editor", steps: [{ step: { kind: "click", target: { testId: "go" }, expect: { kind: "visible", target: { testId: "go" } } } }] }],
  });
}

/** A Journey needing `token`: a navigate URL's `${token}` makes it a required run param. */
function paramJourney(id: string): Journey {
  return journey(id, { params: ["token"] }, {
    version: "1.0.0",
    site: "https://example.test",
    pages: [{ url: "/editor", steps: [{ step: { kind: "navigate", url: "/editor?t=${token}", expect: { kind: "urlIncludes", text: "/editor" } } }] }],
  });
}

/** A valid consuming Journey: a declared `replyText` param bound to a declared request field. */
function consumer(id: string, accepts: string): Journey {
  return journey(id, {
    params: ["replyText"],
    inputs: { accepts, request: { fields: { replyText: { type: "id" } }, key: ["replyText"] }, bindings: { replyText: { request: "replyText" } } },
  });
}

/** #608: a producing Journey whose Recording binds `threadId` and `replyIdentity` (both required). */
function producerWithParams(id: string): Journey {
  const bound = (p: string) => ({
    variableName: p,
    step: { kind: "select" as const, target: { testId: p }, value: { var: p }, expect: { kind: "visible" as const, target: { testId: p } } },
  });
  return journey(id, { params: ["threadId", "replyIdentity"], promoted: true }, {
    version: "1.0.0",
    site: "https://example.test",
    pages: [{ url: "/", steps: [bound("threadId"), bound("replyIdentity")] }],
  });
}

function reviewEx(overrides: ReviewOverrides = {}): JourneyReview {
  return {
    id: "x",
    name: "x",
    promoted: false,
    summary: { requiresAuth: false, preconditions: [], successCriteria: [], missingIntent: overrides.missingIntent ?? [] },
    steps: [],
    sideEffects: { writeRequests: [], riskyControls: [], origins: [] },
    inputs: { params: [], secrets: [] },
    proof: { endState: [], stepAssertions: [], lint: { errors: 0, warnings: 0, findings: [] }, verify: overrides.verify ?? { status: "not-verified", hint: "run journey verify --mutate" } },
    changeSinceApproval: overrides.change ?? { kind: "first-approval" },
    contentHash: "a".repeat(64),
    attention: overrides.attention ?? [],
    catalog: overrides.catalog ?? GOOD_CATALOG,
  } as unknown as JourneyReview;
}

let root: string;
let journeysDir: string;
let store: FsJourneyStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-581-"));
  journeysDir = join(root, ".jevitate", "journeys");
  await mkdir(journeysDir, { recursive: true });
  store = new FsJourneyStore(journeysDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A `review` dep: the real Journey from the store, the sheet from `overrides` (or a per-Journey fn). */
function reviewDep(source: ReviewOverrides | ((j: Journey) => ReviewOverrides) = {}): Review {
  return (async (_dir: string, id: string) => {
    const found = await store.get(id);
    if (found === null) throw new Error(`unknown journey '${id}'`);
    const overrides = typeof source === "function" ? source(found) : source;
    const sheet = reviewEx(overrides);
    return { journey: found, review: { ...sheet, id: found.metadata.id, name: found.metadata.name } };
  }) as Review;
}

function receipt(opts: Parameters<typeof runJourneyReadiness>[0], deps: JourneyReadinessDeps) {
  return runJourneyReadiness(opts, deps);
}

/** #608: a pair chain that invokes the chain's `runJourney` seam for the producer and, when given,
 * the consumer — so its bound params reach the readiness wrapper. */
function chainBinding(toParams?: Record<string, string>): Chain {
  return (async (opts: Parameters<Chain>[0], deps?: JourneyChainDeps) => {
    await deps?.runJourney?.({ id: opts.from, params: {} } as RunJourneyProgrammaticallyOptions);
    if (toParams !== undefined) await deps?.runJourney?.({ id: opts.to, params: toParams } as RunJourneyProgrammaticallyOptions);
    return { runs: [], unmatched: [] } as JourneyChainResult;
  }) as unknown as Chain;
}

function checkOf(r: Awaited<ReturnType<typeof runJourneyReadiness>>, check: string, id: string) {
  return r.checks.find((c) => c.check === check && c.journey === id);
}

describe("journey readiness", () => {
  it("report runs no runner", async () => {
    await store.put(journey("publish"));
    const run = vi.fn(async () => ({ outcome: "ok" }));
    const chain = vi.fn(async () => ({ runs: [], unmatched: [] }));
    const verify = vi.fn(async () => ({}));
    await receipt({ id: "publish", journeysDir }, { review: reviewDep(), run: run as unknown as Run, chain: chain as unknown as Chain, verify: verify as unknown as Verify });
    expect(run).not.toHaveBeenCalled();
  });

  it("report is incomplete without a mutation proof", async () => {
    await store.put(journey("publish"));
    const r = await receipt({ id: "publish", journeysDir }, { review: reviewDep() });
    expect(r.verdict).toBe("incomplete");
  });

  it("report is technically-ready with a fresh proof and a current approval", async () => {
    await store.put(journey("publish", { promoted: true, approval: { contentHash: "a".repeat(64), at: "2026-01-01T00:00:00Z" } }));
    const r = await receipt({ id: "publish", journeysDir }, { review: reviewDep({ verify: PROVEN, change: { kind: "no-record" } }) });
    expect(r.verdict).toBe("technically-ready");
  });

  it("report is blocked by a lint error", async () => {
    await store.put(weakJourney("publish"));
    const r = await receipt({ id: "publish", journeysDir }, { review: reviewDep() });
    expect(checkOf(r, "lint", "publish")?.state).toBe("fail");
  });

  it("report is blocked by a strict warning", async () => {
    await store.put(journey("publish"));
    const r = await receipt({ id: "publish", journeysDir }, { review: reviewDep({ attention: [{ severity: "warn", text: "a weak step" }] }) });
    expect(checkOf(r, "review-strict", "publish")?.state).toBe("fail");
  });

  it("a pair reports a handoff check", async () => {
    await store.put(journey("producer"));
    await store.put(journey("consumer"));
    const r = await receipt({ id: "producer", with: "consumer", journeysDir }, { review: reviewDep() });
    expect(checkOf(r, "handoff", "producer")?.state).toBe("not-run");
  });

  it("an incompatible handoff fails", async () => {
    await store.put(journey("producer"));
    await store.put(consumer("consumer", "reply@1"));
    const r = await receipt({ id: "producer", with: "consumer", journeysDir }, { review: reviewDep() });
    expect(checkOf(r, "handoff", "producer")?.state).toBe("fail");
  });

  it("replay refuses a missing target", async () => {
    await store.put(journey("publish"));
    await expect(receipt({ id: "publish", mode: "replay", journeysDir }, { review: reviewDep() })).rejects.toMatchObject({ code: "E_READINESS_TARGET" });
  });

  it("replay refuses a production target", async () => {
    await store.put(journey("publish"));
    const file = join(root, "environments.json");
    await writeFile(file, JSON.stringify({ prod: { baseUrl: "https://prod.test", production: true } }));
    await expect(receipt({ id: "publish", mode: "replay", env: "prod", journeysDir }, { review: reviewDep(), environmentsFile: file })).rejects.toMatchObject({ code: "E_READINESS_PRODUCTION" });
  });

  it("replay refuses a missing required param by name", async () => {
    await store.put(paramJourney("publish"));
    await expect(receipt({ id: "publish", mode: "replay", baseUrl: "https://example.test", journeysDir }, { review: reviewDep() })).rejects.toMatchObject({ code: "E_READINESS_PARAMS", message: expect.stringContaining("token") });
  });

  it("replay fails when the handback submitted", async () => {
    await store.put(journey("publish"));
    const run = vi.fn(async () => ({ outcome: "ok", handback: { state: "submitted", boundary: "prepare-only", stopBefore: "Publish", evidence: { steps: 1, checksPassed: 1, writes: 1, writesBlocked: 0 } } }));
    const r = await receipt({ id: "publish", mode: "replay", baseUrl: "https://example.test", journeysDir }, { review: reviewDep(), run: run as unknown as Run });
    expect(checkOf(r, "replay", "publish")?.state).toBe("fail");
  });

  it("an inconclusive proof makes the verdict inconclusive", async () => {
    await store.put(journey("publish"));
    const run = vi.fn(async () => ({ outcome: "ok" }));
    const r = await receipt(
      { id: "publish", mode: "replay", baseUrl: "https://example.test", journeysDir },
      { review: reviewDep({ verify: { status: "recorded", verdict: "inconclusive", at: "2026-01-01T00:00:00Z", stale: false, reason: "flaky", summary: {} } }), run: run as unknown as Run },
    );
    expect(r.verdict).toBe("inconclusive");
  });

  // A read-only Journey with no inputs has nothing a mutation could break: its unconcludable proof passes.
  const nothingPaired = { status: "recorded" as const, verdict: "inconclusive", at: "2026-01-01T00:00:00Z", stale: false, reason: "no assertion is paired with a mutation", summary: { sensitive: 0, insensitive: 0, cascade: 0, notApplied: 0, error: 0, unpaired: 1 } };

  it("passes the proof of a read-only Journey with no inputs that has nothing to mutate", async () => {
    await store.put(journey("discover"));
    const r = await receipt({ id: "discover", journeysDir }, { review: reviewDep({ verify: nothingPaired }) });
    expect(checkOf(r, "proof", "discover")?.state).toBe("pass");
  });

  it("keeps that proof inconclusive when the Journey takes an input", async () => {
    await store.put(paramJourney("discover"));
    const r = await receipt({ id: "discover", journeysDir }, { review: reviewDep({ verify: nothingPaired }) });
    expect(checkOf(r, "proof", "discover")?.state).toBe("inconclusive");
  });

  it("a pair replay runs the chain", async () => {
    await store.put(journey("producer"));
    await store.put(journey("consumer"));
    const chain = vi.fn(async () => ({ runs: [], unmatched: [] }) as JourneyChainResult);
    await receipt({ id: "producer", with: "consumer", mode: "replay", baseUrl: "https://example.test", requests: "x", journeysDir }, { review: reviewDep(), chain: chain as unknown as Chain });
    expect(chain).toHaveBeenCalledTimes(1);
  });

  it("prove records a fresh proof", async () => {
    await store.put(journey("publish"));
    let proven = false;
    const verify = vi.fn(async () => {
      proven = true;
      return {};
    });
    const run = vi.fn(async () => ({ outcome: "ok" }));
    const r = await receipt(
      { id: "publish", mode: "prove", baseUrl: "https://example.test", journeysDir },
      { review: reviewDep(() => ({ verify: proven ? PROVEN : undefined })), run: run as unknown as Run, verify: verify as unknown as Verify },
    );
    expect(checkOf(r, "proof", "publish")?.state).toBe("pass");
  });

  it("a param value never reaches the receipt", async () => {
    await store.put(paramJourney("publish"));
    const run = vi.fn(async () => ({ outcome: "ok" }));
    const r = await receipt(
      { id: "publish", mode: "replay", baseUrl: "https://example.test", params: { token: "SUPER-SECRET-VALUE" }, journeysDir },
      { review: reviewDep(), run: run as unknown as Run },
    );
    expect(JSON.stringify(r)).not.toContain("SUPER-SECRET-VALUE");
  });

  it("a draft catalog link is awaiting-human", async () => {
    await store.put(journey("publish"));
    const r = await receipt(
      { id: "publish", journeysDir },
      { review: reviewDep({ catalog: { linked: true, job: { id: "j", status: "draft" }, persona: { id: "p", status: "approved" }, unvetted: ["job:j (draft)"], needsReReview: [] } }) },
    );
    expect(checkOf(r, "catalog", "publish")?.state).toBe("awaiting-human");
  });

  // #608 — a pair's producer params flow to the chain; unknown names are refused before it.
  it("pair replay passes its params to the chain", async () => {
    await store.put(producerWithParams("producer"));
    await store.put(consumer("consumer", "reply@1"));
    const chain = vi.fn(async () => ({ runs: [], unmatched: [] }) as JourneyChainResult);
    await receipt(
      { id: "producer", with: "consumer", mode: "replay", baseUrl: "https://example.test", requests: "x", params: { threadId: "thread-001", replyIdentity: "mcpl" }, journeysDir },
      { review: reviewDep(), chain: chain as unknown as Chain },
    );
    expect(chain.mock.calls[0]![0]).toMatchObject({ params: { threadId: "thread-001", replyIdentity: "mcpl" } });
  });

  it("pair replay refuses an undeclared producer param with E_READINESS_PARAMS naming it", async () => {
    await store.put(producerWithParams("producer"));
    await store.put(consumer("consumer", "reply@1"));
    const chain = vi.fn(async () => ({ runs: [], unmatched: [] }) as JourneyChainResult);
    await expect(
      receipt(
        { id: "producer", with: "consumer", mode: "replay", baseUrl: "https://example.test", requests: "x", params: { threadId: "t", replyIdentity: "r", extra: "z" }, journeysDir },
        { review: reviewDep(), chain: chain as unknown as Chain },
      ),
    ).rejects.toMatchObject({ code: "E_READINESS_PARAMS", message: "unknown param(s): extra" });
  });

  it("pair replay never calls the chain for an undeclared producer param", async () => {
    await store.put(producerWithParams("producer"));
    await store.put(consumer("consumer", "reply@1"));
    const chain = vi.fn(async () => ({ runs: [], unmatched: [] }) as JourneyChainResult);
    await receipt(
      { id: "producer", with: "consumer", mode: "replay", baseUrl: "https://example.test", requests: "x", params: { threadId: "t", replyIdentity: "r", extra: "z" }, journeysDir },
      { review: reviewDep(), chain: chain as unknown as Chain },
    ).catch(() => undefined);
    expect(chain).not.toHaveBeenCalled();
  });

  it("pair prove verifies the consumer with the params the chain bound for it", async () => {
    await store.put(producerWithParams("producer"));
    await store.put(consumer("consumer", "reply@1"));
    const run = vi.fn(async () => ({ outcome: "ok" }));
    const verifyCalls: Array<{ id: string; params?: Record<string, string> }> = [];
    const verify = vi.fn(async (o: { id: string; params?: Record<string, string> }) => {
      verifyCalls.push(o);
      return {};
    });
    const replyText = "Line one\n\nLine three";
    const chain = chainBinding({ commentId: "c-1", replyIdentity: "r", threadId: "t", replyText });
    await receipt(
      { id: "producer", with: "consumer", mode: "prove", baseUrl: "https://example.test", requests: "x", params: { threadId: "t", replyIdentity: "r" }, journeysDir },
      { review: reviewDep(() => ({ verify: PROVEN })), run: run as unknown as Run, chain, verify: verify as unknown as Verify },
    );
    expect(verifyCalls.find((c) => c.id === "consumer")?.params).toEqual({ commentId: "c-1", replyIdentity: "r", threadId: "t", replyText });
  });

  it("pair prove does not verify the consumer when the chain bound no consumer run", async () => {
    await store.put(producerWithParams("producer"));
    await store.put(consumer("consumer", "reply@1"));
    const run = vi.fn(async () => ({ outcome: "ok" }));
    const verifyCalls: Array<{ id: string }> = [];
    const verify = vi.fn(async (o: { id: string }) => {
      verifyCalls.push(o);
      return {};
    });
    await receipt(
      { id: "producer", with: "consumer", mode: "prove", baseUrl: "https://example.test", requests: "x", params: { threadId: "t", replyIdentity: "r" }, journeysDir },
      { review: reviewDep(() => ({ verify: PROVEN })), run: run as unknown as Run, chain: chainBinding(), verify: verify as unknown as Verify },
    );
    expect(verifyCalls.some((c) => c.id === "consumer")).toBe(false);
  });

  it("pair prove marks the consumer proof not-verified with a hint naming it when the chain bound no consumer run", async () => {
    await store.put(producerWithParams("producer"));
    await store.put(consumer("consumer", "reply@1"));
    const run = vi.fn(async () => ({ outcome: "ok" }));
    const verify = vi.fn(async () => ({}));
    const r = await receipt(
      { id: "producer", with: "consumer", mode: "prove", baseUrl: "https://example.test", requests: "x", params: { threadId: "t", replyIdentity: "r" }, journeysDir },
      { review: reviewDep(() => ({ verify: PROVEN })), run: run as unknown as Run, chain: chainBinding(), verify: verify as unknown as Verify },
    );
    expect(checkOf(r, "proof", "consumer")).toMatchObject({ state: "not-run", detail: "the chain bound no request for 'consumer' — supply a --requests line that matches a discovered record" });
  });

  it("the pair prove receipt never contains a param value or reply text", async () => {
    await store.put(producerWithParams("producer"));
    await store.put(consumer("consumer", "reply@1"));
    const run = vi.fn(async () => ({ outcome: "ok" }));
    const verify = vi.fn(async () => ({}));
    const replyText = "Line one\n\nLine three";
    const r = await receipt(
      { id: "producer", with: "consumer", mode: "prove", baseUrl: "https://example.test", requests: "x", params: { threadId: "SUPER-SECRET-THREAD", replyIdentity: "SECRET-IDENTITY" }, journeysDir },
      { review: reviewDep(() => ({ verify: PROVEN })), run: run as unknown as Run, chain: chainBinding({ commentId: "c-1", replyIdentity: "SECRET-IDENTITY", threadId: "SUPER-SECRET-THREAD", replyText }), verify: verify as unknown as Verify },
    );
    const serialized = JSON.stringify(r);
    const leaked = ["SUPER-SECRET-THREAD", "SECRET-IDENTITY", replyText].filter((value) => serialized.includes(value));
    expect(leaked).toEqual([]);
  });
});
