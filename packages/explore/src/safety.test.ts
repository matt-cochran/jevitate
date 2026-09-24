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
});
