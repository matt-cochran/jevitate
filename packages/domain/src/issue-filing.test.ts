import { describe, expect, it } from "vitest";
import {
  fileDraft,
  fingerprintMarker,
  targetsFor,
  type IssueDraft,
  type IssueFilerPort,
  type IssueRef,
  type NewIssue,
} from "./issue-filing.js";

/** A fake filer: records every call; NOTHING is filed anywhere real. */
class FakeFiler implements IssueFilerPort {
  readonly calls: string[] = [];
  constructor(private readonly open: Record<string, IssueRef> = {}, private readonly failOn?: string) {}
  async findOpenByMarker(repo: string, marker: string): Promise<IssueRef | null> {
    this.calls.push(`search ${repo} ${marker}`);
    if (this.failOn === repo) throw new Error("search failed");
    return this.open[`${repo}|${marker}`] ?? null;
  }
  async create(repo: string, issue: NewIssue): Promise<IssueRef> {
    this.calls.push(`create ${repo} ${issue.title}`);
    return { number: 7, url: `https://example.test/${repo}/issues/7` };
  }
  async comment(repo: string, number: number): Promise<IssueRef> {
    this.calls.push(`comment ${repo} #${number}`);
    return { number, url: `https://example.test/${repo}/issues/${number}` };
  }
}

const draft = (attribution: IssueDraft["attribution"]): IssueDraft => ({
  fingerprint: "abcdef0123456789",
  title: "t",
  body: `b\n\n${fingerprintMarker("abcdef0123456789")}`,
  labels: [],
  attribution,
  targets: targetsFor(attribution),
});

const NOW = "2026-09-23T00:00:00.000Z";

describe("fileDraft — the filing rule (owner ruling 3)", () => {
  it("is OFF unless enabled: a disabled run only keeps the draft and never calls the filer", async () => {
    const filer = new FakeFiler();
    const out = await fileDraft(filer, draft("system-under-test"), { enabled: false, jevitateRepo: "o/j", targetRepo: "o/app" }, NOW);
    expect(out).toEqual([{ target: "system-under-test", status: "draft-only", reason: "filing is disabled" }]);
    expect(filer.calls).toEqual([]);
  });

  it("is OFF for the system under test when no repo is configured for the target", async () => {
    const filer = new FakeFiler();
    const out = await fileDraft(filer, draft("system-under-test"), { enabled: true, jevitateRepo: "o/j" }, NOW);
    expect(out[0]).toMatchObject({ status: "draft-only" });
    expect(filer.calls).toEqual([]);
  });

  it("creates a new issue when no open issue carries the fingerprint marker", async () => {
    const filer = new FakeFiler();
    const out = await fileDraft(filer, draft("system-under-test"), { enabled: true, jevitateRepo: "o/j", targetRepo: "o/app" }, NOW);
    expect(out).toEqual([
      { target: "system-under-test", status: "filed", repo: "o/app", action: "created", issue: { number: 7, url: "https://example.test/o/app/issues/7" } },
    ]);
    expect(filer.calls).toEqual([`search o/app ${fingerprintMarker("abcdef0123456789")}`, "create o/app t"]);
  });

  it("comments on the existing open issue instead of opening a duplicate", async () => {
    const marker = fingerprintMarker("abcdef0123456789");
    const filer = new FakeFiler({ [`o/app|${marker}`]: { number: 42, url: "u" } });
    const out = await fileDraft(filer, draft("system-under-test"), { enabled: true, jevitateRepo: "o/j", targetRepo: "o/app" }, NOW);
    expect(out[0]).toMatchObject({ status: "filed", action: "commented", issue: { number: 42 } });
    expect(filer.calls.some((c) => c.startsWith("create"))).toBe(false);
  });

  it("routes jevitate findings to jevitate's repo and uncertain ones to BOTH", async () => {
    const filer = new FakeFiler();
    const cfg = { enabled: true, jevitateRepo: "o/j", targetRepo: "o/app" };
    expect((await fileDraft(filer, draft("jevitate"), cfg, NOW)).map((o) => o.status === "filed" && o.repo)).toEqual(["o/j"]);
    expect((await fileDraft(filer, draft("uncertain"), cfg, NOW)).map((o) => o.status === "filed" && o.repo)).toEqual(["o/j", "o/app"]);
  });

  it("a filer failure is a typed `failed` outcome, never a throw", async () => {
    const filer = new FakeFiler({}, "o/app");
    const out = await fileDraft(filer, draft("system-under-test"), { enabled: true, jevitateRepo: "o/j", targetRepo: "o/app" }, NOW);
    expect(out).toEqual([{ target: "system-under-test", status: "failed", repo: "o/app", reason: "search failed" }]);
  });
});
