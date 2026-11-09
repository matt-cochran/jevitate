import { describe, expect, it } from "vitest";
import { controlRisk } from "../safety.js";
import { detectRunBoundary, detectSession, detectWall, type ObservedControl } from "./boundary.js";

const isPaid = (c: ObservedControl): boolean => controlRisk(c.name)?.risk === "paid";
const wall = (over: Partial<Parameters<typeof detectWall>[0]> = {}) =>
  detectWall({ step: 2, writes: [], controls: [], goal: "export the monthly report", isPaid, ...over });

describe("boundary: wall (#807)", () => {
  it("a 403 document response is a wall with http-403", () => {
    expect(wall({ documentStatus: 403 })).toMatchObject({ kind: "wall", signal: "http-403", step: 2 });
  });
  it("a 401 document response is a wall with http-401", () => {
    expect(wall({ documentStatus: 401 })).toMatchObject({ kind: "wall", signal: "http-401" });
  });
  it("a 403 on a same-origin POST is a wall with http-403", () => {
    expect(wall({ writes: [{ method: "POST", endpoint: "/api/export", status: 403 }] })).toMatchObject({ kind: "wall", signal: "http-403" });
  });
  it("a control named 'Upgrade to Pro' is a wall with paid-control", () => {
    expect(wall({ controls: [{ name: "Upgrade to Pro" }] })).toMatchObject({ kind: "wall", signal: "paid-control" });
  });
  it("a paid control beside the goal's own control is no wall", () => {
    expect(wall({ controls: [{ name: "Upgrade to Pro" }, { name: "Export report" }] })).toBeNull();
  });
  it("a 403 on a cross-origin image yields nothing", () => {
    expect(wall({ documentStatus: 200, writes: [{ method: "GET", endpoint: "https://cdn.example.com/logo.png", status: 403 }] })).toBeNull();
  });
  it("a 403 on a cross-origin write yields nothing", () => {
    expect(wall({ writes: [{ method: "POST", endpoint: "https://t.example.com/beacon", status: 403, thirdParty: true }] })).toBeNull();
  });
  it("a 200 document and a 500 write are no wall", () => {
    expect(wall({ documentStatus: 200, writes: [{ method: "POST", endpoint: "/api/x", status: 500 }] })).toBeNull();
  });
});

describe("boundary: session (#807)", () => {
  const session = (over: Partial<Parameters<typeof detectSession>[0]> = {}) =>
    detectSession({ step: 3, url: "https://app.example.com/login?next=/reports", goal: "export the monthly report", actions: 2, authAttempted: false, leftSignIn: true, ...over });

  it("a settled step on /login is a session boundary when the goal has no sign-in word", () => {
    expect(session()).toMatchObject({ kind: "session", signal: "login-url", step: 3 });
    expect(session({ url: "https://app.example.com/signin" })).toMatchObject({ kind: "session" });
  });
  it("a goal with a sign-in word yields nothing", () => {
    expect(session({ goal: "sign in and open the dashboard" })).toBeNull();
    expect(session({ goal: "log in as the admin" })).toBeNull();
  });
  it("nothing before the first action, after a typed credential, or off a login URL", () => {
    expect(session({ actions: 0 })).toBeNull();
    expect(session({ authAttempted: true })).toBeNull();
    expect(session({ url: "https://app.example.com/reports" })).toBeNull();
  });
  it("nothing for a run that has only ever been on the sign-in page (seeded there): no session was lost", () => {
    expect(session({ leftSignIn: false })).toBeNull();
  });
});

describe("boundary: paid-control needs a page that offers only paid controls (#807)", () => {
  const buy = { name: "Upgrade to Pro", role: "button" };
  const ctxOf = (actions = 1) =>
    ({
      tracker: { actions },
      effectLog: { entries: () => ({ sideEffects: [] }) },
      documentStatus: new Map(),
      docKey: (u: string) => u,
      cfg: { goal: "export the monthly report" },
      safety: { refuses: (c: ObservedControl) => (isPaid(c) ? { risk: "paid" } : null) },
      auth: { attempted: false },
    }) as unknown as Parameters<typeof detectRunBoundary>[0];
  const snap = (controls: ObservedControl[]) => ({ url: "https://app.example.com/reports", controls });

  it("a give-up where the main region offers only a paid control is a wall", () => {
    expect(detectRunBoundary(ctxOf(), snap([buy]), { giveUp: true })).toMatchObject({ kind: "wall", signal: "paid-control" });
  });
  it("a paid control beside other main-region work is no wall: the run can still try it", () => {
    expect(wall({ controls: [{ name: "Upgrade to Pro" }, { name: "Done" }] })).toBeNull();
    expect(detectRunBoundary(ctxOf(), snap([buy, { name: "Save draft" }]), { giveUp: true })).toBeNull();
  });
  it("a disabled or navigation control does not count as other work", () => {
    expect(wall({ controls: [{ name: "Upgrade to Pro" }, { name: "Done", enabled: false }, { name: "Home", landmark: "navigation" }] })).toMatchObject({ signal: "paid-control" });
  });
  it("a settled step names a paid-control wall only after the run acted (never on the seed page before any action)", () => {
    expect(detectRunBoundary(ctxOf(1), snap([buy]))).toMatchObject({ signal: "paid-control" });
    expect(detectRunBoundary(ctxOf(0), snap([buy]))).toBeNull();
    expect(detectRunBoundary(ctxOf(0), snap([buy]), { giveUp: true })).toMatchObject({ signal: "paid-control" });
  });
});
