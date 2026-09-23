import { describe, expect, it } from "vitest";
import type { CredentialStore } from "@jevitate/ai-core";
import { GitHubIssueFiler, type Exec, type FetchLike } from "./github-issue-filer.js";

const TOKEN = "ghp_TESTTOKEN_never_logged_123";
const withToken: CredentialStore = { detect: (k) => k === "GITHUB_TOKEN", read: (k) => (k === "GITHUB_TOKEN" ? TOKEN : undefined) };
const noToken: CredentialStore = { detect: () => false, read: () => undefined };
const MARKER = "<!-- jevitate-fingerprint: abcdef0123456789 -->";

describe("GitHubIssueFiler — gh CLI transport (fake exec; nothing is filed)", () => {
  it("searches open issues by the fingerprint and matches the exact marker in the body", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const exec: Exec = async (cmd, args, stdin) => {
      calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
      if (args[0] === "--version") return { code: 0, stdout: "gh version 2", stderr: "" };
      if (args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 1, url: "https://github.com/o/a/issues/1", body: "mentions abcdef0123456789 but no marker" },
            { number: 2, url: "https://github.com/o/a/issues/2", body: `x\n${MARKER}` },
          ]),
          stderr: "",
        };
      }
      if (args[1] === "create") return { code: 0, stdout: "https://github.com/o/a/issues/9\n", stderr: "" };
      return { code: 0, stdout: "https://github.com/o/a/issues/2#issuecomment-5\n", stderr: "" };
    };
    const filer = new GitHubIssueFiler({ store: noToken, exec });
    expect(await filer.mode()).toBe("gh");
    expect(await filer.findOpenByMarker("o/a", MARKER)).toEqual({ number: 2, url: "https://github.com/o/a/issues/2" });
    expect(calls[1]?.args).toEqual([
      "issue", "list", "--repo", "o/a", "--state", "open", "--search", "abcdef0123456789 in:body",
      "--json", "number,url,body", "--limit", "20",
    ]);
    expect(await filer.create("o/a", { title: "T", body: "B", labels: ["x"] })).toEqual({ number: 9, url: "https://github.com/o/a/issues/9" });
    expect(calls[2]).toEqual({ args: ["issue", "create", "--repo", "o/a", "--title", "T", "--body-file", "-"], stdin: "B" });
    expect(await filer.comment("o/a", 2, "again")).toMatchObject({ number: 2 });
    expect(calls[3]).toEqual({ args: ["issue", "comment", "2", "--repo", "o/a", "--body-file", "-"], stdin: "again" });
  });
});

describe("GitHubIssueFiler — REST transport (fake fetch; nothing is filed)", () => {
  const ghMissing: Exec = async () => ({ code: -1, stdout: "", stderr: "spawn gh ENOENT" });

  it("falls back to REST with the stored token in the Authorization header only", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, ...init });
      if (init.method === "GET") return { status: 200, text: async () => JSON.stringify({ items: [] }) };
      return { status: 201, text: async () => JSON.stringify({ number: 3, html_url: "https://github.com/o/a/issues/3" }) };
    };
    const filer = new GitHubIssueFiler({ store: withToken, exec: ghMissing, fetch });
    expect(await filer.mode()).toBe("rest");
    expect(await filer.findOpenByMarker("o/a", MARKER)).toBeNull();
    expect(await filer.create("o/a", { title: "T", body: "B", labels: [] })).toEqual({ number: 3, url: "https://github.com/o/a/issues/3" });
    expect(seen[0]?.url).toContain("/search/issues?q=");
    expect(decodeURIComponent(seen[0]?.url ?? "")).toContain("repo:o/a is:issue is:open in:body abcdef0123456789");
    expect(seen[1]).toMatchObject({ url: "https://api.github.com/repos/o/a/issues", method: "POST" });
    for (const r of seen) {
      expect(r.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.url).not.toContain(TOKEN);
      expect(r.body ?? "").not.toContain(TOKEN);
    }
  });

  it("never leaks the token in an error, and needs gh or a token", async () => {
    const fetch: FetchLike = async () => ({ status: 401, text: async () => `Bad credentials for ${TOKEN}` });
    const filer = new GitHubIssueFiler({ store: withToken, exec: ghMissing, fetch });
    const err = await filer.create("o/a", { title: "T", body: "B", labels: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GitHub API 401");
    expect((err as Error).message).not.toContain(TOKEN);

    const none = new GitHubIssueFiler({ store: noToken, exec: ghMissing, fetch });
    await expect(none.create("o/a", { title: "T", body: "B", labels: [] })).rejects.toThrow(/gh CLI or a GITHUB_TOKEN/);
  });
});
