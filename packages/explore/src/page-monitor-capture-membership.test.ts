import { describe, expect, it } from "vitest";
import { RequestCapture, type CapturedRequest } from "./page-monitor.js";

/**
 * #617: a capture's `sent()` is membership by IDENTITY — the requests whose START that capture saw
 * (`began`), not every request that happened to finish while it was live. `requests()` is still the
 * whole completion history (a request sent before the capture started, finished after it).
 */
function finished(over: Partial<CapturedRequest> & { readonly path: string }): CapturedRequest {
  return { method: "POST", url: `https://app.test${over.path}`, status: 204, failed: false, ...over };
}

describe("RequestCapture membership by identity (#617)", () => {
  it("omits from sent() a request whose start it never saw, even though it finished while live", () => {
    const capture = new RequestCapture();
    capture.ended({}, finished({ path: "/api/late" }));

    expect(capture.sent()).toEqual([]);
  });

  it("keeps in requests() a request whose start it never saw, so the completion history stays whole", () => {
    const capture = new RequestCapture();
    const late = finished({ path: "/api/late" });
    capture.ended({}, late);

    expect(capture.requests()).toEqual([late]);
  });

  it("lists in sent() a request it saw begin while that request is still pending", () => {
    const capture = new RequestCapture();
    capture.began({}, finished({ path: "/api/save" }));

    expect(capture.sent()).toEqual([expect.objectContaining({ path: "/api/save", status: null, pending: true })]);
  });

  it("lists in sent() a request it saw begin with its finished record once it ends", () => {
    const capture = new RequestCapture();
    const key = {};
    capture.began(key, finished({ path: "/api/save" }));
    const done = finished({ path: "/api/save", status: 201 });
    capture.ended(key, done);

    expect(capture.sent()).toEqual([done]);
  });
});
