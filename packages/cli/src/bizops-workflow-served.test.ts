import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { FsJourneyStore, JourneyRegistry, ParamValidationError, flatJourneySteps } from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { COMMENT_BY_ID, SEED_COMMENTS } from "../../../test/fixtures/bizops-community/data.js";
import { startBizopsCommunity } from "../../../test/fixtures/bizops-community/server.js";
import { useSkippingTime } from "../../explore/src/testkit.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
import { runJourneyChain, type JourneyChainResult } from "./journey-chain.js";
import { runJourneyProgrammatically } from "./journey-api.js";

// #304: Node and page time skip idle waits; the real Chromium assertions are unchanged.
useSkippingTime({ per: "all" });

/**
 * #580 served acceptance: the two-journey Bizops comment workflow, end to end in real Chromium.
 * The offline fixture app (test/fixtures/bizops-community) is driven through the committed Journeys
 * (`discover-conversations`, `prepare-reply`) by `runJourneyChain` and `runJourneyProgrammatically`,
 * exactly as `jevitate journey chain` would. The fixture server starts once per file; every test
 * runs against the same in-memory submission counter so a Send anywhere would be observable.
 */

const JOURNEYS_DIR = fileURLToPath(new URL("../../../test/fixtures/bizops-community/.jevitate/journeys", import.meta.url));

let app: Awaited<ReturnType<typeof startBizopsCommunity>>;

beforeAll(async () => {
  app = await startBizopsCommunity();
});

afterAll(async () => {
  await app.close();
});

/** The environment both runs are moved onto: the live fixture origin, and nothing else. */
function environment(): ResolvedJourneyEnvironment {
  return { baseUrl: app.url, allowedOrigins: [app.url], source: "bizops-community fixture" };
}

/** Real Chromium, with the testkit's skipping clock already wrapping the port. */
const browserPort = (): PlaywrightBrowserPort => new PlaywrightBrowserPort();

/** The three approved requests §4: three different replies, one multiline, across three records. */
const CHAIN_REQUESTS = [
  { commentId: "c-2041", account: "mcpl", replyText: "The crew can still start on the ninth; we will confirm the freight lift." },
  { commentId: "c-1007", account: "personal", replyText: "Tuesday works for the panels.\nWe will book the lift for the ninth." },
  { commentId: "c-4520", account: "personal", replyText: "Yes — the season pass covers the Fictional Forge workshop." },
] as const;

const requestLines = `${CHAIN_REQUESTS.map((r) => JSON.stringify(r)).join("\n")}\n`;

function runChain(requests: string): Promise<JourneyChainResult> {
  return runJourneyChain({
    from: "discover-conversations",
    to: "prepare-reply",
    requests,
    dir: JOURNEYS_DIR,
    environment: environment(),
    browserPortFactory: browserPort,
  });
}

/** The prepare-reply Journey's own reply-text fill step (1-based), read from the committed file. */
async function replyTextFillStep(): Promise<number> {
  const journey = await new JourneyRegistry(new FsJourneyStore(JOURNEYS_DIR)).get("prepare-reply");
  if (journey === null) throw new Error("prepare-reply is not in the fixture journeys");
  const fill = flatJourneySteps(journey).find((s) => s.recorded.stepId === "s-reply-text");
  if (fill === undefined) throw new Error("prepare-reply has no s-reply-text step");
  return fill.index + 1;
}

/** The `step N failed` position of a quarantined run; a non-quarantined result fails the test. */
function failedStep(result: JourneyRunResult): number {
  const reason = "reason" in result ? result.reason : "";
  const match = /step (\d+) failed/.exec(reason);
  if (match === null) throw new Error(`expected a quarantined run, got ${result.outcome}: ${reason}`);
  return Number.parseInt(match[1]!, 10);
}

/** A correct record's §3 params, read from the seeded fixture data (never hard-coded). */
function recordParams(commentId: string, replyText: string): Record<string, string> {
  const seed = COMMENT_BY_ID.get(commentId);
  if (seed === undefined) throw new Error(`no seeded comment ${commentId}`);
  return {
    commentId,
    replyIdentity: seed.comment.account,
    threadId: seed.thread.id,
    expected_commentid: commentId,
    expected_account: seed.comment.account,
    expected_sourcetext: seed.comment.text,
    replyText,
  };
}

describe("#580 the two-journey chain over the committed Journeys (served)", () => {
  let result: JourneyChainResult;
  beforeAll(async () => {
    result = await runChain(requestLines);
  });

  it("runs every matched request to ok", () => {
    expect(result.runs.map((r) => r.outcome)).toEqual(["ok", "ok", "ok"]);
  });

  it("leaves no request unmatched", () => {
    expect(result.unmatched).toEqual([]);
  });

  it("submits nothing to the community site", () => {
    expect(app.submissions()).toBe(0);
  });

  it("echoes no reply text or seeded source text in its JSON", () => {
    const json = JSON.stringify(result);
    const texts = [...CHAIN_REQUESTS.map((r) => r.replyText), ...SEED_COMMENTS.map((s) => s.comment.text)];
    const leaked = texts.some((t) => [t, JSON.stringify(t).slice(1, -1)].some((form) => json.includes(form)));
    expect(leaked).toBe(false);
  });
});

describe("#580 a chain request whose account does not match the record (served)", () => {
  let result: JourneyChainResult;
  beforeAll(async () => {
    // c-2041 really belongs to `mcpl`; the request claims `personal`.
    result = await runChain(`${JSON.stringify({ commentId: "c-2041", account: "personal", replyText: "Not mine to send." })}\n`);
  });

  it("lists the mismatched request as unmatched", () => {
    expect(result.unmatched).toEqual([{ commentId: "c-2041", account: "personal" }]);
  });

  it("runs prepare-reply for none of the mismatched requests", () => {
    expect(result.runs).toEqual([]);
  });
});

describe("#580 prepare-reply refuses a mutated identity before the composer (served)", () => {
  const base = recordParams("c-2041", "An approved reply for the pier thread.");
  const otherSeed = COMMENT_BY_ID.get("c-1007")!;
  const baseSeed = COMMENT_BY_ID.get("c-2041")!;
  const otherThread = baseSeed.post.threads.find((t) => t.id !== baseSeed.thread.id)!;

  const MUTATIONS: ReadonlyArray<{ readonly name: string; readonly params: Record<string, string> }> = [
    { name: "a wrong expected_commentid (another real id)", params: { ...base, expected_commentid: otherSeed.comment.id } },
    { name: "a wrong expected_account", params: { ...base, expected_account: otherSeed.comment.account } },
    { name: "a changed expected_sourcetext", params: { ...base, expected_sourcetext: `${base.expected_sourcetext} (amended)` } },
    { name: "a valid replyIdentity that is not the record's account", params: { ...base, replyIdentity: otherSeed.comment.account } },
    { name: "a valid threadId that is not the record's thread", params: { ...base, threadId: otherThread.id } },
    { name: "a commentId of a different conversation than the expected_* values", params: { ...base, commentId: otherSeed.comment.id } },
  ];

  const results = new Map<string, JourneyRunResult>();
  let fillStep = 0;

  beforeAll(async () => {
    fillStep = await replyTextFillStep();
    for (const mutation of MUTATIONS) {
      results.set(
        mutation.name,
        await runJourneyProgrammatically({
          dir: JOURNEYS_DIR,
          id: "prepare-reply",
          params: mutation.params,
          environment: environment(),
          browserPortFactory: browserPort,
        }),
      );
    }
  });

  for (const mutation of MUTATIONS) {
    it(`refuses ${mutation.name} at a step before the reply-text fill`, () => {
      expect(failedStep(results.get(mutation.name)!)).toBeLessThan(fillStep);
    });
  }

  it("submits nothing while refusing every mutated identity", () => {
    expect(app.submissions()).toBe(0);
  });
});

describe("#580 prepare-reply param validation (served)", () => {
  it("refuses a run missing expected_commentid before opening a browser", async () => {
    const params = recordParams("c-2041", "An approved reply.");
    delete params.expected_commentid;
    await expect(
      runJourneyProgrammatically({
        dir: JOURNEYS_DIR,
        id: "prepare-reply",
        params,
        environment: environment(),
        // Reaching this factory would mean validation ran after the browser step; it must not.
        browserPortFactory: () => {
          throw new Error("a browser was opened before param validation");
        },
      }),
    ).rejects.toBeInstanceOf(ParamValidationError);
  });
});