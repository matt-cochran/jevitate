import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Recording, RecordedStep } from "@jevitate/recording";
import { lintJourney, lintUploadFixtures, type Journey } from "./index.js";

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
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
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
          step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
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

  it("does not flag an absolute path inside the root", async () => {
    const { root } = await project();
    const findings = lintJourney(j([uploadOf(join(root, "receipt.pdf"))]), { baseDir: root });
    expect(findings.some((f) => f.rule.startsWith("upload-"))).toBe(false);
  });

  it("names the path, the root and the fix", async () => {
    const { base, root } = await project();
    const finding = lintJourney(j([uploadOf(join(base, "secret.txt"))]), { baseDir: root }).find((f) => f.rule === "upload-outside-project");
    expect(`${finding?.message} ${finding?.fix}`).toContain(`${join(base, "secret.txt")} is outside the project root ${root}`);
  });

  it("names the fix as moving the fixture into the project", async () => {
    const { base, root } = await project();
    const finding = lintJourney(j([uploadOf(join(base, "secret.txt"))]), { baseDir: root }).find((f) => f.rule === "upload-outside-project");
    expect(finding?.fix).toContain("move the fixture into the project");
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
