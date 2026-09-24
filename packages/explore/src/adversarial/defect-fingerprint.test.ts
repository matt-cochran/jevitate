import { describe, expect, it } from "vitest";
import {
  groupStepSignals,
  invariantFingerprint,
  isResourceLoadEcho,
  messageClass,
  normalizeRoute,
  signalFingerprint,
} from "./defect-fingerprint.js";
import type { DefectSignal } from "./defect-oracle.js";

const http = (url: string, status = 500): DefectSignal => ({ kind: "http-5xx", detail: `${status} ${url}`, url, status });
const consoleErr = (detail: string, pageUrl = "http://app.test/contacts/42"): DefectSignal => ({
  kind: "console-error",
  detail,
  pageUrl,
});

describe("normalizeRoute — the route/endpoint pattern", () => {
  it.each([
    ["http://a.test/api/v1/contacts/12345/notes?page=2#x", "/api/v1/contacts/:id/notes"],
    ["http://a.test/org/3fa85f64-5717-4562-b3fc-2c963f66afa6/lists/", "/org/:id/lists"],
    ["http://a.test/files/9f86d081884c7d65", "/files/:id"],
    ["http://a.test/t/abc123def456ghi789jkl/view", "/t/:id/view"],
    ["http://a.test/dev-org-admin/admin/crm-upload-enrichment", "/dev-org-admin/admin/crm-upload-enrichment"],
    ["http://a.test/", "/"],
    ["/relative/7", "/relative/:id"],
  ])("%s → %s", (raw, want) => {
    expect(normalizeRoute(raw)).toBe(want);
  });
});

describe("messageClass — ids, numbers, urls and quoted values do not split a class", () => {
  it("two occurrences of one bug that differ only in incidental parts share a class", () => {
    expect(messageClass('Order 1234 failed: "abc" at https://x.test/a?b=1')).toBe(
      messageClass('Order 98 failed: "zzz" at https://y.test/c'),
    );
    expect(messageClass("request deadbeef00 took 12.5ms")).toBe("request <id> took <n>ms");
  });
});

describe("signalFingerprint — stable identity", () => {
  it("the same endpoint + status is one fingerprint whatever the id, host or query", () => {
    expect(signalFingerprint(http("http://127.0.0.1:6310/api/v1/tool/billing/payment-methods"))).toBe(
      signalFingerprint(http("https://staging.test/api/v1/tool/billing/payment-methods?x=1")),
    );
    expect(signalFingerprint(http("http://a.test/api/items/1"))).toBe(signalFingerprint(http("http://a.test/api/items/2")));
  });

  it("a different status, endpoint, kind or route is a different defect", () => {
    const base = signalFingerprint(http("http://a.test/api/items/1", 500));
    expect(signalFingerprint(http("http://a.test/api/items/1", 503))).not.toBe(base);
    expect(signalFingerprint(http("http://a.test/api/orders/1", 500))).not.toBe(base);
    expect(signalFingerprint(consoleErr("boom", "http://a.test/a"))).not.toBe(
      signalFingerprint(consoleErr("boom", "http://a.test/b")),
    );
    expect(signalFingerprint(consoleErr("boom"))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("an invariant fingerprint is route + reason class", () => {
    expect(invariantFingerprint("http://a.test/cart/1", "total 12 != 13")).toBe(
      invariantFingerprint("http://b.test/cart/2", "total 7 != 9"),
    );
  });
});

describe("groupStepSignals — one broken call is one defect", () => {
  it("the 5xx is the primary; Chromium's console echo and the app's own logs are evidence", () => {
    const signals: DefectSignal[] = [
      consoleErr("Failed to load resource: the server responded with a status of 500 (Internal Server Error)"),
      http("http://a.test/api/v1/tool/billing/payment-methods"),
      consoleErr("ManageBillingToolApi.request failed: {message: Response returned an error code}"),
    ];
    const group = groupStepSignals(signals);
    expect(group?.primary.kind).toBe("http-5xx");
    expect(group?.fingerprint).toBe(signalFingerprint(http("http://a.test/api/v1/tool/billing/payment-methods")));
    expect(group?.related).toHaveLength(3);
    expect(isResourceLoadEcho(signals[0] as DefectSignal)).toBe(true);
  });

  it("an uncaught page error outranks everything; no signals ⇒ no defect", () => {
    const pageErr: DefectSignal = { kind: "page-error", detail: "TypeError: x is undefined", pageUrl: "http://a.test/" };
    expect(groupStepSignals([http("http://a.test/api"), pageErr])?.primary).toBe(pageErr);
    expect(groupStepSignals([])).toBeNull();
  });
});
