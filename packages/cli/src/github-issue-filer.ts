import { spawn } from "node:child_process";
import { redactText, type CredentialStore } from "@jevitate/ai-core";
import type { IssueFilerPort, IssueRef, NewIssue } from "@jevitate/domain";

/**
 * The GitHub adapter for the domain's `IssueFilerPort` (owner ruling 3). It prefers the `gh` CLI
 * when it is installed (the user's own authenticated session); otherwise it uses the REST API with
 * `GITHUB_TOKEN` from jevitate's credential store. The token goes ONLY into the Authorization
 * header — never into a message, a log line, an error, or an issue — and any error text is
 * scrubbed of it before it leaves this module.
 *
 * Both transports are injectable so tests exercise the exact commands/requests without ever
 * talking to GitHub.
 */

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command with optional stdin. No shell — arguments are passed verbatim (portable). */
export type Exec = (cmd: string, args: readonly string[], stdin?: string) => Promise<ExecResult>;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

export const defaultExec: Exec = (cmd, args, stdin) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });

export interface GitHubIssueFilerDeps {
  readonly store: CredentialStore;
  readonly exec?: Exec;
  readonly fetch?: FetchLike;
  readonly apiBase?: string;
}

export class GitHubFilingError extends Error {
  readonly code = "E_ISSUE_FILING" as const;
  constructor(message: string) {
    super(message);
    this.name = "GitHubFilingError";
  }
}

const ISSUE_NUMBER = /\/issues\/(\d+)/;

function parseIssueUrl(url: string): IssueRef {
  const m = ISSUE_NUMBER.exec(url);
  if (m?.[1] === undefined) throw new GitHubFilingError(`unexpected issue URL: ${url}`);
  return { number: Number(m[1]), url };
}

/** The bare fingerprint inside a `<!-- jevitate-fingerprint: … -->` marker (the searchable token). */
function markerToken(marker: string): string {
  return marker.replace(/^<!--\s*jevitate-fingerprint:\s*/, "").replace(/\s*-->$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export class GitHubIssueFiler implements IssueFilerPort {
  readonly #exec: Exec;
  readonly #fetch: FetchLike | undefined;
  readonly #store: CredentialStore;
  readonly #apiBase: string;
  #mode: Promise<"gh" | "rest"> | undefined;

  constructor(deps: GitHubIssueFilerDeps) {
    this.#exec = deps.exec ?? defaultExec;
    this.#fetch = deps.fetch;
    this.#store = deps.store;
    this.#apiBase = deps.apiBase ?? "https://api.github.com";
  }

  /** `gh` when it is installed and runnable, else REST (which needs `GITHUB_TOKEN`). */
  mode(): Promise<"gh" | "rest"> {
    this.#mode ??= this.#exec("gh", ["--version"]).then((r) => (r.code === 0 ? "gh" : "rest"));
    return this.#mode;
  }

  #scrub(text: string): string {
    const token = this.#store.read("GITHUB_TOKEN");
    return token === undefined ? text : redactText(text, [token]);
  }

  async #gh(args: readonly string[], stdin?: string): Promise<string> {
    const r = await this.#exec("gh", args, stdin);
    if (r.code !== 0) throw new GitHubFilingError(this.#scrub(`gh ${args[0] ?? ""} ${args[1] ?? ""} failed: ${r.stderr.trim()}`));
    return r.stdout;
  }

  async #rest(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = this.#store.read("GITHUB_TOKEN");
    if (token === undefined) {
      throw new GitHubFilingError("filing needs the gh CLI or a GITHUB_TOKEN in jevitate's credential store");
    }
    const doFetch = this.#fetch ?? (globalThis.fetch as unknown as FetchLike);
    const res = await doFetch(`${this.#apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jevitate",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new GitHubFilingError(this.#scrub(`GitHub API ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`));
    }
    return text === "" ? null : JSON.parse(text);
  }

  async findOpenByMarker(repo: string, marker: string): Promise<IssueRef | null> {
    const token = markerToken(marker);
    if ((await this.mode()) === "gh") {
      const out = await this.#gh([
        "issue", "list", "--repo", repo, "--state", "open", "--search", `${token} in:body`,
        "--json", "number,url,body", "--limit", "20",
      ]);
      const list: unknown = JSON.parse(out === "" ? "[]" : out);
      if (!Array.isArray(list)) return null;
      for (const item of list) {
        if (isRecord(item) && typeof item.body === "string" && item.body.includes(marker) && typeof item.number === "number" && typeof item.url === "string") {
          return { number: item.number, url: item.url };
        }
      }
      return null;
    }
    const q = encodeURIComponent(`repo:${repo} is:issue is:open in:body ${token}`);
    const res = await this.#rest("GET", `/search/issues?q=${q}&per_page=20`);
    const items = isRecord(res) && Array.isArray(res.items) ? res.items : [];
    for (const item of items) {
      if (isRecord(item) && typeof item.body === "string" && item.body.includes(marker) && typeof item.number === "number" && typeof item.html_url === "string") {
        return { number: item.number, url: item.html_url };
      }
    }
    return null;
  }

  async create(repo: string, issue: NewIssue): Promise<IssueRef> {
    if ((await this.mode()) === "gh") {
      const out = await this.#gh(["issue", "create", "--repo", repo, "--title", issue.title, "--body-file", "-"], issue.body);
      return parseIssueUrl(out.trim());
    }
    const res = await this.#rest("POST", `/repos/${repo}/issues`, { title: issue.title, body: issue.body });
    if (!isRecord(res) || typeof res.number !== "number" || typeof res.html_url !== "string") {
      throw new GitHubFilingError("GitHub API returned no issue");
    }
    return { number: res.number, url: res.html_url };
  }

  async comment(repo: string, number: number, body: string): Promise<IssueRef> {
    if ((await this.mode()) === "gh") {
      const out = await this.#gh(["issue", "comment", String(number), "--repo", repo, "--body-file", "-"], body);
      return { number, url: out.trim() };
    }
    const res = await this.#rest("POST", `/repos/${repo}/issues/${number}/comments`, { body });
    return { number, url: isRecord(res) && typeof res.html_url === "string" ? res.html_url : "" };
  }
}
