import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import {
  FsJourneyStore,
  type HandoffInputsDecl,
  type HandoffOutputsDecl,
  type Journey,
} from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import type { RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { runJourneyChain } from "./journey-chain.js";
import { buildProgram } from "./program.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { CLI_TOOL_SPECS, buildCliArgv } from "./mcp-cli-tools.js";

// #608: the producing (discover) Journey of `journey chain` takes explicit, schema-validated params —
// supplied with `--param`/the MCP `params` object — instead of the fixed `{}`. A producer failure
// reason never echoes a supplied param value.

/** A producing Journey whose Recording binds `threadId` and `replyIdentity` (so both are required). */
function producer(id: string): Journey {
  const bound = (p: string) => ({
    variableName: p,
    step: {
      kind: "select" as const,
      target: { testId: p },
      value: { var: p },
      expect: { kind: "visible" as const, target: { testId: p } },
    },
  });
  return {
    metadata: { id, name: id, promoted: true, params: ["threadId", "replyIdentity"], createdAtIso: "2026-01-01T00:00:00Z" },
    recording: {
      version: "1",
      site: "https://example.test",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "https://example.test/", expect: { kind: "urlIncludes", text: "/" } } },
            bound("threadId"),
            bound("replyIdentity"),
          ],
        },
      ],
    },
  };
}

/** A reply Journey taking only `replyText` (the fixed 0.17.0 mapping then runs it per record). */
function legacyConsumer(id: string): Journey {
  return {
    metadata: { id, name: id, promoted: true, params: ["replyText"], createdAtIso: "2026-01-01T00:00:00Z" },
    recording: {
      version: "1",
      site: "https://example.test",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "https://example.test/", expect: { kind: "urlIncludes", text: "/" } } },
            { variableName: "replyText", step: { kind: "fill", target: { testId: "composer" }, value: { var: "replyText" }, expect: { kind: "valueEquals", target: { testId: "composer" }, value: { var: "replyText" } } } },
          ],
        },
      ],
    },
  };
}

const OUTPUTS: HandoffOutputsDecl = {
  contract: "community-conversation@1",
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
  accepts: "community-conversation@1",
  request: {
    fields: { commentId: { type: "id" }, account: { type: "id" }, replyText: { type: "text" } },
    key: ["commentId", "account"],
  },
  bindings: {
    commentId: { record: "commentId" },
    replyIdentity: { record: "account" },
    threadId: { record: "threadId" },
    replyText: { request: "replyText" },
  },
};

/** A producing Journey with a handoff contract, binding the same two params and extracting the record. */
function handoffProducer(id: string): Journey {
  const bound = (p: string) => ({
    variableName: p,
    step: { kind: "select" as const, target: { testId: p }, value: { var: p }, expect: { kind: "visible" as const, target: { testId: p } } },
  });
  const extract = (as: string) => ({ kind: "extract" as const, target: { testId: "row" }, as, attr: "data-field", expect: { kind: "attr" as const, target: { testId: "row" }, name: "data-field" } });
  return {
    metadata: { id, name: id, promoted: true, params: ["threadId", "replyIdentity"], createdAtIso: "2026-01-01T00:00:00Z", outputs: OUTPUTS },
    recording: {
      version: "1",
      site: "https://example.test",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "https://example.test/", expect: { kind: "urlIncludes", text: "/" } } },
            bound("threadId"),
            bound("replyIdentity"),
            { step: { kind: "forEach", items: { testId: "row" }, as: "records", steps: [extract("commentId"), extract("account"), extract("threadId"), extract("sourceText"), extract("permalink")] } },
          ],
        },
      ],
    },
  };
}

/** A consuming Journey whose `metadata.inputs` bind the accepted record/request. */
function handoffConsumer(id: string): Journey {
  return {
    ...legacyConsumer(id),
    metadata: { ...legacyConsumer(id).metadata, params: ["commentId", "replyIdentity", "threadId", "replyText"], inputs: INPUTS },
  };
}

function recordOutput(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { "records.count": "1" };
  for (const [k, v] of Object.entries(record)) out[`records.0.${k}`] = v;
  return out;
}

const OK: JourneyRunResult = { outcome: "ok", output: {} };

function fakeRunner(byId: Record<string, JourneyRunResult | ((o: RunJourneyProgrammaticallyOptions) => JourneyRunResult)>) {
  const calls: RunJourneyProgrammaticallyOptions[] = [];
  const run = async (o: RunJourneyProgrammaticallyOptions): Promise<JourneyRunResult> => {
    calls.push(o);
    const canned = byId[o.id];
    if (canned === undefined) throw new Error(`fake runner: unexpected journey '${o.id}'`);
    return typeof canned === "function" ? canned(o) : canned;
  };
  return { calls, run };
}

let dir: string;

async function setup(journeys: Journey[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "jev-608-"));
  const store = new FsJourneyStore(dir);
  for (const j of journeys) await store.put(j);
  return dir;
}

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

const REQUEST = `${JSON.stringify({ commentId: "c-1", account: "acct-a", replyText: "hi" })}\n`;
const PRODUCER_RECORD: JourneyRunResult = { outcome: "ok", output: { "records.count": "1", "records.0.commentId": "c-1", "records.0.account": "acct-a" } };

test("runs the producing Journey with exactly the supplied params", async () => {
  const d = await setup([producer("discover"), legacyConsumer("reply")]);
  const runner = fakeRunner({ discover: PRODUCER_RECORD, reply: OK });

  await runJourneyChain(
    { from: "discover", to: "reply", requests: REQUEST, dir: d, params: { threadId: "thread-001", replyIdentity: "acct-a" } },
    { runJourney: runner.run },
  );

  expect(runner.calls.find((c) => c.id === "discover")?.params).toEqual({ threadId: "thread-001", replyIdentity: "acct-a" });
});

test("refuses a missing producer param with E_CHAIN_PARAMS naming it", async () => {
  const d = await setup([producer("discover"), legacyConsumer("reply")]);
  const runner = fakeRunner({ discover: PRODUCER_RECORD, reply: OK });

  const chain = runJourneyChain(
    { from: "discover", to: "reply", requests: REQUEST, dir: d, params: { threadId: "thread-001" } },
    { runJourney: runner.run },
  );

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_PARAMS", message: expect.stringContaining("missing: [replyIdentity]") });
});

test("does not invoke the runner when a required producer param is missing", async () => {
  const d = await setup([producer("discover"), legacyConsumer("reply")]);
  const runner = fakeRunner({ discover: PRODUCER_RECORD, reply: OK });

  await runJourneyChain(
    { from: "discover", to: "reply", requests: REQUEST, dir: d, params: { threadId: "thread-001" } },
    { runJourney: runner.run },
  ).catch(() => undefined);

  expect(runner.calls).toHaveLength(0);
});

test("refuses an unknown producer param with E_CHAIN_PARAMS naming it", async () => {
  const d = await setup([producer("discover"), legacyConsumer("reply")]);
  const runner = fakeRunner({ discover: PRODUCER_RECORD, reply: OK });

  const chain = runJourneyChain(
    { from: "discover", to: "reply", requests: REQUEST, dir: d, params: { threadId: "thread-001", replyIdentity: "acct-a", extra: "z" } },
    { runJourney: runner.run },
  );

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_PARAMS", message: expect.stringContaining("unknown: [extra]") });
});

test("does not invoke the runner for an unknown producer param", async () => {
  const d = await setup([producer("discover"), legacyConsumer("reply")]);
  const runner = fakeRunner({ discover: PRODUCER_RECORD, reply: OK });

  await runJourneyChain(
    { from: "discover", to: "reply", requests: REQUEST, dir: d, params: { threadId: "thread-001", replyIdentity: "acct-a", extra: "z" } },
    { runJourney: runner.run },
  ).catch(() => undefined);

  expect(runner.calls).toHaveLength(0);
});

test.each([
  ["thread-001", "acct-a"],
  ["thread-002", "acct-b"],
])("binds the consumer to the record selected by producer params %s/%s", async (threadId, account) => {
  const d = await setup([handoffProducer("discover"), handoffConsumer("reply")]);
  const runner = fakeRunner({
    discover: (o) => ({ outcome: "ok", output: recordOutput({ commentId: "c-1", account: o.params.replyIdentity ?? "", threadId: o.params.threadId ?? "", sourceText: "src", permalink: "/c/1" }) }),
    reply: OK,
  });
  const request = `${JSON.stringify({ commentId: "c-1", account, replyText: "Line one\n\nLine three" })}\n`;

  await runJourneyChain(
    { from: "discover", to: "reply", requests: request, dir: d, params: { threadId, replyIdentity: account } },
    { runJourney: runner.run },
  );

  expect(runner.calls.find((c) => c.id === "reply")?.params).toEqual({ commentId: "c-1", replyIdentity: account, threadId, replyText: "Line one\n\nLine three" });
});

test("redacts a supplied producer param value quoted in the producer failure reason", async () => {
  const d = await setup([producer("discover"), legacyConsumer("reply")]);
  const runner = fakeRunner({ discover: { outcome: "quarantined", reason: "boom thread-001" }, reply: OK });

  const chain = runJourneyChain(
    { from: "discover", to: "reply", requests: REQUEST, dir: d, params: { threadId: "thread-001", replyIdentity: "acct-a" } },
    { runJourney: runner.run },
  );

  await expect(chain).rejects.toMatchObject({ code: "E_CHAIN_FROM_FAILED", message: "discover Journey 'discover' did not run ok (quarantined): boom <param threadId>" });
});

/** CLI, in process: a draft pair with declared producer params stops at promotion — after param validation. */
async function cliEnvelope(argv: string[]): Promise<Record<string, unknown>> {
  const cli = makeInProcessCliRunner(() => buildProgram({ profiles: new ProfileManager(join(dir, "profiles")), dbPath: join(dir, "site.sqlite") }));
  const out = await cli(argv);
  const line = out.stdout.trim().split("\n").pop() ?? "{}";
  return JSON.parse(line) as Record<string, unknown>;
}

test("CLI journey chain forwards --param so the producer param validation passes", async () => {
  const d = await setup([{ ...producer("discover"), metadata: { ...producer("discover").metadata, promoted: false } }, legacyConsumer("reply")]);
  const requests = join(d, "requests.jsonl");
  await writeFile(requests, REQUEST);

  const envelope = await cliEnvelope(["journey", "chain", "--from", "discover", "--to", "reply", "--requests", requests, "--journeys-dir", d, "--param", "threadId=thread-001", "--param", "replyIdentity=acct-a", "--json"]);

  expect((envelope.error as { code?: string }).code).toBe("E_CHAIN_NOT_PROMOTED");
});

test("CLI journey chain refuses an unknown --param with E_CHAIN_PARAMS", async () => {
  const d = await setup([{ ...producer("discover"), metadata: { ...producer("discover").metadata, promoted: false } }, legacyConsumer("reply")]);
  const requests = join(d, "requests.jsonl");
  await writeFile(requests, REQUEST);

  const envelope = await cliEnvelope(["journey", "chain", "--from", "discover", "--to", "reply", "--requests", requests, "--journeys-dir", d, "--param", "threadId=thread-001", "--param", "replyIdentity=acct-a", "--param", "extra=z", "--json"]);

  expect(envelope.error).toMatchObject({ code: "E_CHAIN_PARAMS" });
});

test("CLI journey chain without --param refuses the missing producer param", async () => {
  const d = await setup([{ ...producer("discover"), metadata: { ...producer("discover").metadata, promoted: false } }, legacyConsumer("reply")]);
  const requests = join(d, "requests.jsonl");
  await writeFile(requests, REQUEST);

  const envelope = await cliEnvelope(["journey", "chain", "--from", "discover", "--to", "reply", "--requests", requests, "--journeys-dir", d, "--json"]);

  expect(envelope.error).toMatchObject({ code: "E_CHAIN_PARAMS" });
});

test("MCP chain_journeys maps a params object to repeated --param flags", () => {
  const spec = CLI_TOOL_SPECS.find((t) => t.name === "chain_journeys")!;

  const argv = buildCliArgv(spec, { from: "a", to: "b", requests: "package.json", params: { threadId: "x", replyIdentity: "y" } }, [process.cwd()]);

  expect(argv.filter((a) => a.startsWith("--param=")).sort()).toEqual(["--param=replyIdentity=y", "--param=threadId=x"]);
});
