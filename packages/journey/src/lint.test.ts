import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Recording, RecordedStep, Step } from "@jevitate/recording";
import { lintJourney, lintUploadFixtures, planJourneyMutations, judgeAssertions, mutationProofVerdict, type Journey, type MutationRunResult } from "./index.js";

// #401 Part A — the pure assertion-strength lint. Fixtures are small inline Journeys (see
// assertions.test.ts / journey.test.ts for the shape).

const meta = { id: "lint", name: "Lint", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00Z" };

function rec(steps: RecordedStep[]): Recording {
  return { version: "1", site: "http://localhost:3000", pages: [{ url: "/editor", steps }] };
}

function j(steps: RecordedStep[], metadata: Partial<Journey["metadata"]> = {}): Journey {
  return { metadata: { ...meta, ...metadata }, recording: rec(steps) };
}

const publishWrite = ["POST /portal.v1.OwnerSiteEditService/PublishSiteEdits → 200"];
const publishResponse = [{ kind: "responseStatus", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PublishSiteEdits", status: { class: 2 } }] as const;
const reloadThen = [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }] as const;

describe("#401 lintJourney", () => {
  it("rejects a role-only assertion target before replay", () => {
    const findings = lintJourney(j([{ step: { kind: "assert", check: { kind: "textIncludes", target: { role: "status" }, text: "Published" } } }]), { strictTargets: true });
    expect(findings).toContainEqual(expect.objectContaining({ rule: "unusable-target", level: "error", step: 1 }));
  });

  it("accepts a role and exact accessible name assertion target", () => {
    const findings = lintJourney(j([{ step: { kind: "assert", check: { kind: "textIncludes", target: { role: "status", name: "Publication status" }, text: "Published" } } }]), { strictTargets: true });
    expect(findings.some((f) => f.rule === "unusable-target")).toBe(false);
  });

  it("flags own-target-visible for a step whose expect is its own target visible", () => {
    const journey = j([
      { step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } } },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "own-target-visible" && f.step === 1)).toBe(true);
  });

  it("does not flag own-target-visible when the expect checks a changed result", () => {
    const journey = j([
      { step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } } },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "own-target-visible")).toBe(false);
  });

  it("flags write-without-effect on the issue's publish step whose end state checks another request", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { networkChecks: [{ kind: "requestMade", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PreviewSiteEdits" }] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "write-without-effect" && f.step === 1)).toBe(true);
  });

  it("flags own-target-visible on the issue's publish step", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { networkChecks: [{ kind: "requestMade", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PreviewSiteEdits" }] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "own-target-visible" && f.step === 1)).toBe(true);
  });

  it("does not flag write-without-effect when the last write has a matching end-state network check", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { networkChecks: [{ kind: "responseStatus", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PublishSiteEdits", status: { class: 2 } }] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "write-without-effect")).toBe(false);
  });

  it("does not flag write-without-effect when the write step carries a step-request check", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
        delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        expectRequests: [...publishResponse],
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "write-without-effect")).toBe(false);
  });

  it("does not flag write-without-effect for the final write when the end state has a page effect", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "write-without-effect")).toBe(false);
  });

  it("flags visibility-only when a Journey asserts only visibility", () => {
    const journey = j([{ step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { testId: "editor" } } } }]);
    expect(lintJourney(journey).some((f) => f.rule === "visibility-only" && f.step === undefined)).toBe(true);
  });

  it("does not flag visibility-only when a step asserts a concrete effect", () => {
    const journey = j([
      { step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } } },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "visibility-only")).toBe(false);
  });

  it("flags nothing-after-last-write when no effect assertion follows the last write", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
        delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "nothing-after-last-write")).toBe(true);
  });

  it("does not flag nothing-after-last-write when an effect assertion follows the last write", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
        delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
      },
      { step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "live" }, text: "published" } } },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "nothing-after-last-write")).toBe(false);
  });

  it("does not flag nothing-after-last-write when the end state checks the outcome", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
          delta: { verdict: "relevant-change", why: "published", changes: ["status"], requests: publishWrite, overheadMs: 1 },
        },
      ],
      { endState: [...reloadThen] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "nothing-after-last-write")).toBe(false);
  });

  it("flags no-persistence-check when a write has no reloadThen end-state check", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
        expectRequests: [...publishResponse],
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "no-persistence-check")).toBe(true);
  });

  it("does not flag no-persistence-check when the end state reloads and checks persistence", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status", name: "Publication status" }, text: "Published" } },
          expectRequests: [...publishResponse],
        },
      ],
      { endState: [...reloadThen] },
    );
    expect(lintJourney(journey).some((f) => f.rule === "no-persistence-check")).toBe(false);
  });

  it("flags intent-uncovered for a documented expectedResult with no effect assertion", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "visible", target: { testId: "publish" } } },
        expectedResult: "the site is live",
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "intent-uncovered" && f.step === 1)).toBe(true);
  });

  it("#659: does not flag intent-uncovered on a waitFor step, whose target and state are its checked outcome", () => {
    const journey = j([
      {
        step: { kind: "waitFor", target: { testId: "conversation-handoff" }, state: "visible" },
        objective: "Wait for the populated asynchronous handoff before extraction",
        expectedResult: "The populated handoff is visible before any extraction.",
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "intent-uncovered")).toBe(false);
  });

  it("does not flag intent-uncovered when the step asserts its effect", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
        expectedResult: "the site is live",
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "intent-uncovered")).toBe(false);
  });

  it("returns no findings for a write step with a step-request check and a reloadThen end state", () => {
    const journey = j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status", name: "Publication status" }, text: "Published" } },
          expectRequests: [...publishResponse],
        },
      ],
      { endState: [...reloadThen] },
    );
    expect(lintJourney(journey)).toEqual([]);
  });

  it("flags no-persistence-check for a relevant-change step with no recorded requests", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
        delta: { verdict: "relevant-change", why: "state changed", changes: ["status"], overheadMs: 1 },
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "no-persistence-check")).toBe(true);
  });

  it("retains explicit uncertainty for a relevant UI transition with only recorded reads", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "use-template" }, expect: { kind: "textIncludes", target: { role: "heading" }, text: "Campaign Objective" } },
        delta: {
          verdict: "relevant-change",
          why: "template context loaded into an unsaved draft",
          changes: ["heading"],
          requests: ["GET /api/v1/tool/organizations/agent-profiles → 200"],
          overheadMs: 1,
        },
      },
    ]);
    expect(lintJourney(journey).find((f) => f.rule === "no-persistence-check")).toMatchObject({ level: "warning", message: "UI effect at step 1 has incomplete write coverage; persistence requirements are unresolved." });
  });

  it("flags no-persistence-check for a step whose expectRequests names a write request", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "save" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Saved" } },
        expectRequests: [{ kind: "requestMade", method: "POST", pathGlob: "/api/items" }],
      },
    ]);
    expect(lintJourney(journey).some((f) => f.rule === "no-persistence-check")).toBe(true);
  });

  it("does not treat a step as a write when opts.readRequests marks its request a read", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "estimate" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Estimated" } },
        delta: { verdict: "inconclusive", why: "read rpc", changes: [], requests: ["POST /pkg.Billing/EstimateCost → 200"], overheadMs: 1 },
      },
    ]);
    expect(lintJourney(journey, { readRequests: ["Estimate*"] }).some((f) => f.rule === "no-persistence-check")).toBe(false);
  });

  it("keeps a configured REST POST classified read while retaining partial-capture uncertainty", () => {
    const journey = j([
      {
        step: { kind: "click", target: { testId: "companies" }, expect: { kind: "textIncludes", target: { role: "heading" }, text: "Companies" } },
        delta: { verdict: "relevant-change", why: "query rendered companies", changes: ["Companies heading"], requests: ["POST /api/v1/tool/crm-companies/query → 200"], overheadMs: 1 },
      },
    ]);
    expect(lintJourney(journey, { readRequests: ["/api/v1/tool/crm-companies/query"] }).find((f) => f.rule === "no-persistence-check")).toMatchObject({ level: "warning", message: "UI effect at step 1 has incomplete write coverage; persistence requirements are unresolved." });
  });
});

describe("local visible UI outcomes remain separate from HTTP effects", () => {
  function templates(requests?: string[]): RecordedStep {
    return {
      step: {
        kind: "click", target: { testId: "tool-sub-nav-item-templates", display: { role: "button", name: "TemplatesCampaign templates" } },
        expect: { kind: "visible", target: { testId: "instant-campaign-templates-heading" } },
      },
      expectedResult: "The Templates heading is visible",
      delta: { verdict: "relevant-change", why: "Templates opened", changes: ["Templates heading"], overheadMs: 1, ...(requests === undefined ? {} : { requests }) },
    };
  }

  it("credits the actual Templates own heading assertion consistently without clearing persistence uncertainty", () => {
    const journey = j([templates()]);
    expect(lintJourney(journey).map((f) => ({ rule: f.rule, level: f.level }))).toEqual([{ rule: "no-persistence-check", level: "warning" }]);
    expect(planJourneyMutations(journey)).toEqual({ mutations: [{ kind: "skip", step: 1, id: "skip:1" }], pairs: [{ site: "step:1", mutation: "skip:1" }] });
  });

  it("credits a different dialog's own visible outcome even with no captured delta", () => {
    const journey = j([{ step: { kind: "click", target: { testId: "open" }, expect: { kind: "visible", target: { role: "dialog", name: "Review" } } }, expectedResult: "Review opens" }]);
    expect(lintJourney(journey)).toEqual([]);
  });

  it("does not credit the same operative target when only display/tracking metadata changes", () => {
    const open = templates();
    open.step = {
      kind: "click", target: { testId: "open", display: { name: "Open before" }, tflowId: "before", testIdAttr: "data-test-before" },
      expect: { kind: "visible", target: { testId: "open", display: { name: "Open after" }, tflowId: "after", testIdAttr: "data-test-after" } },
    };
    const rules = lintJourney(j([open])).map((f) => f.rule);
    for (const rule of ["write-without-effect", "visibility-only", "nothing-after-last-write", "intent-uncovered"]) expect(rules).toContain(rule);
  });

  const unsupported: Step[] = [
    { kind: "navigate", url: "/templates", expect: { kind: "visible", target: { testId: "heading" } } },
    { kind: "assert", check: { kind: "visible", target: { testId: "heading" } } },
    { kind: "handback", prompt: "Open templates", resume: { kind: "visible", target: { testId: "heading" } } },
    { kind: "press", key: "Enter", expect: { kind: "visible", target: { testId: "heading" } } },
  ];
  it.each(unsupported)("does not infer a distinct action target for $kind visibility", (step) => {
    const rules = lintJourney(j([{ step, expectedResult: "Templates opens" }])).map((f) => f.rule);
    expect(rules).toContain("visibility-only");
    expect(rules).toContain("intent-uncovered");
  });

  it("keeps existing stronger outcomes on untargeted press actions", () => {
    const journey = j([{ step: { kind: "press", key: "Enter", expect: { kind: "textIncludes", target: { role: "status", name: "Result" }, text: "Opened" } }, expectedResult: "Result opens" }]);
    expect(lintJourney(journey)).toEqual([]);
  });

  it("does not credit bare final visibility as a strong HTTP-write effect", () => {
    const write = templates(["POST /api/templates → 201"]);
    write.step = { kind: "click", target: { testId: "save" }, expect: { kind: "urlIncludes", text: "" } };
    const rules = lintJourney(j([write], { endState: [{ kind: "page", assertion: { kind: "visible", target: { testId: "heading" } } }] })).map((f) => f.rule);
    for (const rule of ["write-without-effect", "visibility-only", "nothing-after-last-write", "intent-uncovered"]) expect(rules).toContain(rule);
  });

  it.each([[], ["GET /templates → 200"], ["malformed"], ["GET /templates → 200", "... truncated capture"]])(
    "keeps persistence uncertainty on a UI effect with incomplete capture %j", (requests) => {
      expect(lintJourney(j([templates(requests)])).map((f) => ({ rule: f.rule, level: f.level }))).toEqual([{ rule: "no-persistence-check", level: "warning" }]);
    },
  );

  it("does not credit visible UI output for a positively observed HTTP write", () => {
    const findings = lintJourney(j([templates(["POST /api/templates → 201"])]));
    for (const rule of ["write-without-effect", "visibility-only", "nothing-after-last-write", "intent-uncovered"]) expect(findings.map((f) => f.rule)).toContain(rule);
    expect(findings.find((f) => f.rule === "no-persistence-check")?.level).toBe("warning");
  });

  it("keeps declared HTTP expectations as the stronger evidence rather than adding a UI exception", () => {
    const write = templates();
    write.expectRequests = [{ kind: "responseStatus", method: "POST", pathGlob: "/api/templates", status: { class: 2 } }];
    const before = structuredClone(write);
    const findings = lintJourney(j([write]));
    expect(findings.map((f) => f.rule)).toEqual(["no-persistence-check"]);
    const noUiClaim = structuredClone(write);
    noUiClaim.step = { kind: "click", target: { testId: "tool-sub-nav-item-templates" }, expect: { kind: "urlIncludes", text: "" } };
    expect(lintJourney(j([noUiClaim]))).toEqual(findings);
    expect(write).toEqual(before);
    expect(planJourneyMutations(j([write])).mutations.map((m) => m.id)).toEqual(["skip:1", "block-write:1"]);
  });

  it("uses the current read classifier without treating a read trace as a no-write certificate", () => {
    const journey = j([templates(["POST /api/templates/query → 200"])]);
    expect(lintJourney(journey).map((f) => f.rule)).toContain("write-without-effect");
    expect(lintJourney(journey, { readRequests: ["/api/templates/query"] }).map((f) => ({ rule: f.rule, level: f.level }))).toEqual([{ rule: "no-persistence-check", level: "warning" }]);
  });

  it("does not clear uncertain UI writes merely because a read expectation exists", () => {
    const open = templates();
    open.expectRequests = [{ kind: "requestMade", method: "GET", pathGlob: "/templates" }];
    expect(lintJourney(j([open])).find((f) => f.rule === "no-persistence-check")).toMatchObject({ level: "warning", message: "UI effect at step 1 has incomplete write coverage; persistence requirements are unresolved." });
  });

  it("does not manufacture a pair for an unrelated final GET/status obligation", () => {
    const journey = j([templates(["GET /templates → 200"])], { endState: [{ kind: "responseStatus", method: "GET", pathGlob: "/unrelated", status: { class: 2 } }] });
    const plan = planJourneyMutations(journey);
    const results = new Map<string, MutationRunResult>([["skip:1", { outcome: "failed", failedSites: [{ where: "step", step: 1, postcondition: true }] }]]);
    const assertions = judgeAssertions(journey, plan, results);
    expect(assertions.find((a) => a.site === "end-state:0")).toEqual({ site: "end-state:0", verdict: "unpaired", required: true });
    expect(plan.pairs).toEqual([{ site: "step:1", mutation: "skip:1" }]);
    expect(mutationProofVerdict({ basePassed: true, mutations: [...results.values()], assertions }).verdict).toBe("inconclusive");
    expect(lintJourney(journey).map((f) => f.rule)).toContain("no-persistence-check");
  });
});

describe("#466 lintJourney: the 0.10 anchor rules", () => {
  const click: RecordedStep = { step: { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Done" } }, stepId: "s-aaaaaa" };

  it("reports a non-compliant anchor name as a warning", () => {
    const finding = lintJourney(j([click], { anchors: [{ name: "Review", step: 1, stepId: "s-aaaaaa" }] })).find((f) => f.rule === "anchor-name");
    expect(finding?.level).toBe("warning");
  });

  it("names the fix", () => {
    const finding = lintJourney(j([click], { anchors: [{ name: "Review", step: 1, stepId: "s-aaaaaa" }] })).find((f) => f.rule === "anchor-name");
    expect(finding?.fix).toContain("'review'");
  });

  it("reports a job-linked Journey without anchors", () => {
    expect(lintJourney(j([click], { job: "checkout" })).some((f) => f.rule === "job-anchors" && f.level === "warning")).toBe(true);
  });
});

describe("#488 lintJourney: relative upload fixture paths", () => {
  function uploadStep(file: RecordedStep["step"] extends { file: infer F } ? F : never): RecordedStep {
    return {
      step: {
        kind: "upload",
        target: { testId: "receipt" },
        file,
        expect: { kind: "textIncludes", target: { role: "status" }, text: "Uploaded" },
      },
    } as RecordedStep;
  }

  it("flags an upload step whose literal file is missing, naming the resolved path", () => {
    const findings = lintJourney(j([uploadStep({ redacted: false, value: "missing.pdf" })]), { baseDir: "/proj" });
    expect(findings.some((f) => f.rule === "upload-file-missing" && f.message.includes("/proj/missing.pdf"))).toBe(true);
  });

  it("does not flag an upload step whose file is a {var} binding", () => {
    const findings = lintJourney(j([uploadStep({ var: "receipt" })]), { baseDir: "/proj" });
    expect(findings.some((f) => f.rule === "upload-file-missing")).toBe(false);
  });

  it("does not flag a redacted upload file", () => {
    const findings = lintJourney(j([uploadStep({ redacted: true, length: 12 })]), { baseDir: "/proj" });
    expect(findings.some((f) => f.rule === "upload-file-missing")).toBe(false);
  });

  it("does not flag an upload step whose literal file exists under the base dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lint-fixture-"));
    await writeFile(join(dir, "receipt.pdf"), "pdf");
    const findings = lintJourney(j([uploadStep({ redacted: false, value: "receipt.pdf" })]), { baseDir: dir });
    expect(findings.some((f) => f.rule === "upload-file-missing")).toBe(false);
  });
});

describe("#498 lintJourney: upload fixtures outside the project root", () => {
  function uploadOf(value: string): RecordedStep {
    return {
      step: {
        kind: "upload",
        target: { testId: "receipt" },
        file: { redacted: false, value },
        expect: { kind: "textIncludes", target: { role: "status" }, text: "Uploaded" },
      },
    } as RecordedStep;
  }

  async function project(): Promise<{ base: string; root: string }> {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lint-outside-")));
    const root = join(base, "proj");
    await mkdir(root);
    await writeFile(join(root, "receipt.pdf"), "pdf");
    await writeFile(join(base, "secret.txt"), "secret");
    return { base, root };
  }

  it("flags an absolute path outside the root as an upload-outside-project error", async () => {
    const { base, root } = await project();
    const findings = lintJourney(j([uploadOf(join(base, "secret.txt"))]), { baseDir: root });
    expect(findings.some((f) => f.rule === "upload-outside-project" && f.level === "error")).toBe(true);
  });

  it("flags a ../ path that escapes the root", async () => {
    const { root } = await project();
    const findings = lintJourney(j([uploadOf("../secret.txt")]), { baseDir: root });
    expect(findings.some((f) => f.rule === "upload-outside-project")).toBe(true);
  });

  it("flags a symlink inside the root that points outside", async () => {
    const { base, root } = await project();
    await symlink(join(base, "secret.txt"), join(root, "link.txt"));
    const findings = lintJourney(j([uploadOf("link.txt")]), { baseDir: root });
    expect(findings.some((f) => f.rule === "upload-outside-project")).toBe(true);
  });

  it("flags an absolute path inside the root because fixtures must be project-relative", async () => {
    const { root } = await project();
    const findings = lintJourney(j([uploadOf(join(root, "receipt.pdf"))]), { baseDir: root });
    const finding = findings.find((f) => f.rule === "upload-outside-project");
    expect(finding?.level).toBe("error");
    expect(finding?.fix).toContain("relative to the project root");
  });

  it("names the path, the root and the fix", async () => {
    const { base, root } = await project();
    const finding = lintJourney(j([uploadOf(join(base, "secret.txt"))]), { baseDir: root }).find((f) => f.rule === "upload-outside-project");
    expect(`${finding?.message} ${finding?.fix}`).toContain("must be project-relative");
  });

  it("names the fix as moving the fixture into the project", async () => {
    const { base, root } = await project();
    const finding = lintJourney(j([uploadOf(join(base, "secret.txt"))]), { baseDir: root }).find((f) => f.rule === "upload-outside-project");
    expect(finding?.fix).toContain("relative to the project root");
  });

  it("does not also report an outside fixture as missing", async () => {
    const { root } = await project();
    const findings = lintJourney(j([uploadOf("../nope.txt")]), { baseDir: root });
    expect(findings.some((f) => f.rule === "upload-file-missing")).toBe(false);
  });

  // 0.12.0 review M2: a sensitive file inside the root is its own error.
  it("flags a .env inside the root as an upload-sensitive-file error", async () => {
    const { root } = await project();
    await writeFile(join(root, ".env"), "TOKEN=x");
    const findings = lintJourney(j([uploadOf(".env")]), { baseDir: root });
    expect(findings.some((f) => f.rule === "upload-sensitive-file" && f.level === "error")).toBe(true);
  });

  it("names the reason and a dedicated fixture as the fix", async () => {
    const { root } = await project();
    await writeFile(join(root, "server.pem"), "pem");
    const finding = lintJourney(j([uploadOf("server.pem")]), { baseDir: root }).find((f) => f.rule === "upload-sensitive-file");
    expect(finding?.message).toContain("looks sensitive (private key or certificate (.pem))");
  });

  it("does not flag an ordinary csv fixture as sensitive", async () => {
    const { root } = await project();
    await writeFile(join(root, "crm-import-journey-happy.csv"), "a,b");
    const findings = lintJourney(j([uploadOf("crm-import-journey-happy.csv")]), { baseDir: root });
    expect(findings.some((f) => f.rule.startsWith("upload-"))).toBe(false);
  });

  // 0.12.0 review H1: no project root, or one that confines nothing, refuses every literal fixture.
  it("flags a literal fixture as outside when there is no project root", () => {
    const findings = lintUploadFixtures(j([uploadOf("receipt.pdf")]), undefined);
    expect(findings.some((f) => f.rule === "upload-outside-project")).toBe(true);
  });

  it("flags a literal fixture as outside when the root is the home directory", () => {
    const findings = lintUploadFixtures(j([uploadOf(".ssh/id_ed25519")]), homedir());
    expect(findings.some((f) => f.rule === "upload-outside-project")).toBe(true);
  });
});

describe("#565 lintJourney: parameter-relative checks", () => {
  const publishWith = (text: string, metadata: Partial<Journey["metadata"]> = {}): Journey =>
    j(
      [
        {
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text } },
          delta: { verdict: "relevant-change", why: "", changes: [], requests: publishWrite, overheadMs: 1 },
        },
      ],
      metadata,
    );

  it("a check naming a declared non-secret parameter is an effect assertion", () => {
    expect(lintJourney(publishWith("Published ${title}", { params: ["title"] })).map((f) => f.rule)).not.toContain("write-without-effect");
  });

  it("a check naming an extract output is an effect assertion", () => {
    const journey = publishWith("Code ${code}");
    journey.recording.pages[0]!.steps.unshift({ step: { kind: "extract", target: { testId: "code" }, as: "code", expect: { kind: "visible", target: { testId: "code" } } } });
    expect(lintJourney(journey).map((f) => f.rule)).not.toContain("write-without-effect");
  });

  it("a check naming a secret parameter proves nothing", () => {
    expect(lintJourney(publishWith("Published ${apiToken}", { params: [], parameters: [{ name: "apiToken", secret: true }] })).map((f) => f.rule)).toContain("write-without-effect");
  });

  it("a check naming an unbound reference proves nothing", () => {
    expect(lintJourney(publishWith("Published ${nobody}")).map((f) => f.rule)).toContain("write-without-effect");
  });
});
