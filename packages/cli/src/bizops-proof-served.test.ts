import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBizopsCommunity, type BizopsCommunity } from "../../../test/fixtures/bizops-community/server.js";
import { COMMENT_BY_ID } from "../../../test/fixtures/bizops-community/data.js";
import { verifyJourneyMutations, type JourneyVerifyReport } from "./journey-verify.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #580 — `journey verify --mutate` on the Bizops Journeys (docs/evidence/580-mutation-proof.md): the
 * prepare-only reply is PROVEN on two records (every pre-composer guard, both selections and the
 * exact text), and nothing is ever sent. The discover Journey has nothing to mutate.
 */
const dir = "test/fixtures/bizops-community/.jevitate/journeys";
let app: BizopsCommunity;
const reports = new Map<string, JourneyVerifyReport>();

function replyParams(commentId: string): Record<string, string> {
  const seed = COMMENT_BY_ID.get(commentId)!;
  return {
    commentId,
    replyIdentity: seed.comment.account,
    threadId: seed.thread.id,
    expected_commentid: commentId,
    expected_account: seed.comment.account,
    expected_sourcetext: seed.comment.text,
    replyText: "Thanks!\nWe will confirm by Tuesday.",
  };
}

beforeAll(async () => {
  app = await startBizopsCommunity();
  const environment = { baseUrl: app.url, allowedOrigins: [app.url] };
  reports.set("discover", await verifyJourneyMutations({ dir, id: "discover-conversations", params: {}, environment }));
  for (const id of ["c-2041", "c-4520"]) reports.set(id, await verifyJourneyMutations({ dir, id: "prepare-reply", params: replyParams(id), environment }));
}, 600_000);

afterAll(async () => {
  await app.close();
});

describe("#580 Bizops mutation proof (served)", () => {
  it("proves prepare-reply on a post-314 record", () => {
    expect(reports.get("c-2041")!.verdict).toBe("proven");
  });

  it("proves prepare-reply on a post-207 record", () => {
    expect(reports.get("c-4520")!.verdict).toBe("proven");
  });

  it("proves every prepare-reply check sensitive, with no cascade, error or unpaired check", () => {
    expect(reports.get("c-2041")!.summary).toEqual({ sensitive: 9, insensitive: 0, cascade: 0, notApplied: 0, error: 0, unpaired: 0, targeted: 0 });
  });

  it("calls discover inconclusive because it has nothing to mutate", () => {
    expect(reports.get("discover")!.verdict).toBe("inconclusive");
  });

  it("sends nothing while proving", () => {
    expect(app.submissions()).toBe(0);
  });
});
