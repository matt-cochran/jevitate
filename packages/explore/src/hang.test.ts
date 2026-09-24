import { describe, expect, it } from "vitest";
import { classifyHang, hangFingerprint, type HangEvidence } from "./hang.js";

const settled = { settled: true, waitedMs: 600, pending: [] };
const unsettled = { settled: false, waitedMs: 15_000, pending: [] };
const base: HangEvidence = {
  responsive: true,
  settle: settled,
  pendingAgesMs: [],
  stuckBusyIndicator: null,
  requestBoundMs: 10_000,
};

describe("classifyHang — the pure, clock-free hang rule (owner ruling 7)", () => {
  it.each<[string, Partial<HangEvidence>, string | null]>([
    ["a healthy settled page", {}, null],
    ["an unresponsive main thread explains everything", { responsive: false, settle: unsettled, pendingAgesMs: [60_000] }, "main-thread-unresponsive"],
    ["a request pending past its bound", { settle: unsettled, pendingAgesMs: [200, 12_000] }, "request-pending"],
    ["never settled with only young requests (churn)", { settle: unsettled, pendingAgesMs: [300] }, "never-settled"],
    ["never settled with nothing pending (DOM churn)", { settle: unsettled }, "never-settled"],
    ["settled but a busy indicator never went away", { stuckBusyIndicator: "[data-testid=spinner]" }, "ui-no-progress"],
  ])("%s", (_name, e, want) => {
    expect(classifyHang({ ...base, ...e })).toBe(want);
  });

  it("a hang's fingerprint is kind + route (+ the stuck endpoint), not its timing", () => {
    const a = hangFingerprint({ kind: "request-pending", route: "/import", pending: [{ endpoint: "GET /api/job/:id", url: "u1", ageMs: 16_000 }] });
    const b = hangFingerprint({ kind: "request-pending", route: "/import", pending: [{ endpoint: "GET /api/job/:id", url: "u2", ageMs: 90_000 }] });
    const c = hangFingerprint({ kind: "never-settled", route: "/import", pending: [] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("#87: a ui-no-progress hang's fingerprint is the offending ELEMENT, not the route — the same global widget on many routes is ONE identity", () => {
    const onRouteA = hangFingerprint({ kind: "ui-no-progress", route: "/contacts", pending: [], element: '[data-testid=global-progress]' });
    const onRouteB = hangFingerprint({ kind: "ui-no-progress", route: "/companies", pending: [], element: '[data-testid=global-progress]' });
    const differentElement = hangFingerprint({ kind: "ui-no-progress", route: "/contacts", pending: [], element: 'role=spinner <div>' });
    expect(onRouteA).toBe(onRouteB);
    expect(onRouteA).not.toBe(differentElement);
    expect(onRouteA).toMatch(/^[0-9a-f]{16}$/);
  });

  it("#87: a ui-no-progress hang with no identifiable element falls back to route identity", () => {
    const a = hangFingerprint({ kind: "ui-no-progress", route: "/import", pending: [] });
    const b = hangFingerprint({ kind: "ui-no-progress", route: "/export", pending: [] });
    expect(a).not.toBe(b);
  });
});
