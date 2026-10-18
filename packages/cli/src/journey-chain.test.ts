import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import type { RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { JourneyChainError, runJourneyChain } from "./journey-chain.js";

// #580: `jevitate journey chain` runs a discover Journey once, then a prepare-only
// reply Journey once per approved request matched to a discovered record. These tests
// drive the programmatic surface with an injected fake runner (no browser).

/** A reply Journey recording the params section 3 maps, optionally also declaring `expected_parentid`. */
function replyJourney(id: string, opts: { parent?: boolean } = {}): Journey {
  const params = [
    "commentId",
    "replyIdentity",
    "threadId",
    "expected_commentid",
    "expected_account",
    "expected_sourcetext",
    ...(opts.parent === true ? ["expected_parentid"] : []),
    "replyText",
  ];
  const assertAbout = (name: string, value: string) => ({
    step: { kind: "assert" as const, check: { kind: "attr" as const, target: { testId: "comment" }, name, value: { var: value } } },
  });
  return {
    metadata: { id, name: `Reply ${id}`, promoted: true, params, createdAtIso: "2026-09-19T00:00:00Z" },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/thread",
          steps: [
            { step: { kind: "navigate", url: "https://example.test/c/${commentId}", expect: { kind: "urlIncludes", text: "/c/" } } },
            { variableName: "replyIdentity", step: { kind: "select", target: { testId: "identity" }, value: { var: "replyIdentity" }, expect: { kind: "visible", target: { testId: "identity" } } } },
            { variableName: "threadId", step: { kind: "select", target: { testId: "thread" }, value: { var: "threadId" }, expect: { kind: "visible", target: { testId: "thread" } } } },
            assertAbout("data-comment", "expected_commentid"),
            assertAbout("data-account", "expected_account"),
            assertAbout("data-source", "expected_sourcetext"),
            ...(opts.parent === true ? [assertAbout("data-parent", "expected_parentid")] : []),
            { variableName: "replyText", step: { kind: "fill", target: { testId: "composer" }, value: { var: "replyText" }, expect: { kind: "valueEquals", target: { testId: "composer" }, value: { var: "replyText" } } } },
          ],
        },
      ],
    },
  };
}

const RECORD_FIELDS: readonly string[] = ["commentId", "account", "permalink", "threadId", "sourceText"];

/** `from` output for one record, in the indexed shape section 2 fixes. */
function recordOutput(i: number, record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(RECORD_FIELDS.map((f) => [`records.${i}.${f}`, record[f] ?? ""]));
}

interface RunnerCall extends RunJourneyProgrammaticallyOptions {}

function fakeRunner(byId: Record<string, JourneyRunResult | ((o: RunJourneyProgrammaticallyOptions) => JourneyRunResult)>) {
  const calls: RunnerCall[] = [];
  const run = async (o: RunJourneyProgrammaticallyOptions): Promise<JourneyRunResult> => {
    calls.push(o);
    const canned = byId[o.id];
    if (canned === undefined) throw new Error(`fake runner: unexpected journey '${o.id}'`);
    return typeof canned === "function" ? canned(o) : canned;
  };
  return { calls, run };
}

const toCalls = (calls: RunnerCall[]) => calls.filter((c) => c.id === "prepare-reply" || c.id === "prepare-reply-parent");

let dir: string;

async function setup(journeys: Journey[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "jev-580-"));
  const store = new FsJourneyStore(dir);
  for (const j of journeys) await store.put(j);
  return dir;
}

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

const OK: JourneyRunResult = { outcome: "ok", output: {} };

test("happy path runs the reply Journey once per matched request with the mapped params", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const from: JourneyRunResult = {
    outcome: "ok",
    output: {
      "records.count": "2",
      ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "first" }),
      ...recordOutput(1, { commentId: "c-2002", account: "personal", permalink: "/c/2002", threadId: "t-2", sourceText: "second" }),
    },
  };
  const requests = `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "Thanks!" })}\n${JSON.stringify({ commentId: "c-2002", account: "personal", replyText: "Hi" })}\n`;
  const runner = fakeRunner({ "discover-conversations": from, "prepare-reply": OK });

  await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests, dir: d }, { runJourney: runner.run });

  expect(toCalls(runner.calls).map((c) => c.params)).toEqual([
    { commentId: "c-1001", replyIdentity: "mcpl", threadId: "t-1", expected_commentid: "c-1001", expected_account: "mcpl", expected_sourcetext: "first", replyText: "Thanks!" },
    { commentId: "c-2002", replyIdentity: "personal", threadId: "t-2", expected_commentid: "c-2002", expected_account: "personal", expected_sourcetext: "second", replyText: "Hi" },
  ]);
});

test("rejects with E_CHAIN_EMPTY when the from output has zero records", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({ "discover-conversations": { outcome: "ok", output: { "records.count": "0" } }, "prepare-reply": OK });

  const chain = runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "x" })}\n`, dir: d }, { runJourney: runner.run });

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_EMPTY" });
});

test("never runs the reply Journey when the from output has zero records", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({ "discover-conversations": { outcome: "ok", output: { "records.count": "0" } }, "prepare-reply": OK });

  await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "x" })}\n`, dir: d }, { runJourney: runner.run }).catch(() => undefined);

  expect(toCalls(runner.calls)).toHaveLength(0);
});

test("rejects with E_CHAIN_FROM_FAILED carrying the run's reason when the from run is not ok", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({ "discover-conversations": { outcome: "quarantined", reason: "step 3 failed: forEach matched 0 rows" }, "prepare-reply": OK });

  const chain = runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "x" })}\n`, dir: d }, { runJourney: runner.run });

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_FROM_FAILED", message: expect.stringContaining("step 3 failed") });
});

test("lists a request with no matching record as unmatched", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({
    "discover-conversations": { outcome: "ok", output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "first" }) } },
    "prepare-reply": OK,
  });

  const result = await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-9999", account: "mcpl", replyText: "x" })}\n`, dir: d }, { runJourney: runner.run });

  expect(result.unmatched).toEqual([{ commentId: "c-9999", account: "mcpl" }]);
});

test("does not run the reply Journey for an unmatched request", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({
    "discover-conversations": { outcome: "ok", output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "first" }) } },
    "prepare-reply": OK,
  });

  await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-9999", account: "mcpl", replyText: "x" })}\n`, dir: d }, { runJourney: runner.run });

  expect(toCalls(runner.calls)).toHaveLength(0);
});

test("treats a request whose account does not match the record as unmatched", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({
    "discover-conversations": { outcome: "ok", output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "first" }) } },
    "prepare-reply": OK,
  });

  const result = await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "personal", replyText: "x" })}\n`, dir: d }, { runJourney: runner.run });

  expect(result.unmatched).toEqual([{ commentId: "c-1001", account: "personal" }]);
});

test("refuses a request with an extra key (E_CHAIN_REQUEST)", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({ "discover-conversations": { outcome: "ok", output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "first" }) } }, "prepare-reply": OK });

  const chain = runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "x", approvedBy: "bizops" })}\n`, dir: d }, { runJourney: runner.run });

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_REQUEST" });
});

test("refuses a request missing a required key (E_CHAIN_REQUEST)", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({ "discover-conversations": { outcome: "ok", output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "first" }) } }, "prepare-reply": OK });

  const chain = runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl" })}\n`, dir: d }, { runJourney: runner.run });

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_REQUEST" });
});

test("passes expected_parentid when the record has a parentId and the reply Journey declares it", async () => {
  const d = await setup([replyJourney("prepare-reply-parent", { parent: true })]);
  const runner = fakeRunner({
    "discover-conversations": { outcome: "ok", output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "first" }), "records.0.parentId": "c-0000" } },
    "prepare-reply-parent": OK,
  });

  await runJourneyChain({ from: "discover-conversations", to: "prepare-reply-parent", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "x" })}\n`, dir: d }, { runJourney: runner.run });

  expect(toCalls(runner.calls).map((c) => c.params.expected_parentid)).toEqual(["c-0000"]);
});

test("omits expected_parentid when the reply Journey does not declare it", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({
    "discover-conversations": { outcome: "ok", output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "first" }), "records.0.parentId": "c-0000" } },
    "prepare-reply": OK,
  });

  await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "x" })}\n`, dir: d }, { runJourney: runner.run });

  expect(toCalls(runner.calls).map((c) => "expected_parentid" in c.params)).toEqual([false]);
});

test("the section 5 result echoes neither source text nor reply text", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({
    "discover-conversations": { outcome: "ok", output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "SOURCE_SENTINEL" }) } },
    "prepare-reply": OK,
  });

  const result = await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "REPLY_SENTINEL" })}\n`, dir: d }, { runJourney: runner.run });

  expect(JSON.stringify(result)).not.toMatch(/SOURCE_SENTINEL|REPLY_SENTINEL/);
});

const oneRecord: JourneyRunResult = {
  outcome: "ok",
  output: { "records.count": "1", ...recordOutput(0, { commentId: "c-1001", account: "mcpl", permalink: "/c/1001", threadId: "t-1", sourceText: "Panels arrive Tuesday" }) },
};
const oneRequest = `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "Thanks, see you Tuesday" })}\n`;

test("redacts the reply text a failed run's reason quotes", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({
    "discover-conversations": oneRecord,
    "prepare-reply": { outcome: "quarantined", reason: 'step 7 failed: valueEquals value="Thanks, see you Tuesday"' },
  });

  const result = await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: oneRequest, dir: d }, { runJourney: runner.run });

  expect(result.runs[0]?.reason).toBe('step 7 failed: valueEquals value="<param replyText>"');
});

test("redacts the source text a failed run's reason quotes", async () => {
  const d = await setup([replyJourney("prepare-reply")]);
  const runner = fakeRunner({
    "discover-conversations": oneRecord,
    "prepare-reply": { outcome: "quarantined", reason: 'step 3 failed: textIncludes text="Panels arrive Tuesday"' },
  });

  const result = await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: oneRequest, dir: d }, { runJourney: runner.run });

  expect(result.runs[0]?.reason).toBe('step 3 failed: textIncludes text="<param expected_sourcetext>"');
});

test("passes only the params the reply Journey declares, plus replyText", async () => {
  const narrow: Journey = {
    metadata: { id: "prepare-narrow", name: "Narrow", promoted: true, params: ["commentId", "replyText"], createdAtIso: "2026-09-19T00:00:00Z" },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [{ url: "/c", steps: [
        { step: { kind: "navigate", url: "https://example.test/c/${commentId}", expect: { kind: "urlIncludes", text: "/c/" } } },
        { variableName: "replyText", step: { kind: "fill", target: { testId: "composer" }, value: { var: "replyText" }, expect: { kind: "valueEquals", target: { testId: "composer" }, value: { var: "replyText" } } } },
      ] }],
    },
  };
  const d = await setup([narrow]);
  const runner = fakeRunner({ "discover-conversations": oneRecord, "prepare-narrow": OK });

  await runJourneyChain({ from: "discover-conversations", to: "prepare-narrow", requests: oneRequest, dir: d }, { runJourney: runner.run });

  expect(runner.calls.find((c) => c.id === "prepare-narrow")?.params).toEqual({ commentId: "c-1001", replyText: "Thanks, see you Tuesday" });
});

/** A promoted, parameter-free discover Journey (the fake runner never replays it). */
function discoverJourney(): Journey {
  return {
    metadata: { id: "discover-conversations", name: "Discover", promoted: true, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
    recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "https://example.test/", expect: { kind: "urlIncludes", text: "/" } } }] }] },
  };
}

test("refuses an unpromoted Journey with E_CHAIN_NOT_PROMOTED when promotion is required", async () => {
  const draft = { ...replyJourney("prepare-reply"), metadata: { ...replyJourney("prepare-reply").metadata, promoted: false } };
  const discover = discoverJourney();
  const d = await setup([draft, discover]);
  const runner = fakeRunner({ "discover-conversations": oneRecord, "prepare-reply": OK });

  const chain = runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: oneRequest, dir: d, requirePromoted: true }, { runJourney: runner.run });

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_NOT_PROMOTED" });
});

test("runs nothing when promotion is required and a Journey is a draft", async () => {
  const draft = { ...replyJourney("prepare-reply"), metadata: { ...replyJourney("prepare-reply").metadata, promoted: false } };
  const discover = discoverJourney();
  const d = await setup([draft, discover]);
  const runner = fakeRunner({ "discover-conversations": oneRecord, "prepare-reply": OK });

  await runJourneyChain({ from: "discover-conversations", to: "prepare-reply", requests: oneRequest, dir: d, requirePromoted: true }, { runJourney: runner.run }).catch(() => undefined);

  expect(runner.calls).toHaveLength(0);
});
