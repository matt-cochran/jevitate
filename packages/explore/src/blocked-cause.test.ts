import { describe, expect, it } from "vitest";
import { blockedCauseOf, blockedWriteCauses, type BlockedRoot } from "./blocked-cause.js";
import type { HangSignal } from "./hang.js";

/** #484: what a write jevitate refused to send set off later in the same session links back to it. */

const root: BlockedRoot = { step: 3, session: 0, method: "POST", path: "http://127.0.0.1:3000/api/upload" };
const stuck = (pending: HangSignal["pending"]): HangSignal => ({
  kind: "ui-no-progress",
  detail: "busy indicator still visible",
  route: "/files",
  url: "http://localhost:3000/files",
  pending,
  lastState: { signature: "s", controls: [] },
  element: 'progressbar "Uploading"',
});

describe("blockedCauseOf (#484)", () => {
  it("links the page's fetch error a step later to the blocked write", () => {
    const cause = blockedCauseOf([root], { session: 0, step: 4, signals: [{ kind: "console-error", detail: "upload failed: TypeError: Failed to fetch" }] });
    expect(cause?.write).toBe("POST http://127.0.0.1:3000/api/upload");
  });

  it("links a failed request to the blocked write's path", () => {
    const cause = blockedCauseOf([root], { session: 0, step: 5, signals: [{ kind: "failed-request", detail: "net::ERR_FAILED", url: "http://127.0.0.1:3000/api/upload" }] });
    expect(cause?.step).toBe(3);
  });

  it("links a busy indicator stuck with nothing in flight to the blocked write", () => {
    expect(blockedCauseOf([root], { session: 0, step: 6, hang: stuck([]) })?.why).toContain("never cleared");
  });

  it("keeps a busy indicator stuck on a request that was sent as the app's", () => {
    expect(blockedCauseOf([root], { session: 0, step: 6, hang: stuck([{ endpoint: "/api/slow", url: "http://localhost:3000/api/slow", ageMs: 9_000 }]) })).toBeUndefined();
  });

  it("keeps an HTTP 5xx beside the fetch error as the app's", () => {
    const cause = blockedCauseOf([root], {
      session: 0,
      step: 4,
      signals: [
        { kind: "console-error", detail: "Failed to fetch" },
        { kind: "http-5xx", detail: "HTTP 500 from /api/list", url: "http://localhost:3000/api/list", status: 500 },
      ],
    });
    expect(cause).toBeUndefined();
  });

  it("never links across a session reset", () => {
    expect(blockedCauseOf([root], { session: 1, step: 4, signals: [{ kind: "console-error", detail: "Failed to fetch" }] })).toBeUndefined();
  });

  it("never links to a write blocked after the finding", () => {
    expect(blockedCauseOf([root], { session: 0, step: 2, signals: [{ kind: "console-error", detail: "Failed to fetch" }] })).toBeUndefined();
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
