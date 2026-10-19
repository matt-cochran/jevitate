import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import {
  FsJourneyStore,
  type HandoffInputsDecl,
  type HandoffOutputsDecl,
  type Journey,
} from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import type { RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { runJourneyChain } from "./journey-chain.js";

// #582 (docs/contracts/journey-handoff.md §4-§5): when the consuming Journey declares
// `metadata.inputs`, `runJourneyChain` validates compatibility, records, duplicates and
// requests with the pure @jevitate/journey validator and runs `to` once per matched
// request with the bound params — never with the fixed 0.17.0 mapping.

const CONTRACT = "community-conversation@1";

const OUTPUTS: HandoffOutputsDecl = {
  contract: CONTRACT,
  collection: "records",
  key: ["commentId", "account"],
  fields: {
    commentId: { type: "id" },
    account: { type: "id" },
    threadId: { type: "id" },
    sourceText: { type: "text" },
    permalink: { type: "path" },
  },
};

const INPUTS: HandoffInputsDecl = {
  accepts: CONTRACT,
  request: {
    fields: { commentId: { type: "id" }, account: { type: "id" }, replyText: { type: "text" } },
    key: ["commentId", "account"],
  },
  bindings: {
    commentId: { record: "commentId" },
    replyIdentity: { record: "account" },
    threadId: { record: "threadId" },
    expected_commentid: { record: "commentId" },
    expected_account: { record: "account" },
    expected_sourcetext: { record: "sourceText" },
    replyText: { request: "replyText" },
  },
};

const CONSUMER_PARAMS = [
  "commentId",
  "replyIdentity",
  "threadId",
  "expected_commentid",
  "expected_account",
  "expected_sourcetext",
  "replyText",
];

function extractStep(as: string) {
  return { kind: "extract" as const, target: { testId: "row" }, as, attr: "data-field", expect: { kind: "attr" as const, target: { testId: "row" }, name: "data-field" } };
}

/** A producing Journey whose `records` collection extracts every declared output field. */
function producer(id: string, contract = CONTRACT): Journey {
  return {
    metadata: { id, name: id, promoted: true, params: [], createdAtIso: "2026-01-01T00:00:00Z", outputs: { ...OUTPUTS, contract } },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } } },
            {
              step: {
                kind: "forEach",
                items: { testId: "row" },
                as: "records",
                steps: [extractStep("commentId"), extractStep("account"), extractStep("threadId"), extractStep("sourceText"), extractStep("permalink")],
              },
            },
          ],
        },
      ],
    },
  };
}

/** A consuming Journey with `metadata.inputs` binding each param to the accepted record/request. */
function consumer(id: string): Journey {
  const assertAbout = (name: string, value: string) => ({
    step: { kind: "assert" as const, check: { kind: "attr" as const, target: { testId: "comment" }, name, value: { var: value } } },
  });
  return {
    metadata: { id, name: id, promoted: true, params: CONSUMER_PARAMS, createdAtIso: "2026-01-01T00:00:00Z", inputs: INPUTS },
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
            { variableName: "replyText", step: { kind: "fill", target: { testId: "composer" }, value: { var: "replyText" }, expect: { kind: "valueEquals", target: { testId: "composer" }, value: { var: "replyText" } } } },
          ],
        },
      ],
    },
  };
}

const RECORD_FIELDS = ["commentId", "account", "threadId", "sourceText", "permalink"] as const;

/** The indexed `records.<i>.<field>` output the pure `readRecords` reads. */
function recordOutput(records: readonly Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = { "records.count": String(records.length) };
  records.forEach((record, i) => {
    for (const field of RECORD_FIELDS) {
      const value = record[field];
      if (value !== undefined) out[`records.${i}.${field}`] = value;
    }
  });
  return out;
}

const GOOD_RECORD: Record<string, string> = { commentId: "c-1001", account: "mcpl", threadId: "t-1", sourceText: "Panels arrive Tuesday", permalink: "/c/1001" };
const GOOD_REQUEST = `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "Thanks" })}\n`;

function fakeRunner(byId: Record<string, JourneyRunResult>) {
  const calls: RunJourneyProgrammaticallyOptions[] = [];
  const run = async (o: RunJourneyProgrammaticallyOptions): Promise<JourneyRunResult> => {
    calls.push(o);
    const canned = byId[o.id];
    if (canned === undefined) throw new Error(`fake runner: unexpected journey '${o.id}'`);
    return canned;
  };
  return { calls, run };
}

const OK: JourneyRunResult = { outcome: "ok", output: {} };
const toCalls = (calls: RunJourneyProgrammaticallyOptions[]) => calls.filter((c) => c.id === "reply");

let dir: string;

async function setup(journeys: Journey[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "jev-582-"));
  const store = new FsJourneyStore(dir);
  for (const j of journeys) await store.put(j);
  return dir;
}

afterEach(async () => {
  resetClock();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

test("refuses the chain with E_HANDOFF_INCOMPATIBLE when the accepted contract does not match", async () => {
  const d = await setup([producer("discover", "community-conversation@2"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  const chain = runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  await expect(chain).rejects.toMatchObject({ code: "E_HANDOFF_INCOMPATIBLE" });
});

test("runs nothing when the contracts are incompatible", async () => {
  const d = await setup([producer("discover", "community-conversation@2"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run }).catch(() => undefined);

  expect(runner.calls).toHaveLength(0);
});

test("lists a record missing a required field as invalid-record", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const missingSource = { ...GOOD_RECORD } as Record<string, string>;
  delete missingSource.sourceText;
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([missingSource]) }, reply: OK });

  const result = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(result.rejected).toContainEqual(expect.objectContaining({ reason: "invalid-record", errors: [{ field: "sourceText", code: "missing" }] }));
});

test("reports a request matching an invalid record as invalid-record", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const missingSource = { ...GOOD_RECORD } as Record<string, string>;
  delete missingSource.sourceText;
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([missingSource]) }, reply: OK });

  const result = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(result.rejected?.filter((r) => r.reason === "invalid-record")).toHaveLength(2);
});

test("never runs the reply Journey when its matching record is invalid", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const missingSource = { ...GOOD_RECORD } as Record<string, string>;
  delete missingSource.sourceText;
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([missingSource]) }, reply: OK });

  await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(toCalls(runner.calls)).toHaveLength(0);
});

test("reports duplicate record keys as ambiguous for the records and the matching request", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD, { ...GOOD_RECORD, sourceText: "second" }]) }, reply: OK });

  const result = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(result.rejected?.filter((r) => r.reason === "ambiguous")).toHaveLength(3);
});

test("never runs the reply Journey when its matching record is ambiguous", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD, { ...GOOD_RECORD, sourceText: "second" }]) }, reply: OK });

  await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(toCalls(runner.calls)).toHaveLength(0);
});

test("lists a malformed request as invalid-request", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const malformed = `${JSON.stringify({ commentId: "c-1001", account: "mcpl" })}\n`;
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  const result = await runJourneyChain({ from: "discover", to: "reply", requests: malformed, dir: d }, { runJourney: runner.run });

  expect(result.rejected).toContainEqual(expect.objectContaining({ reason: "invalid-request", errors: [{ field: "replyText", code: "missing" }] }));
});

test("never runs the reply Journey for a malformed request", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const malformed = `${JSON.stringify({ commentId: "c-1001", account: "mcpl" })}\n`;
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  await runJourneyChain({ from: "discover", to: "reply", requests: malformed, dir: d }, { runJourney: runner.run });

  expect(toCalls(runner.calls)).toHaveLength(0);
});

test("lists an empty rejected array when every record and request is valid", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  const result = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(result.rejected).toEqual([]);
});

test("runs the reply Journey once with the params the bindings resolve", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(toCalls(runner.calls).map((c) => c.params)).toEqual([
    {
      commentId: "c-1001",
      replyIdentity: "mcpl",
      threadId: "t-1",
      expected_commentid: "c-1001",
      expected_account: "mcpl",
      expected_sourcetext: "Panels arrive Tuesday",
      replyText: "Thanks",
    },
  ]);
});

test("stamps a matched run with the accepted contract", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  const result = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(result.runs[0]?.contract).toBe(CONTRACT);
});

test("stamps a matched run with a fingerprint stable for the same record", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  const first = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });
  const second = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(first.runs[0]?.fingerprint).toBe(second.runs[0]?.fingerprint);
});

test("stamps a matched run with capturedAt from the injectable clock", async () => {
  const startMs = Date.UTC(2026, 4, 1, 12, 0, 0);
  installClock(new FakeClock({ startMs }));
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([GOOD_RECORD]) }, reply: OK });

  const result = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect(result.runs[0]?.capturedAt).toBe(new Date(startMs).toISOString());
});

test("echoes no record text or request text in the handoff result", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: recordOutput([{ ...GOOD_RECORD, sourceText: "SOURCE_SENTINEL" }]) }, reply: OK });

  const result = await runJourneyChain(
    { from: "discover", to: "reply", requests: `${JSON.stringify({ commentId: "c-1001", account: "mcpl", replyText: "REPLY_SENTINEL" })}\n`, dir: d },
    { runJourney: runner.run },
  );

  expect(JSON.stringify(result)).not.toMatch(/SOURCE_SENTINEL|REPLY_SENTINEL/);
});

test("refuses with E_CHAIN_EMPTY when the producing run returns zero records", async () => {
  const d = await setup([producer("discover"), consumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "ok", output: { "records.count": "0" } }, reply: OK });

  const chain = runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_EMPTY" });
});

test("omits rejected from the result when the consuming Journey declares no inputs (0.17.0)", async () => {
  const legacy: Journey = { ...consumer("reply"), metadata: { ...consumer("reply").metadata, inputs: undefined, params: ["commentId", "replyIdentity", "threadId", "expected_commentid", "expected_account", "expected_sourcetext", "replyText"] } };
  // #608: runJourneyChain always loads the producing Journey to validate its params.
  const d = await setup([legacy, producer("discover")]);
  const discover: JourneyRunResult = {
    outcome: "ok",
    output: { "records.count": "1", "records.0.commentId": "c-1001", "records.0.account": "mcpl", "records.0.threadId": "t-1", "records.0.sourceText": "Panels arrive Tuesday", "records.0.permalink": "/c/1001" },
  };
  const runner = fakeRunner({ discover: { outcome: "ok", ...discover }, reply: OK });

  const result = await runJourneyChain({ from: "discover", to: "reply", requests: GOOD_REQUEST, dir: d }, { runJourney: runner.run });

  expect("rejected" in result).toBe(false);
});
