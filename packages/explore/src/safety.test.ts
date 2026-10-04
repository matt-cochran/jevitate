import { describe, expect, it } from "vitest";
import { SafetyPolicy, actionName, controlRisk, goalAsksFor, goalAsksForAction, messageRisk, validateDenyPatterns } from "./safety.js";

const btn = (name: string, extra: { testId?: string } = {}) => ({
  name,
  role: "button",
  descriptor: { role: "button", name, ...(extra.testId === undefined ? {} : { testId: extra.testId }) },
});

describe("the shared safety policy (#116)", () => {
  it("#181: a --paid pattern puts the app's own control in the paid category — refused unless the goal asks for it", () => {
    const paid = { paid: ["/^(Analyze|Draft|Improve|Run)\\b/i"] };
    expect(new SafetyPolicy().riskOf(btn("Analyze now"))).toBeNull();
    const p = new SafetyPolicy(paid);
    expect(p.riskOf(btn("Analyze now"))).toBe("paid");
    expect(p.riskOf(btn("Save"))).toBeNull();
    expect(p.refuses(btn("Analyze now"))).toMatchObject({ risk: "paid" });
    expect(new SafetyPolicy(paid, { goal: 'Click "Analyze now" once and wait for the analysis' }).refuses(btn("Analyze now"))).toBeNull();
    expect(new SafetyPolicy({ ...paid, allowDestructive: true }).refuses(btn("Analyze now"))).toBeNull();
    expect(() => validateDenyPatterns(["/(/"], "--paid")).toThrow(/^--paid/);
  });

  it("#280: a --paid control is matched against the goal by its action word, never its live estimate", () => {
    const paid = { paid: ["/^(Confirm analysis|Confirm and )/i"] };
    const name = "Confirm analysis (≈ 4–10 credits)";
    expect(actionName(name)).toBe("Confirm analysis");
    expect(actionName("Confirm and draft the page · ≈ 50–90 credits")).toBe("Confirm and draft the page");
    expect(actionName("Buy [~$3]")).toBe("Buy");
    expect(actionName("Plan (Pro)")).toBe("Plan (Pro)");
    expect(new SafetyPolicy(paid).riskOf(btn(name))).toBe("paid");
    expect(new SafetyPolicy(paid, { goal: "Import this text and analyze it" }).refuses(btn(name))).toBeNull();
    expect(new SafetyPolicy(paid, { goal: "Draft a landing page about otters" }).refuses(btn("Confirm and draft the page (≈ 50–90 credits)"))).toBeNull();
    // Not asked for: refused, whatever the estimate.
    expect(new SafetyPolicy(paid, { goal: "Find out what the import costs" }).refuses(btn(name))).toMatchObject({ risk: "paid" });
    expect(goalAsksForAction("Confirm the import", "Confirm (≈ 5 credits)")).toBe(false);
    // A built-in label's length cap ignores the estimate too (#168's cap is for question text).
    expect(controlRisk("Generate the weekly summary (≈ 40–90 credits)")?.risk).toBe("paid");
  });

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

  it("classifies resetting or switching off a credential or security factor as destructive (#333)", () => {
    for (const n of [
      "Reset authenticator",
      "Reset authenticator app",
      "Reset your password",
      "Disable two-factor",
      "Disable two-factor authentication",
      "Turn off 2FA",
      "Turn off MFA",
      "Remove 2FA",
      "Regenerate recovery codes",
      "Revoke sessions",
      "End all sessions",
      "Delete passkey",
      "Unlink security key",
    ]) {
      expect(controlRisk(n)?.risk, n).toBe("destructive");
    }
    // A bare reset, or a reset of something that is not a credential, is not one.
    for (const n of ["Reset", "Reset filters", "Reset form", "Show password", "Two-factor settings", "Set up authenticator"]) {
      expect(controlRisk(n), n).toBeNull();
    }
    const p = new SafetyPolicy();
    expect(p.refuses(btn("Reset authenticator"))?.reason).toMatch(/is destructive.*--allow-destructive/);
    expect(new SafetyPolicy({ allowDestructive: true }).refuses(btn("Reset authenticator"))).toBeNull();
    expect(goalAsksFor("Reset my authenticator app", "Reset authenticator")).toBe(true);
    expect(goalAsksFor("Check the security settings", "Reset authenticator")).toBe(false);
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
    // #235: a goal that orders the thing itself ("Invite …") asks for "Send invite"; a mention does not.
    expect(goalAsksFor("Invite Dana", "Send invite")).toBe(true);
    expect(goalAsksFor("Invite a teammate to your workspace. Use the email jevitate-teammate@example.com.", "Send invite")).toBe(true);
    expect(goalAsksFor("Open Team, then invite a teammate", "Send invite")).toBe(true);
    expect(goalAsksFor("Report the invite's status", "Send invite")).toBe(false);
    expect(goalAsksFor("Go to Invitations and count them", "Send invitations")).toBe(false);
    expect(goalAsksFor("Find the email address on the profile", "Send email")).toBe(false);
    expect(new SafetyPolicy({}, { goal: "Invite a teammate to your workspace." }).refuses(btn("Send invite"))).toBeNull();
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

describe("native dialog verdicts (#334)", () => {
  const confirm = (message: string) => ({ type: "confirm", message });

  it("dismisses a confirm/prompt by default, accepts an alert, never confirms leaving the page", () => {
    const p = new SafetyPolicy();
    expect(p.dialogVerdict(confirm("Save changes?"))).toMatchObject({ action: "dismiss", why: expect.stringMatching(/--dialogs accept/) });
    expect(p.dialogVerdict({ type: "prompt", message: "Name?" }).action).toBe("dismiss");
    expect(p.dialogVerdict({ type: "alert", message: "Saved" }).action).toBe("accept");
    expect(new SafetyPolicy({ dialogs: "accept" }).dialogVerdict({ type: "beforeunload", message: "" }).action).toBe("dismiss");
  });

  it("accept confirms, unless the message names a risky action the run may not take", () => {
    const p = new SafetyPolicy({ dialogs: "accept" });
    expect(p.dialogVerdict(confirm("Save changes?")).action).toBe("accept");
    expect(p.dialogVerdict(confirm("Revoke consent? This can't be undone."))).toMatchObject({ action: "dismiss", why: expect.stringMatching(/destructive.*Revoke/) });
    expect(p.dialogVerdict(confirm("Buy 50 credits for $10?")).action).toBe("dismiss");
    expect(new SafetyPolicy({ dialogs: "accept", allowDestructive: true }).dialogVerdict(confirm("Revoke consent?")).action).toBe("accept");
    expect(new SafetyPolicy({ dialogs: "accept" }, { goal: "Revoke the showcase consent" }).dialogVerdict(confirm("Revoke consent?")).action).toBe("accept");
    expect(new SafetyPolicy({ dialogs: "accept", allowDestructive: true, deny: ["/archive/"] }).dialogVerdict(confirm("Archive it?"))).toMatchObject({
      action: "dismiss",
      why: expect.stringMatching(/--deny/),
    });
  });

  it("classifies a dialog message with no label-length cap", () => {
    expect(messageRisk("Are you sure? This will permanently delete the project and every report in it.")).toMatchObject({ risk: "destructive", matched: "delete" });
    expect(messageRisk("Leave this page? Changes you made may not be saved.")).toBeNull();
  });
});
