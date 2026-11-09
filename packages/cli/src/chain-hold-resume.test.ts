import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import type { RunJourneyProgrammaticallyOptions } from "./journey-api.js";

/**
 * #827 (§5.3): a hold a `journey chain` producer reaches records the chain (the consumer's id and the
 * requests file's path, never a value), and `inbox resume` of that hold resumes the producer from its held
 * step and then runs the consumer for each matched request: the whole chain, not only the producer.
 */

const calls = vi.hoisted(() => ({ resumed: [] as unknown[], consumers: [] as Array<Record<string, string>> }));
const FROM: JourneyRunResult = {
  outcome: "ok",
  output: { "records.count": "1", "records.0.commentId": "c-1", "records.0.account": "mcpl", "records.0.permalink": "/c/1", "records.0.threadId": "t-1", "records.0.sourceText": "first" },
};

vi.mock("./journey-hold.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./journey-hold.js")>();
  return {
    ...real,
    resumeHold: async (req: { run?: { onRawOutput?: (o: unknown) => void } }) => {
      calls.resumed.push(req);
      req.run?.onRawOutput?.(FROM.output);
      return { outcome: "resumed", holdId: "hold-0123456789abcdef", fromStep: 1, result: FROM };
    },
  };
});
vi.mock("./journey-api.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./journey-api.js")>();
  return {
    ...real,
    runJourneyProgrammatically: async (o: RunJourneyProgrammaticallyOptions) => {
      calls.consumers.push(o.params);
      return { outcome: "ok", output: {} };
    },
  };
});

const { currentHoldChainContext } = await import("./journey-hold.js");
const { chainSucceeded, resumeChainHold, runJourneyChain } = await import("./journey-chain.js");

const SITE = "https://example.test";
const discover: Journey = {
  metadata: { id: "discover", name: "Discover", promoted: true, params: ["password"], parameters: [{ name: "password", secret: true }], createdAtIso: "2026-11-09T00:00:00Z" },
  recording: {
    version: "1.0.0",
    site: SITE,
    pages: [{ url: "/", steps: [
      { step: { kind: "navigate", url: `${SITE}/`, expect: { kind: "urlIncludes", text: "/" } } },
      { step: { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: { kind: "urlIncludes", text: "/" } } },
    ] }],
  },
} as unknown as Journey;
const reply: Journey = {
  metadata: { id: "reply", name: "Reply", promoted: true, params: ["commentId", "replyText"], createdAtIso: "2026-11-09T00:00:00Z" },
  recording: {
    version: "1.0.0",
    site: SITE,
    pages: [{ url: "/c", steps: [
      { step: { kind: "navigate", url: `${SITE}/c/\${commentId}`, expect: { kind: "urlIncludes", text: "/c/" } } },
      { variableName: "replyText", step: { kind: "fill", target: { testId: "composer" }, value: { var: "replyText" }, expect: { kind: "visible", target: { testId: "composer" } } } },
    ] }],
  },
} as unknown as Journey;

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  calls.resumed.length = 0;
  calls.consumers.length = 0;
});

async function setup(): Promise<{ dir: string; requests: string }> {
  dir = await mkdtemp(join(tmpdir(), "jev-chain-resume-"));
  for (const j of [discover, reply]) await new FsJourneyStore(dir).put(j);
  const requests = join(dir, "requests.jsonl");
  await writeFile(requests, `${JSON.stringify({ commentId: "c-1", account: "mcpl", replyText: "Thanks" })}\n`);
  return { dir, requests };
}

test("the producer's replay carries the chain context a hold records: the consumer and the requests path, no value", async () => {
  const { dir: d, requests } = await setup();
  let seen: unknown;
  await runJourneyChain(
    { from: "discover", to: "reply", requests: "", requestsPath: requests, dir: d, requirePromoted: true, params: { password: "x" } },
    { runJourney: async (o) => (o.id === "discover" ? ((seen = currentHoldChainContext()), { outcome: "quarantined", reason: "held" }) : { outcome: "ok", output: {} }) },
  ).catch(() => undefined);
  expect(seen).toEqual({ to: "reply", requests });
});

test("resuming the producer's hold runs the rest of the chain, with the producer's held secret left to the person", async () => {
  const { dir: d, requests } = await setup();
  const r = await resumeChainHold({ id: "hold-0123456789abcdef", journeysDir: d, params: {} }, { from: "discover", to: "reply", requests });
  expect(calls.resumed).toHaveLength(1);
  expect(r.resumed.outcome).toBe("resumed");
  expect(calls.consumers).toEqual([expect.objectContaining({ commentId: "c-1", replyText: "Thanks" })]);
  expect(chainSucceeded(r.chain!)).toBe(true);
});
