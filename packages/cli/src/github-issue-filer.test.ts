import { describe, expect, it } from "vitest";
import type { CredentialStore } from "@jevitate/ai-core";
import { fileDraft } from "@jevitate/domain";
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

  it("an auth failure (401) on create fails at once — no search, no retry, no sleep", async () => {
    const slept: number[] = [];
    let calls = 0;
    const denied: FetchLike = async () => {
      calls += 1;
      return { status: 401, text: async () => "no" };
    };
    const filer = new GitHubIssueFiler({ store: withToken, exec: ghMissing, fetch: denied, retry: { sleep: async (ms) => void slept.push(ms), random: () => 0.5 } });
    await expect(filer.create("o/a", { title: "T", body: `B\n${MARKER}`, labels: [] })).rejects.toThrow(/401/);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
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

/**
 * A fake GitHub that PERSISTS issues — including on a create that it then answers with a 502 (the
 * request landed, the response was lost). Nothing here talks to GitHub.
 */
class FakeGitHub {
  readonly issues: Array<{ number: number; title: string; body: string }> = [];
  readonly comments: Array<{ number: number; body: string }> = [];
  failCreates: Array<"persist-then-502" | "502"> = [];
  failComments = 0;

  #create(title: string, body: string): { number: number; lost: boolean; failed: boolean } {
    const mode = this.failCreates.shift();
    if (mode === "502") return { number: 0, lost: false, failed: true };
    const number = this.issues.length + 1;
    this.issues.push({ number, title, body });
    return { number, lost: mode === "persist-then-502", failed: false };
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (init.method === "GET" && u.pathname === "/search/issues") {
      const token = (u.searchParams.get("q") ?? "").split(" ").at(-1) ?? "";
      const items = this.issues
        .filter((i) => i.body.includes(token))
        .map((i) => ({ number: i.number, html_url: `https://github.com/o/a/issues/${i.number}`, body: i.body }));
      return { status: 200, text: async () => JSON.stringify({ items }) };
    }
    if (init.method === "POST" && u.pathname === "/repos/o/a/issues") {
      const b = JSON.parse(init.body ?? "{}") as { title: string; body: string };
      const r = this.#create(b.title, b.body);
      if (r.failed || r.lost) return { status: 502, text: async () => "bad gateway" };
      return { status: 201, text: async () => JSON.stringify({ number: r.number, html_url: `https://github.com/o/a/issues/${r.number}` }) };
    }
    if (init.method === "POST" && u.pathname.endsWith("/comments")) {
      if (this.failComments > 0) {
        this.failComments -= 1;
        this.comments.push({ number: 0, body: "persisted-but-lost" });
        return { status: 502, text: async () => "bad gateway" };
      }
      this.comments.push({ number: 1, body: JSON.parse(init.body ?? "{}").body as string });
      return { status: 201, text: async () => JSON.stringify({ html_url: "c" }) };
    }
    return { status: 404, text: async () => "" };
  };

  readonly exec: Exec = async (_cmd, args, stdin) => {
    if (args[0] === "--version") return { code: 0, stdout: "gh 2", stderr: "" };
    if (args[1] === "list") {
      const token = (args[7] ?? "").replace(/ in:body$/, "");
      const list = this.issues
        .filter((i) => i.body.includes(token))
        .map((i) => ({ number: i.number, url: `https://github.com/o/a/issues/${i.number}`, body: i.body }));
      return { code: 0, stdout: JSON.stringify(list), stderr: "" };
    }
    if (args[1] === "create") {
      const r = this.#create(args[5] ?? "", stdin ?? "");
      if (r.failed || r.lost) return { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway (https://api.github.com/graphql)" };
      return { code: 0, stdout: `https://github.com/o/a/issues/${r.number}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

describe("GitHubIssueFiler — a create is never blindly retried (it is not idempotent)", () => {
  const body = `the draft\n\n${MARKER}`;
  const draft = { title: "T", body, labels: [] as string[] };
  const clock = () => {
    const slept: number[] = [];
    return { slept, retry: { sleep: async (ms: number) => void slept.push(ms), random: () => 0.5 } };
  };

  it("REST: a create that 'fails' with a 502 but persisted ends with EXACTLY one issue, found by its fingerprint", async () => {
    const gh = new FakeGitHub();
    gh.failCreates = ["persist-then-502"];
    const c = clock();
    const filer = new GitHubIssueFiler({ store: withToken, exec: async () => ({ code: -1, stdout: "", stderr: "ENOENT" }), fetch: gh.fetch, retry: c.retry });
    expect(await filer.create("o/a", draft)).toEqual({ number: 1, url: "https://github.com/o/a/issues/1" });
    expect(gh.issues).toHaveLength(1);
    expect(c.slept).toEqual([]); // found on the re-search: no second create, no wait
  });

  it("REST: a create that really failed is re-searched, then tried again after the backoff — still one issue", async () => {
    const gh = new FakeGitHub();
    gh.failCreates = ["502", "502"];
    const c = clock();
    const filer = new GitHubIssueFiler({ store: withToken, exec: async () => ({ code: -1, stdout: "", stderr: "ENOENT" }), fetch: gh.fetch, retry: c.retry });
    expect(await filer.create("o/a", draft)).toMatchObject({ number: 1 });
    expect(gh.issues).toHaveLength(1);
    expect(c.slept).toEqual([100, 250]);
  });

  it("gh: the same rule — a persisted-but-failed create yields exactly one issue", async () => {
    const gh = new FakeGitHub();
    gh.failCreates = ["persist-then-502"];
    const c = clock();
    const filer = new GitHubIssueFiler({ store: noToken, exec: gh.exec, retry: c.retry });
    expect(await filer.mode()).toBe("gh");
    expect(await filer.create("o/a", draft)).toEqual({ number: 1, url: "https://github.com/o/a/issues/1" });
    expect(gh.issues).toHaveLength(1);
  });

  it("end to end through fileDraft: one draft, one flaky create → exactly one issue; filing it again comments", async () => {
    const gh = new FakeGitHub();
    gh.failCreates = ["persist-then-502"];
    const c = clock();
    const filer = new GitHubIssueFiler({ store: withToken, exec: async () => ({ code: -1, stdout: "", stderr: "ENOENT" }), fetch: gh.fetch, retry: c.retry });
    const d = { fingerprint: "abcdef0123456789", title: "T", body, labels: [], attribution: "system-under-test" as const, targets: ["system-under-test" as const] };
    const cfg = { enabled: true, jevitateRepo: "o/j", targetRepo: "o/a" };
    expect((await fileDraft(filer, d, cfg, "t1"))[0]).toMatchObject({ status: "filed", action: "created" });
    expect((await fileDraft(filer, d, cfg, "t2"))[0]).toMatchObject({ status: "filed", action: "commented" });
    expect(gh.issues).toHaveLength(1);
    expect(gh.comments).toHaveLength(1);
  });

  it("an occurrence comment gets exactly one attempt (a duplicate comment is never risked)", async () => {
    const gh = new FakeGitHub();
    gh.failComments = 1;
    const filer = new GitHubIssueFiler({ store: withToken, exec: async () => ({ code: -1, stdout: "", stderr: "ENOENT" }), fetch: gh.fetch, retry: clock().retry });
    await expect(filer.comment("o/a", 1, "again")).rejects.toThrow(/502/);
    expect(gh.comments).toHaveLength(1);
  });

  it("a body without a fingerprint marker cannot be checked, so it gets one attempt", async () => {
    const gh = new FakeGitHub();
    gh.failCreates = ["502"];
    const filer = new GitHubIssueFiler({ store: withToken, exec: async () => ({ code: -1, stdout: "", stderr: "ENOENT" }), fetch: gh.fetch, retry: clock().retry });
    await expect(filer.create("o/a", { title: "T", body: "no marker", labels: [] })).rejects.toThrow(/502/);
    expect(gh.issues).toHaveLength(0);
  });
});
