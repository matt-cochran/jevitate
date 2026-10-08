import { describe, expect, it } from "vitest";
import { writeClassifier } from "@jevitate/recording";
import { MissionSafety } from "./mission-safety.js";
import { ReadOnlyGuard } from "./read-only.js";
import { SAFETY_RULES, SafetyPolicy, compileAllowControl, validateAllowControlPatterns } from "./safety.js";
import { safetyRefusalsFromTranscript } from "./adversarial/run-coverage.js";
import { TranscriptLog } from "./transcript.js";
import type { Snapshot } from "./snapshot.js";

const btn = (name: string, role = "button") => ({ name, role, descriptor: { role, name } });
const KEY = "Generate Your First Key";

describe("#428: every refusal names the rule it matched", () => {
  it("the built-in money heuristic: builtin:may-cost-money, its matched words and the control", () => {
    expect(new SafetyPolicy().refuses(btn(KEY))?.refusal).toEqual({
      ruleId: "builtin:may-cost-money",
      pattern: "Generate",
      control: KEY,
      risk: "paid",
      waivable: true,
    });
  });

  it("the money heuristic's reason names the rule and suggests an exact --allow-control", () => {
    expect(new SafetyPolicy().refuses(btn(KEY))?.reason).toBe(
      `refused by the safety policy: "${KEY}" may cost money or contact real people (paid) [rule builtin:may-cost-money, matched "Generate"]; ` +
        `pass --allow-destructive to permit it, or --allow-control "^Generate Your First Key$" to exempt this one control`,
    );
  });

  it("destructive: builtin:destructive, not waivable", () => {
    expect(new SafetyPolicy().refuses(btn("Delete project"))?.refusal).toMatchObject({ ruleId: "builtin:destructive", pattern: "Delete", waivable: false });
  });

  it("session-end: builtin:session-end", () => {
    expect(new SafetyPolicy().refuses(btn("Sign out"))?.refusal.ruleId).toBe("builtin:session-end");
  });

  it("an operator --paid pattern: paid:<pattern>", () => {
    expect(new SafetyPolicy({ paid: ["/^Analyze/"] }).refuses(btn("Analyze now"))?.refusal).toMatchObject({ ruleId: "paid:/^Analyze/", pattern: "/^Analyze/" });
  });

  it("an operator --deny pattern: deny:<pattern>, named in the reason", () => {
    expect(new SafetyPolicy({ deny: ["/^Import$/"] }).refuses(btn("Import"))?.reason).toBe(
      'refused by the safety policy: "Import" matches --deny "/^Import$/" [rule deny:/^Import$/]',
    );
  });

  it("a nameless control under --deny/--paid: builtin:nameless-control", () => {
    expect(new SafetyPolicy({ paid: ["/^Analyze/"] }).refuses(btn(""))?.refusal.ruleId).toBe("builtin:nameless-control");
  });

  it("the read-only guard: read-only:<kind> with the matched words", () => {
    expect(new ReadOnlyGuard(writeClassifier({})).refusal("click", btn("Upgrade"))?.safety).toMatchObject({
      ruleId: "read-only:may-cost-money",
      pattern: "Upgrade",
      waivable: false,
    });
  });

  it("the read-only guard's reason names its rule", () => {
    expect(new ReadOnlyGuard(writeClassifier({})).refuses("click", btn("Save changes"))).toMatch(/\[rule read-only:write-flow, matched "Save"\]$/);
  });

  it("a mission's withheld refusal hands its rule to the recorder", () => {
    let seen: unknown;
    new MissionSafety().withholds("click", btn(KEY), (_reason, refusal) => (seen = refusal.ruleId));
    expect(seen).toBe("builtin:may-cost-money");
  });

  it("the transcript keeps the structured refusal (redacted)", () => {
    const log = new TranscriptLog(["SECRETKEY"]);
    const snapshot = { url: "https://app.test/", signature: "s", controls: [] } as unknown as Snapshot;
    const refusal = new SafetyPolicy().refuses(btn("Generate SECRETKEY"))!.refusal;
    const e = log.record({ op: null, control: null, confidence: null, chosenBy: "strategy", strategy: "safety-policy", actOk: false, safety: refusal, snapshot });
    expect(e.safety?.control).not.toContain("SECRETKEY");
  });

  it("safetyRefusalsFromTranscript reads the structured refusal", () => {
    const safety = new SafetyPolicy().refuses(btn(KEY))!.refusal;
    expect(safetyRefusalsFromTranscript([{ strategy: "safety-policy", actOk: false, reason: "x", safety }])).toEqual([{ name: KEY, risk: "paid" }]);
  });
});

describe("#428: --allow-control exempts a named control from the soft money heuristic only", () => {
  const allow = { allowControl: ["^Generate Your First Key$"] };

  it("waives the built-in money heuristic for the matching control", () => {
    expect(new SafetyPolicy(allow).refuses(btn(KEY))).toBeNull();
  });

  it("does not waive it for a control the regex does not match", () => {
    expect(new SafetyPolicy(allow).refuses(btn("Generate report"))?.refusal.ruleId).toBe("builtin:may-cost-money");
  });

  it("never waives a destructive control", () => {
    expect(new SafetyPolicy({ allowControl: ["^Delete project$"] }).refuses(btn("Delete project"))?.refusal.ruleId).toBe("builtin:destructive");
  });

  it("never waives a session-ending control", () => {
    expect(new SafetyPolicy({ allowControl: ["^Sign out$"] }).refuses(btn("Sign out"))?.refusal.ruleId).toBe("builtin:session-end");
  });

  it("never waives a --deny pattern", () => {
    expect(new SafetyPolicy({ ...allow, deny: ["/Key$/"] }).refuses(btn(KEY))?.refusal.ruleId).toBe("deny:/Key$/");
  });

  it("never waives an operator --paid pattern", () => {
    expect(new SafetyPolicy({ allowControl: ["^Analyze now$"], paid: ["/^Analyze/"] }).refuses(btn("Analyze now"))?.refusal.ruleId).toBe("paid:/^Analyze/");
  });

  it("never waives an operator --paid pattern the heuristic also matched", () => {
    expect(new SafetyPolicy({ ...allow, paid: ["/Key$/"] }).refuses(btn(KEY))?.refusal.ruleId).toBe("paid:/Key$/");
  });

  it("never waives the read-only guard (it is a separate guard)", () => {
    expect(new ReadOnlyGuard(writeClassifier({})).refusal("click", btn(KEY))).not.toBeNull();
  });

  it("is case-sensitive by default", () => {
    expect(new SafetyPolicy({ allowControl: ["^generate your first key$"] }).refuses(btn(KEY))).not.toBeNull();
  });

  it("takes /source/flags for a case-insensitive match", () => {
    expect(new SafetyPolicy({ allowControl: ["/^generate your first key$/i"] }).refuses(btn(KEY))).toBeNull();
  });

  it("records each use with its step, regex, control and the rule it waived", () => {
    const p = new SafetyPolicy(allow);
    p.noteClick(7, btn(KEY));
    expect(p.overrides()).toEqual([{ regex: "^Generate Your First Key$", control: KEY, ruleId: "builtin:may-cost-money", pattern: "Generate", step: 7 }]);
  });

  it("records nothing for a click no exemption was needed for", () => {
    const p = new SafetyPolicy(allow);
    p.noteClick(1, btn("Save"));
    expect(p.overrides()).toEqual([]);
  });

  it("a mission's result carries safetyOverrides", () => {
    const m = new MissionSafety(allow);
    m.mark(3, "click", { ...btn(KEY), summary: KEY });
    expect(m.result().safetyOverrides).toEqual([{ regex: "^Generate Your First Key$", control: KEY, ruleId: "builtin:may-cost-money", pattern: "Generate", step: 3 }]);
  });
});

describe("#428: --allow-control is validated before anything runs", () => {
  it("an invalid regex is refused, naming the flag and pattern", () => {
    expect(() => validateAllowControlPatterns(["^Generate (Key$"])).toThrow(/^--allow-control "\^Generate \(Key\$"/);
  });

  it("an empty pattern is refused", () => {
    expect(() => validateAllowControlPatterns([" "])).toThrow(/non-empty/);
  });

  it("a pattern that matches every name is refused (never a blanket waiver)", () => {
    expect(() => compileAllowControl([".*"])).toThrow(/matches every control name/);
  });

  it("the policy itself fails closed on an invalid pattern", () => {
    expect(() => new SafetyPolicy({ allowControl: ["("] })).toThrow(/--allow-control/);
  });
});

describe("#428: the rule catalog", () => {
  it("only the soft money heuristic is waivable by --allow-control", () => {
    expect(SAFETY_RULES.filter((r) => r.allowControl).map((r) => r.id)).toEqual(["builtin:may-cost-money"]);
  });
});
