import { describe, expect, it } from "vitest";
import { BLOCKED_CONSEQUENCE_STEPS, blockedCauseOf, blockedWriteCauses, type BlockedRoot } from "./blocked-cause.js";
import type { HangSignal } from "./hang.js";

/** #484: what a write jevitate refused to send set off later in the same session links back to it. */

const root: BlockedRoot = { step: 3, session: 0, method: "POST", path: "http://127.0.0.1:3000/api/upload", busyStarted: 'role=progressbar "Uploading"' };
const beacon: BlockedRoot = { step: 2, session: 0, method: "POST", path: "https://o1.ingest.sentry.io/api/1/envelope/" };
const stuck = (pending: HangSignal["pending"], element = 'role=progressbar "Uploading"'): HangSignal => ({
  kind: "ui-no-progress",
  detail: "busy indicator still visible",
  route: "/files",
  url: "http://localhost:3000/files",
  pending,
  lastState: { signature: "s", controls: [] },
  element,
});

describe("blockedCauseOf (#484)", () => {
  it("links a console error naming the blocked URL a step later to the blocked write", () => {
    const cause = blockedCauseOf([root], { session: 0, step: 4, signals: [{ kind: "console-error", detail: "POST http://127.0.0.1:3000/api/upload net::ERR_BLOCKED_BY_CLIENT" }] });
    expect(cause?.write).toBe("POST http://127.0.0.1:3000/api/upload");
  });

  it("links a failed request with the blocked write's method, origin and path", () => {
    const cause = blockedCauseOf([root], { session: 0, step: 3, signals: [{ kind: "failed-request", detail: "net::ERR_FAILED", url: "http://127.0.0.1:3000/api/upload", method: "POST" }] });
    expect(cause?.step).toBe(3);
  });

  it("links a busy indicator that appeared with the blocked write and never cleared", () => {
    expect(blockedCauseOf([root], { session: 0, step: 4, hang: stuck([]) })?.write).toBe("POST http://127.0.0.1:3000/api/upload");
  });

  it("keeps a generic Failed to fetch after a blocked third-party beacon as the app's", () => {
    expect(blockedCauseOf([beacon], { session: 0, step: 3, signals: [{ kind: "console-error", detail: "TypeError: Failed to fetch" }] })).toBeUndefined();
  });

  it("keeps a fetch error naming the blocked URL outside its action window as the app's", () => {
    expect(
      blockedCauseOf([root], { session: 0, step: 3 + BLOCKED_CONSEQUENCE_STEPS + 1, signals: [{ kind: "console-error", detail: "POST http://127.0.0.1:3000/api/upload failed" }] }),
    ).toBeUndefined();
  });

  it("keeps a stuck busy indicator that did not appear with the blocked write as the app's", () => {
    expect(blockedCauseOf([beacon], { session: 0, step: 3, hang: stuck([]) })).toBeUndefined();
  });

  it("keeps a failed request to the same path on the allowed origin as the app's", () => {
    const sent = { kind: "failed-request" as const, detail: "net::ERR_CONNECTION_RESET", url: "http://localhost:3000/api/upload", method: "POST" };
    expect(blockedCauseOf([root], { session: 0, step: 4, signals: [sent] })).toBeUndefined();
  });

  it("keeps a failed request with another method to the blocked URL as the app's", () => {
    const read = { kind: "failed-request" as const, detail: "net::ERR_FAILED", url: "http://127.0.0.1:3000/api/upload", method: "GET" };
    expect(blockedCauseOf([root], { session: 0, step: 4, signals: [read] })).toBeUndefined();
  });

  it("keeps an error naming only the blocked path as the app's", () => {
    expect(blockedCauseOf([root], { session: 0, step: 4, signals: [{ kind: "page-error", detail: "upload to /api/upload failed" }] })).toBeUndefined();
  });

  it("keeps a busy indicator stuck on a request that was sent as the app's", () => {
    expect(blockedCauseOf([root], { session: 0, step: 4, hang: stuck([{ endpoint: "/api/slow", url: "http://localhost:3000/api/slow", ageMs: 9_000 }]) })).toBeUndefined();
  });

  it("keeps an HTTP 5xx beside the blocked write's error as the app's", () => {
    const cause = blockedCauseOf([root], {
      session: 0,
      step: 4,
      signals: [
        { kind: "console-error", detail: "POST http://127.0.0.1:3000/api/upload failed" },
        { kind: "http-5xx", detail: "HTTP 500 from /api/list", url: "http://localhost:3000/api/list", status: 500 },
      ],
    });
    expect(cause).toBeUndefined();
  });

  it("never links across a session reset", () => {
    expect(blockedCauseOf([root], { session: 1, step: 4, signals: [{ kind: "console-error", detail: "POST http://127.0.0.1:3000/api/upload failed" }] })).toBeUndefined();
  });

  it("never links to a write blocked after the finding", () => {
    expect(blockedCauseOf([root], { session: 0, step: 2, signals: [{ kind: "console-error", detail: "POST http://127.0.0.1:3000/api/upload failed" }] })).toBeUndefined();
  });
});

describe("blockedWriteCauses (#484)", () => {
  it("groups each consequence under the blocked write it links to", () => {
    const consequence = {
      fingerprint: "f1",
      kind: "console-error",
      title: "Console error",
      route: "/files",
      firstSeenStep: 4,
      occurrenceSteps: [4],
      causedBy: { step: 3, write: "POST http://127.0.0.1:3000/api/upload", why: "w" },
    };
    const [cause] = blockedWriteCauses([root, { ...root, step: 7 }], [consequence]);
    expect(cause).toMatchObject({ ruleId: "jevitate:blocked-write", count: 2, consequences: [consequence] });
  });

  it("carries the loopback mismatch warning in the cause message", () => {
    const mismatch = { kind: "loopback-spelling" as const, blockedOrigin: "http://127.0.0.1:3000", allowedOrigin: "http://localhost:3000", message: "add http://127.0.0.1:3000 to --allow" };
    expect(blockedWriteCauses([{ ...root, allowMismatch: mismatch }], [])[0]?.message).toContain("WARNING: add http://127.0.0.1:3000 to --allow");
  });
});
