import { describe, expect, it } from "vitest";
import { SafetyPolicy, controlRisk, goalAsksFor, validateDenyPatterns } from "./safety.js";

const btn = (name: string, extra: { testId?: string } = {}) => ({
  name,
  role: "button",
  descriptor: { role: "button", name, ...(extra.testId === undefined ? {} : { testId: extra.testId }) },
});

describe("the shared safety policy (#116)", () => {
  it("classifies session-ending, destructive and paid controls by name", () => {
    expect(controlRisk("Sign out")?.risk).toBe("session-end");
    expect(controlRisk("Log out")?.risk).toBe("session-end");
    for (const n of ["Delete", "Revoke", "Rotate", "Remove member", "Close my account"]) expect(controlRisk(n)?.risk, n).toBe("destructive");
    for (const n of ["Run simulated interview", "Run the simulation →", "Generate customer research", "Send invite", "Send interview", "Buy now", "Upgrade"]) {
      expect(controlRisk(n)?.risk, n).toBe("paid");
    }
    for (const n of ["Save", "Show details", "Log in", "Send", "Invite", "Dropdown menu"]) expect(controlRisk(n), n).toBeNull();
    expect(controlRisk("Regenerate API key")?.risk).toBe("destructive");
  });

  it("refuses them by default, lifts them with allowDestructive, and a --deny pattern always holds", () => {
    const p = new SafetyPolicy();
    expect(p.refuses(btn("Sign out"))).toMatchObject({ risk: "session-end" });
    expect(p.refuses(btn("Delete account"))?.reason).toMatch(/--allow-destructive/);
    expect(p.refuses(btn("Save"))).toBeNull();
    const open = new SafetyPolicy({ allowDestructive: true, deny: ["/^archive/i", "role=button;name=Export", "testId=danger"] });
    expect(open.refuses(btn("Delete account"))).toBeNull();
    expect(open.refuses(btn("Archive bet"))).toMatchObject({ risk: "denied" });
    expect(open.refuses(btn("Export CSV"))).toMatchObject({ risk: "denied" });
    expect(open.refuses(btn("Go", { testId: "danger" }))).toMatchObject({ risk: "denied" });
    expect(new SafetyPolicy({ deny: ["Publish"] }).refuses(btn("Publish now"))).toMatchObject({ risk: "denied" });
  });

  it("on a goal run, allows the risky control the goal itself asks for", () => {
    expect(goalAsksFor("Pressure-test the bet by simulating how customers respond", "simulation")).toBe(true);
    expect(goalAsksFor("Delete the draft note", "Delete")).toBe(true);
    expect(goalAsksFor("Sign out and back in", "Sign out")).toBe(true);
    expect(goalAsksFor("Invite Dana", "Send invite")).toBe(false);
    const p = new SafetyPolicy({}, { goal: "Delete the draft note you created" });
    expect(p.refuses(btn("Delete"))).toBeNull();
    expect(p.refuses(btn("Sign out"))).not.toBeNull();
    // --deny wins even over the goal.
    expect(new SafetyPolicy({ deny: ["Delete"] }, { goal: "delete it" }).refuses(btn("Delete"))).toMatchObject({ risk: "denied" });
  });

  it("validates --deny patterns before any browser opens", () => {
    expect(() => validateDenyPatterns(["/(/"])).toThrow(/--deny/);
    expect(() => validateDenyPatterns([" "])).toThrow(/non-empty/);
    expect(() => validateDenyPatterns(["Archive", "/^x$/i", "role=button;name=Go"])).not.toThrow();
  });

  it("#168: a long question/answer merely CONTAINING a risky word is never classified — only a short, verb-led label", () => {
    // The Preveti round-3 repros: a chat question card and a radio answer, each merely containing a
    // risky word deep in a sentence, are never refused.
    expect(controlRisk("No — every user must pay today, so there is no free cohort")).toBeNull();
    expect(controlRisk("No — every user must pay today, so there is no free cohort", "radio")).toBeNull();
    expect(controlRisk("How many qualified PM teams sign up but never start a trial today, and what happens to them?")).toBeNull();
    expect(controlRisk("Which upgrade trigger is primary — usage/capacity limits, locked advanced features, or both — …?")).toBeNull();
    expect(controlRisk("There is a meaningful pool of qualified PM teams who currently never start a trial, and what happens to them?")).toBeNull();
    // The correctly-paid, short verb-led label is still caught.
    expect(controlRisk("Generate customer research")?.risk).toBe("paid");
  });

  it("#168: a radio/checkbox/option answer is never paid unless it explicitly names a charge", () => {
    expect(controlRisk("Start trial", "radio")).toBeNull();
    expect(controlRisk("Upgrade", "checkbox")).toBeNull();
    expect(controlRisk("Buy now", "option")).toBeNull();
    // A choice control that explicitly names a charge is still caught.
    expect(controlRisk("Pay $99/mo", "radio")?.risk).toBe("paid");
    expect(controlRisk("Buy now", "button")?.risk).toBe("paid");
    // Session-end/destructive still classify normal short buttons regardless of role.
    expect(controlRisk("Sign out", "button")?.risk).toBe("session-end");
  });

  it("#168: a refused control is refused by the SafetyPolicy the same way, role-aware", () => {
    const p = new SafetyPolicy();
    expect(p.refuses({ ...btn("No — every user must pay today, so there is no free cohort"), role: "radio" })).toBeNull();
    expect(p.refuses(btn("Generate customer research"))).not.toBeNull();
  });
});
