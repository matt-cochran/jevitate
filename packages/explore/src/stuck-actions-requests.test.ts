import { describe, expect, it } from "vitest";
import { backgroundEndpoints, requestsStartedSince, writesStartedSince, type RequestLog } from "./stuck-actions.js";
import { writeClassifier } from "@jevitate/recording";

/** #241 × #283 / #284 — what counts as the page's background traffic versus an action's own work. */

const O = "http://app.test";
type Logged = ReturnType<RequestLog["pending"]>;
const log = (completed: Logged, pending: Logged = []): RequestLog => ({
  completedSince: (since) => completed.filter((r) => r.startedAt >= since),
  pending: () => pending,
});

describe("request helpers", () => {
  it("an endpoint the page polled before the action is background — unless the run's own earlier turn wrote to it", () => {
    const l = log([
      { url: `${O}/api/balance`, method: "GET", startedAt: 1_000 },
      { url: `${O}/api/chat`, method: "POST", startedAt: 2_000 },
    ]);
    expect([...backgroundEndpoints(l, 5_000)].sort()).toEqual([`GET ${O}/api/balance`, `POST ${O}/api/chat`]);
    expect([...backgroundEndpoints(l, 5_000, new Set([`POST ${O}/api/chat`]))]).toEqual([`GET ${O}/api/balance`]);
  });

  it("writesStartedSince names only the writes started at or after the action, never an ignored beacon", () => {
    const l = log(
      [
        { url: `${O}/api/chat?x=1`, method: "POST", startedAt: 6_000, requestContentType: "application/json" },
        { url: `${O}/api/balance`, method: "GET", startedAt: 6_500 },
        { url: `${O}/api/chat`, method: "POST", startedAt: 4_000 },
        { url: `${O}/t/collect`, method: "POST", startedAt: 6_100, ignored: true },
      ],
      [{ url: `${O}/api/job`, method: "PUT", startedAt: 7_000 }],
    );
    expect(writesStartedSince(l, 5_000, writeClassifier()).sort()).toEqual([`POST ${O}/api/chat`, `PUT ${O}/api/job`]);
  });

  it("a --settle-ignore'd request the action set off is not its effect (#284)", () => {
    const l = log([{ url: `${O}/t/collect`, method: "POST", startedAt: 6_100, ignored: true }]);
    expect(requestsStartedSince(l, 5_000, new Set())).toEqual([]);
  });
});
