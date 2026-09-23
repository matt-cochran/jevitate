import { describe, expect, it } from "vitest";
import { fingerprintMarker } from "@jevitate/domain";
import { draftForCrash, draftForDefect, type DraftContext } from "./issue-draft.js";
import { buildCrashReport, jevitateCodeRoots } from "./crash-report.js";
import type { AdversarialDefect } from "./missions/adversarial.js";
import type { TranscriptEntry } from "./transcript.js";

const SECRET = "Sup3r-S3cret-Passw0rd";

const step: TranscriptEntry = {
  step: 1,
  op: "type",
  target: `textbox "Password" (value="${SECRET}")`,
  confidence: null,
  chosenBy: "strategy",
  strategy: "boundary-input",
  actOk: true,
  reason: `typed ${SECRET}`,
  url: `http://app.test/login?next=${SECRET}`,
  signature: "s",
  controlCount: 3,
};

const defect: AdversarialDefect = {
  fingerprint: "0123456789abcdef",
  related: ["0123456789abcdef"],
  kind: "http-5xx",
  title: `HTTP 500 from /api/login/${SECRET}`,
  route: "/login",
  url: "http://app.test/login",
  signals: [{ kind: "http-5xx", detail: `500 http://app.test/api/login?pw=${SECRET}`, url: "http://app.test/api/login", status: 500 }],
  firstSeenStep: 1,
  occurrences: 2,
  occurrenceSteps: [1, 3],
  repro: { steps: [step], recordingStepIndex: 1 },
  triage: { status: "available", summary: `the server echoed ${SECRET}`, likelyCause: "x" },
};

const ctx: DraftContext = {
  environment: { os: "linux x64", node: "v22.0.0", target: "http://app.test" },
  recordingPath: "/tmp/adversarial-x.json",
  verifyCommand: "jevitate verify-fix --result /tmp/adversarial-x.result.json --fingerprint 0123456789abcdef",
  secrets: [SECRET],
};

describe("issue drafts — ready to file, and redacted (owner ruling 3)", () => {
  it("a defect draft carries repro steps, environment, evidence and the fingerprint marker", () => {
    const d = draftForDefect(defect, ctx);
    expect(d.attribution).toBe("system-under-test");
    expect(d.targets).toEqual(["system-under-test"]);
    expect(d.body).toContain("## Steps to reproduce");
    expect(d.body).toContain("## Environment");
    expect(d.body).toContain("## Evidence");
    expect(d.body).toContain("flat step index 1");
    expect(d.body).toContain("jevitate verify-fix");
    expect(d.body.endsWith(fingerprintMarker("0123456789abcdef"))).toBe(true);
  });

  it("a --secret value NEVER appears in a draft — not in the title, steps, evidence or triage", () => {
    const d = draftForDefect(defect, ctx);
    expect(d.title).not.toContain(SECRET);
    expect(d.body).not.toContain(SECRET);
    expect(JSON.stringify(d)).not.toContain(SECRET);

    const crash = buildCrashReport(
      { kind: "exception", message: `boom with ${SECRET}`, stack: `Error: boom with ${SECRET}\n    at f (/x.js:1:1)` },
      { pageCrashed: false, pageClosed: false, browserDisconnected: false },
      [],
    );
    const c = draftForCrash(crash, [step], ctx);
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });

  it("a crash thrown from jevitate's own code (no crash signal) is attributed to jevitate", () => {
    const err = new Error("engine bug");
    const report = buildCrashReport(
      { kind: "exception", message: err.message, ...(err.stack === undefined ? {} : { stack: err.stack }) },
      { pageCrashed: false, pageClosed: false, browserDisconnected: false },
      [],
    );
    expect(jevitateCodeRoots()).toHaveLength(1);
    expect(report.attribution.attribution).toBe("jevitate");
    const d = draftForCrash(report, [], ctx);
    expect(d.targets).toEqual(["jevitate"]);
    expect(d.body).toContain("(the crash happened before the first step)");
  });

  it("a navigation that timed out is the app not loading (hang evidence), even through jevitate's own stack", () => {
    const err = new Error("page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to \"http://app.test/x\", waiting until \"load\"");
    const report = buildCrashReport(
      { kind: "exception", message: err.message.split("\n")[0] ?? "", ...(err.stack === undefined ? {} : { stack: err.stack }) },
      { pageCrashed: false, pageClosed: false, browserDisconnected: false },
      [],
    );
    expect(report.evidence.hang).toBe(true);
    expect(report.attribution).toEqual({ attribution: "system-under-test", reasons: ["the app under test hung"] });
  });

  it("a renderer crash is the system under test's, and an uncertain crash is routed to both", () => {
    const crashed = buildCrashReport(
      { kind: "page-crash", message: "Target crashed" },
      { pageCrashed: true, pageClosed: true, browserDisconnected: false },
      [{ step: 1, usedBytes: 990, limitBytes: 1000 }],
    );
    expect(crashed.attribution.attribution).toBe("system-under-test");
    expect(crashed.evidence.rendererOom).toBe(true);

    const unknown = buildCrashReport(
      { kind: "exception", message: "?", stack: "Error: ?\n    at x (/elsewhere/lib.js:1:1)" },
      { pageCrashed: false, pageClosed: false, browserDisconnected: false },
      [],
    );
    expect(draftForCrash(unknown, [], ctx).targets).toEqual(["jevitate", "system-under-test"]);
  });
});
