import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactText } from "@jevitate/ai-core";
import { clock } from "@jevitate/domain";
import { JourneySchema, type PrReview } from "@jevitate/journey";
import { catalogEntryHash } from "./catalog.js";
import { journeyReviewHash } from "./journey-review.js";
import { codeownersOf, GITHUB_CODEOWNERS_LOCATIONS, parseCodeownersFile } from "./init-codeowners.js";
import { findGitRoot } from "./project-dir.js";

/**
 * #469 — the `pr-review` approval channel: verified through the forge, never claimed.
 *
 * An approval is recorded as `pr-review` ONLY when jevitate itself verifies, through the GitHub API
 * with the CI environment's `GITHUB_TOKEN` (never an argument, never an MCP parameter, never the
 * model's), that the commit that last changed the entry came from a merged pull request into the
 * default branch, approved by someone other than its author:
 *
 *  1. the environment is GitHub Actions (`GITHUB_ACTIONS=true`, one of the CI markers approval
 *     provenance detects) on github.com — the API base is pinned to `https://api.github.com`; a
 *     `GITHUB_API_URL` / `GITHUB_SERVER_URL` naming anything else (GitHub Enterprise) is refused;
 *  2. approving runs on the default branch (`GITHUB_REF`), never on a `pull_request*` event (a fork's
 *     pull request controls the files it would approve);
 *  3. the entry's content on the default branch is the content being approved, and the commit that
 *     last changed it (walking the file's history; its first parent holds different content) is on
 *     the default branch;
 *  4. that commit belongs to a MERGED pull request whose base is the default branch;
 *  5. the pull request's APPROVED head (the commit its approving review is on) holds the same
 *     content of the entry — the reviewer approved exactly what is honoured, never an intermediate
 *     commit of the pull request or an "evil merge" resolution that differs from it;
 *  6. the pull request has an APPROVED review (each reviewer's latest decisive review) on its head
 *     commit, by a person (not a bot) who is not the pull request's author, authored or committed
 *     none of its commits (logins and user ids compared), and has write access (collaborator
 *     permission admin / maintain / write);
 *  7. optionally (`JEVITATE_PR_REVIEW_REQUIRE_CODEOWNER=1`), that reviewer is a CODEOWNER of the
 *     entry's file (the default branch's CODEOWNERS; a team owner needs an active membership).
 *
 * Any failure is a typed refusal with its reason — never a silent fall back to another channel.
 * `check --require-approvals` RE-VERIFIES every recorded `pr-review` approval the same way
 * (`reverifyPrReview`), so a hand-written `pr-review` provenance is a violation, never a pass.
 *
 * The token is used only in the Authorization header; every error text is scrubbed of it.
 */

/** The only GitHub API base jevitate talks to. GitHub Enterprise is out of scope (refused). */
export const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_SERVER = "https://github.com";
/** How far back the file's history is walked to find the commit that last changed the entry. */
export const HISTORY_LIMIT = 30;
/** How long a positive re-verification is trusted from the cache (short: a dismissed review or a revoked reviewer stops passing within a day). */
export const PR_REVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** The env flag that requires the approving reviewer to be a CODEOWNER of the entry's file. */
export const REQUIRE_CODEOWNER_ENV = "JEVITATE_PR_REVIEW_REQUIRE_CODEOWNER";

// ── The forge port ───────────────────────────────────────────────────────────────────────────

export interface ForgePull {
  readonly number: number;
  readonly url?: string;
  /** Null while the pull request is not merged. */
  readonly mergedAt: string | null;
  readonly baseRef: string;
  readonly headSha: string;
  readonly author: string;
}

/** Who wrote and who committed one commit of a pull request (logins / user ids; absent: no linked GitHub user). */
export interface ForgeCommitPeople {
  readonly authorLogin?: string;
  readonly authorId?: number;
  readonly committerLogin?: string;
  readonly committerId?: number;
}

export interface ForgeReview {
  readonly login: string;
  readonly isBot: boolean;
  /** The reviewer's GitHub user id, when the forge gives it. */
  readonly userId?: number;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  readonly state: string;
  readonly commitId: string;
  readonly submittedAt?: string;
}

/** What verification asks the forge (one repository). Injectable: tests use a fake, never the network. */
export interface ForgePort {
  defaultBranch(): Promise<string>;
  /** The commits on `ref` that touched `path`, newest first, at most `limit`. */
  commitsTouching(path: string, ref: string, limit: number): Promise<string[]>;
  commitParents(sha: string): Promise<string[]>;
  /** The file at `ref`, or null when it does not exist there. */
  fileAt(path: string, ref: string): Promise<string | null>;
  /** True when `sha` is `ref` or an ancestor of it. */
  isAncestor(sha: string, ref: string): Promise<boolean>;
  pullsForCommit(sha: string): Promise<ForgePull[]>;
  reviews(number: number): Promise<ForgeReview[]>;
  /** The authors and committers of every commit of the pull request. */
  pullCommits(number: number): Promise<ForgeCommitPeople[]>;
  /** `admin` | `maintain` | `write` | `triage` | `read` | `none`. */
  permission(login: string): Promise<string>;
  teamMember(org: string, team: string, login: string): Promise<boolean>;
}

/** A forge request that failed (network, status). Its message is already scrubbed of the token. */
export class ForgeError extends Error {
  readonly code = "E_FORGE";
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ readonly status: number; text(): Promise<string> }>;

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function encPath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/** The GitHub implementation of `ForgePort` (REST, `https://api.github.com` only). */
export class GitHubForge implements ForgePort {
  readonly #repo: string;
  readonly #token: string;
  readonly #fetch: FetchFn;

  constructor(repo: string, token: string, fetchFn: FetchFn = (url, init) => fetch(url, init)) {
    if (!REPO_RE.test(repo)) throw new ForgeError(`not a GitHub repository name: ${JSON.stringify(repo.slice(0, 200))}`);
    this.#repo = repo;
    this.#token = token;
    this.#fetch = fetchFn;
  }

  #scrub(text: string): string {
    return redactText(text, [this.#token]);
  }

  async #get(path: string, opts: { readonly raw?: boolean; readonly allow404?: boolean } = {}): Promise<{ status: number; body: string }> {
    const url = `${GITHUB_API_BASE}${path}`;
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.#fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: opts.raw === true ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "jevitate",
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ForgeError(this.#scrub(`GitHub API GET ${path} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    const body = await res.text();
    if (res.status === 404 && opts.allow404 === true) return { status: 404, body: "" };
    if (res.status < 200 || res.status >= 300) throw new ForgeError(this.#scrub(`GitHub API ${res.status} on GET ${path}: ${body.slice(0, 200)}`));
    return { status: res.status, body };
  }

  async #json(path: string): Promise<unknown> {
    const { body } = await this.#get(path);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ForgeError(`GitHub API GET ${path}: the response is not JSON`);
    }
  }

  get #r(): string {
    return `/repos/${this.#repo}`;
  }

  async defaultBranch(): Promise<string> {
    const j = (await this.#json(this.#r)) as { default_branch?: unknown };
    if (typeof j.default_branch !== "string" || j.default_branch === "") throw new ForgeError("GitHub API: the repository has no default branch");
    return j.default_branch;
  }

  async commitsTouching(path: string, ref: string, limit: number): Promise<string[]> {
    const q = new URLSearchParams({ sha: ref, path, per_page: String(Math.min(100, limit)) });
    const list = (await this.#json(`${this.#r}/commits?${q.toString()}`)) as { sha?: unknown }[];
    return Array.isArray(list) ? list.flatMap((c) => (typeof c.sha === "string" ? [c.sha] : [])).slice(0, limit) : [];
  }

  async commitParents(sha: string): Promise<string[]> {
    const c = (await this.#json(`${this.#r}/commits/${encodeURIComponent(sha)}`)) as { parents?: { sha?: unknown }[] };
    return (c.parents ?? []).flatMap((p) => (typeof p.sha === "string" ? [p.sha] : []));
  }

  async fileAt(path: string, ref: string): Promise<string | null> {
    const r = await this.#get(`${this.#r}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`, { raw: true, allow404: true });
    return r.status === 404 ? null : r.body;
  }

  async isAncestor(sha: string, ref: string): Promise<boolean> {
    const c = (await this.#json(`${this.#r}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(ref)}`)) as { status?: unknown };
    return c.status === "ahead" || c.status === "identical";
  }

  async pullsForCommit(sha: string): Promise<ForgePull[]> {
    const list = (await this.#json(`${this.#r}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`)) as Record<string, unknown>[];
    if (!Array.isArray(list)) return [];
    return list.flatMap((p): ForgePull[] => {
      const base = p.base as { ref?: unknown } | undefined;
      const head = p.head as { sha?: unknown } | undefined;
      const user = p.user as { login?: unknown } | undefined;
      if (typeof p.number !== "number" || typeof base?.ref !== "string" || typeof head?.sha !== "string" || typeof user?.login !== "string") return [];
      return [
        {
          number: p.number,
          ...(typeof p.html_url === "string" ? { url: p.html_url } : {}),
          mergedAt: typeof p.merged_at === "string" ? p.merged_at : null,
          baseRef: base.ref,
          headSha: head.sha,
          author: user.login,
        },
      ];
    });
  }

  async reviews(number: number): Promise<ForgeReview[]> {
    const out: ForgeReview[] = [];
    for (let page = 1; page <= 5; page++) {
      const list = (await this.#json(`${this.#r}/pulls/${number}/reviews?per_page=100&page=${page}`)) as Record<string, unknown>[];
      if (!Array.isArray(list) || list.length === 0) break;
      for (const r of list) {
        const user = r.user as { login?: unknown; type?: unknown; id?: unknown } | null | undefined;
        if (typeof user?.login !== "string" || typeof r.state !== "string" || typeof r.commit_id !== "string") continue;
        out.push({
          login: user.login,
          ...(typeof user.id === "number" ? { userId: user.id } : {}),
          isBot: user.type === "Bot" || user.login.endsWith("[bot]"),
          state: r.state,
          commitId: r.commit_id,
          ...(typeof r.submitted_at === "string" ? { submittedAt: r.submitted_at } : {}),
        });
      }
      if (list.length < 100) break;
    }
    return out;
  }

  async pullCommits(number: number): Promise<ForgeCommitPeople[]> {
    const out: ForgeCommitPeople[] = [];
    // GitHub lists at most 250 commits of a pull request.
    for (let page = 1; page <= 3; page++) {
      const list = (await this.#json(`${this.#r}/pulls/${number}/commits?per_page=100&page=${page}`)) as Record<string, unknown>[];
      if (!Array.isArray(list) || list.length === 0) break;
      for (const c of list) {
        const a = c.author as { login?: unknown; id?: unknown } | null | undefined;
        const m = c.committer as { login?: unknown; id?: unknown } | null | undefined;
        out.push({
          ...(typeof a?.login === "string" ? { authorLogin: a.login } : {}),
          ...(typeof a?.id === "number" ? { authorId: a.id } : {}),
          ...(typeof m?.login === "string" ? { committerLogin: m.login } : {}),
          ...(typeof m?.id === "number" ? { committerId: m.id } : {}),
        });
      }
      if (list.length < 100) break;
    }
    return out;
  }

  async permission(login: string): Promise<string> {
    if (!LOGIN_RE.test(login)) return "none";
    const r = await this.#get(`${this.#r}/collaborators/${encodeURIComponent(login)}/permission`, { allow404: true });
    if (r.status === 404) return "none";
    try {
      const j = JSON.parse(r.body) as { permission?: unknown; role_name?: unknown };
      // `permission` maps maintain → write and triage → read; `role_name` keeps them (custom roles fall back).
      const role = typeof j.role_name === "string" && ["admin", "maintain", "write", "triage", "read"].includes(j.role_name) ? j.role_name : j.permission;
      return typeof role === "string" ? role : "none";
    } catch {
      return "none";
    }
  }

  async teamMember(org: string, team: string, login: string): Promise<boolean> {
    if (!LOGIN_RE.test(login)) return false;
    try {
      const r = await this.#get(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`, { allow404: true });
      if (r.status === 404) return false;
      return (JSON.parse(r.body) as { state?: unknown }).state === "active";
    } catch {
      return false; // the CI token may not read org teams: then the team does not vouch for the reviewer
    }
  }
}

// ── The CI context ───────────────────────────────────────────────────────────────────────────

/** Where verification runs: the repository, its token (from the CI environment), and the triggering event. */
export interface ForgeContext {
  readonly repo: string;
  readonly token: string;
  readonly event: string;
  readonly ref: string;
}

export type ForgeRefusalCode =
  | "not-ci"
  | "not-github"
  | "no-token"
  | "pull-request-event"
  | "not-default-branch"
  | "not-repo-file"
  | "content-mismatch"
  | "history-too-deep"
  | "not-on-default-branch"
  | "not-changed-here"
  | "no-merged-pr"
  | "pr-mismatch"
  | "no-approving-review"
  | "not-code-owner"
  | "reviewer-contributed"
  | "has-waivers"
  | "forge-error";

export interface ForgeRefusal {
  readonly ok: false;
  readonly code: ForgeRefusalCode;
  readonly reason: string;
}

export type PrReviewVerdict = { readonly ok: true; readonly pr: PrReview } | ForgeRefusal;

function refuse(code: ForgeRefusalCode, reason: string): ForgeRefusal {
  return { ok: false, code, reason };
}

type Env = Readonly<Record<string, string | undefined>>;

function isTrue(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes"].includes(v.trim().toLowerCase());
}

/** `JEVITATE_PR_REVIEW_REQUIRE_CODEOWNER=1`: the approving reviewer must be a CODEOWNER of the entry's file. */
export function requireCodeOwnerFromEnv(env: Env): boolean {
  return isTrue(env[REQUIRE_CODEOWNER_ENV]);
}

/**
 * The CI context from the environment — GitHub Actions on github.com with a `GITHUB_TOKEN`, or the
 * refusal. The token is read ONLY from the CI environment's `GITHUB_TOKEN` (never an argument, never
 * jevitate's credential store, never an MCP parameter).
 */
export function forgeContextFromEnv(env: Env): { readonly ok: true; readonly ctx: ForgeContext } | ForgeRefusal {
  if (env.GITHUB_ACTIONS?.trim().toLowerCase() !== "true") {
    return refuse("not-ci", "pr-review is verified only in GitHub Actions (GITHUB_ACTIONS=true), with the CI environment's GITHUB_TOKEN");
  }
  const api = env.GITHUB_API_URL?.trim().replace(/\/+$/, "");
  const server = env.GITHUB_SERVER_URL?.trim().replace(/\/+$/, "");
  if ((api !== undefined && api !== "" && api !== GITHUB_API_BASE) || (server !== undefined && server !== "" && server !== GITHUB_SERVER)) {
    return refuse("not-github", `pr-review is verified against github.com only (GitHub Enterprise is not supported): GITHUB_API_URL/GITHUB_SERVER_URL name another host`);
  }
  const repo = env.GITHUB_REPOSITORY?.trim() ?? "";
  if (!REPO_RE.test(repo)) return refuse("not-ci", "GITHUB_REPOSITORY is not set to <owner>/<repo>");
  const token = env.GITHUB_TOKEN?.trim() ?? "";
  if (token === "") return refuse("no-token", "no GITHUB_TOKEN in the CI environment to verify the pull-request review with (pass `env: GITHUB_TOKEN: ${{ github.token }}` to the step)");
  return { ok: true, ctx: { repo, token, event: env.GITHUB_EVENT_NAME?.trim() ?? "", ref: env.GITHUB_REF?.trim() ?? "" } };
}

/** The forge for a context: production builds the GitHub one; tests inject a fake. */
export type ForgeFactory = (ctx: ForgeContext) => ForgePort;
export const githubForgeFactory: ForgeFactory = (ctx) => new GitHubForge(ctx.repo, ctx.token);

// ── The entry being verified ─────────────────────────────────────────────────────────────────

/** An approved (or to-be-approved) entry and how to find it in any version of its file. */
export interface PrReviewEntry {
  /** The local file holding the entry (a Journey file, personas.json, jobs.json). */
  readonly file: string;
  /** The content hash the approval binds to. */
  readonly contentHash: string;
  /** The entry's content hash in one version of that file (null: the version does not hold it). */
  hashIn(text: string | null): string | null;
}

/** A persona's or job's entry in its catalog file (personas.json / jobs.json). */
export function catalogItemEntry(kind: "persona" | "job", file: string, id: string, contentHash: string): PrReviewEntry {
  return { file, contentHash, hashIn: (text) => catalogEntryHash(kind, text, id) };
}

/** A Journey's entry: its own file in the journeys dir (a namespaced, shared Journey has none: null). */
export function journeyEntry(journeysDir: string, id: string, contentHash: string): PrReviewEntry | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  return {
    file: join(journeysDir, `${id}.json`),
    contentHash,
    hashIn: (text) => {
      if (text === null) return null;
      try {
        const parsed = JourneySchema.safeParse(JSON.parse(text));
        return parsed.success && parsed.data.metadata.id === id ? journeyReviewHash(parsed.data) : null;
      } catch {
        return null;
      }
    },
  };
}

/** The entry file's path relative to its git repository (`/`-separated), or null outside one. */
export function repoPathOf(file: string): string | null {
  const root = findGitRoot(dirname(file));
  if (root === null) return null;
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..")) return null;
  return rel.split(sep).join("/");
}

export interface PrReviewPolicy {
  /** The approving reviewer must be a CODEOWNER of the entry's file. */
  readonly requireCodeOwner?: boolean;
}

const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

/** Each reviewer's latest decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED); comments do not count. */
function latestDecisive(reviews: readonly ForgeReview[]): ForgeReview[] {
  const by = new Map<string, ForgeReview>();
  for (const r of reviews) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) by.set(r.login.toLowerCase(), r);
  return [...by.values()];
}

async function isCodeOwner(forge: ForgePort, branch: string, path: string, login: string): Promise<boolean> {
  let text: string | null = null;
  for (const loc of GITHUB_CODEOWNERS_LOCATIONS) {
    text = await forge.fileAt(loc, branch);
    if (text !== null) break;
  }
  if (text === null) return false;
  for (const owner of codeownersOf(parseCodeownersFile(text), path)) {
    if (!owner.startsWith("@")) continue; // an email cannot be matched to a login
    const name = owner.slice(1);
    const slash = name.indexOf("/");
    if (slash < 0) {
      if (name.toLowerCase() === login.toLowerCase()) return true;
    } else if (await forge.teamMember(name.slice(0, slash), name.slice(slash + 1), login)) return true;
  }
  return false;
}

/** The pull request's qualifying approver (optionally only `onlyReviewer`), or the refusal. */
async function approverOf(forge: ForgePort, pull: ForgePull, branch: string, path: string, policy: PrReviewPolicy, onlyReviewer?: string): Promise<{ ok: true; review: ForgeReview; codeOwner?: boolean } | ForgeRefusal> {
  const approvals = latestDecisive(await forge.reviews(pull.number)).filter((r) => r.state === "APPROVED");
  const onHead = approvals.filter((r) => r.commitId === pull.headSha);
  const people = onHead.filter((r) => !r.isBot && r.login.toLowerCase() !== pull.author.toLowerCase());
  const candidates = onlyReviewer === undefined ? people : people.filter((r) => r.login.toLowerCase() === onlyReviewer.toLowerCase());
  if (candidates.length === 0) {
    const why =
      approvals.length === 0
        ? "it has no approving review"
        : onHead.length === 0
          ? "no approval is on its final (head) commit"
          : people.length === 0
            ? "its only approvals are by its author or a bot"
            : `${onlyReviewer ?? "the reviewer"} did not approve it`;
    return refuse("no-approving-review", `pull request #${pull.number}: ${why}`);
  }
  // A reviewer who authored or committed any commit of the pull request is not independent of it.
  const commits = await forge.pullCommits(pull.number);
  const contributed = (r: ForgeReview): boolean =>
    commits.some(
      (c) =>
        [c.authorLogin, c.committerLogin].some((l) => l !== undefined && l.toLowerCase() === r.login.toLowerCase()) ||
        (r.userId !== undefined && (c.authorId === r.userId || c.committerId === r.userId)),
    );
  const independent = candidates.filter((r) => !contributed(r));
  if (independent.length === 0) {
    return refuse("reviewer-contributed", `pull request #${pull.number}: every approving reviewer (${candidates.map((r) => r.login).join(", ")}) also authored or committed commits of it — not an independent review`);
  }
  let last: ForgeRefusal = refuse("no-approving-review", `pull request #${pull.number}: no approving reviewer has write access`);
  for (const r of independent) {
    if (!WRITE_ROLES.has(await forge.permission(r.login))) {
      last = refuse("no-approving-review", `pull request #${pull.number}: approving reviewer ${r.login} has no write access to the repository`);
      continue;
    }
    if (policy.requireCodeOwner === true) {
      if (!(await isCodeOwner(forge, branch, path, r.login))) {
        last = refuse("not-code-owner", `pull request #${pull.number}: approving reviewer ${r.login} is not a CODEOWNER of ${path} (${REQUIRE_CODEOWNER_ENV} is set)`);
        continue;
      }
      return { ok: true, review: r, codeOwner: true };
    }
    return { ok: true, review: r };
  }
  return last;
}

/**
 * The core of both verifications: `sha` is on the default branch, holds the entry's approved
 * content, CHANGED it (its first parent holds something else), and came from a merged pull request
 * into the default branch whose APPROVED head holds that same content, with a qualifying approval.
 */
async function verifyChange(
  forge: ForgePort,
  entry: PrReviewEntry,
  path: string,
  branch: string,
  sha: string,
  policy: PrReviewPolicy,
  recorded?: { readonly number: number; readonly reviewer: string; readonly author?: string },
): Promise<PrReviewVerdict> {
  if (!SHA_RE.test(sha)) return refuse("not-on-default-branch", `${sha} is not a full commit sha`);
  if (!(await forge.isAncestor(sha, branch))) return refuse("not-on-default-branch", `commit ${sha.slice(0, 12)} is not on the default branch ${branch}`);
  if (entry.hashIn(await forge.fileAt(path, sha)) !== entry.contentHash) {
    return refuse("content-mismatch", `${path} at commit ${sha.slice(0, 12)} does not hold the approved content of the entry`);
  }
  const parent = (await forge.commitParents(sha))[0];
  if (parent !== undefined && entry.hashIn(await forge.fileAt(path, parent)) === entry.contentHash) {
    return refuse("not-changed-here", `commit ${sha.slice(0, 12)} did not change the entry (its parent already held the same content)`);
  }
  const pulls = (await forge.pullsForCommit(sha)).filter((p) => p.mergedAt !== null && p.baseRef === branch && (recorded === undefined || p.number === recorded.number));
  if (pulls.length === 0) {
    return recorded === undefined
      ? refuse("no-merged-pr", `commit ${sha.slice(0, 12)} did not come from a pull request merged into ${branch}`)
      : refuse("pr-mismatch", `commit ${sha.slice(0, 12)} did not come from pull request #${recorded.number} merged into ${branch}`);
  }
  let first: ForgeRefusal | undefined;
  for (const pull of pulls) {
    if (recorded?.author !== undefined && recorded.author.toLowerCase() !== pull.author.toLowerCase()) {
      first ??= refuse("pr-mismatch", `pull request #${pull.number} was authored by ${pull.author}, not ${recorded.author}`);
      continue;
    }
    const a = await approverOf(forge, pull, branch, path, policy, recorded?.reviewer);
    if (!a.ok) {
      first ??= a;
      continue;
    }
    // The reviewer approved the pull request's head (approverOf honours only reviews on it): that
    // head must hold exactly the content being honoured. A merged commit's content that no reviewer
    // saw (an intermediate commit later reverted, an "evil merge" resolution) is never approved.
    const approvedHead = a.review.commitId;
    if (!SHA_RE.test(approvedHead) || entry.hashIn(await forge.fileAt(path, approvedHead)) !== entry.contentHash) {
      first ??= refuse(
        "pr-mismatch",
        `pull request #${pull.number}: its approved head ${approvedHead.slice(0, 12)} does not hold the content of the entry that commit ${sha.slice(0, 12)} holds in ${path} — the reviewer did not approve that content`,
      );
      continue;
    }
    const pr: PrReview = {
      forge: "github",
      number: pull.number,
      ...(pull.url === undefined ? {} : { url: pull.url }),
      mergedSha: sha,
      author: pull.author,
      reviewer: a.review.login,
      ...(a.review.submittedAt === undefined ? {} : { reviewedAt: a.review.submittedAt }),
      ...(a.codeOwner === undefined ? {} : { codeOwner: a.codeOwner }),
    };
    return { ok: true, pr };
  }
  return first ?? refuse("no-merged-pr", `commit ${sha.slice(0, 12)}: no qualifying pull request`);
}

function forgeFailure(err: unknown, token: string): ForgeRefusal {
  const msg = err instanceof Error ? err.message : String(err);
  return refuse("forge-error", `the forge could not be asked: ${redactText(msg, [token])}`);
}

/**
 * Verifies an approval being made in CI (`job|persona approve`, `journey promote`): the context
 * (GitHub Actions, the default branch, not a pull-request event), then the commit that last changed
 * the entry and its merged, approved pull request. The `pr` of a success is what gets recorded.
 */
export async function verifyPrReviewForApproval(entry: PrReviewEntry, env: Env, factory: ForgeFactory = githubForgeFactory, policy: PrReviewPolicy = { requireCodeOwner: requireCodeOwnerFromEnv(env) }): Promise<PrReviewVerdict> {
  const c = forgeContextFromEnv(env);
  if (!c.ok) return c;
  const { ctx } = c;
  if (ctx.event.startsWith("pull_request")) {
    return refuse("pull-request-event", `pr-review is never granted on a ${ctx.event} event (the pull request controls the files it would approve): approve on a push to the default branch`);
  }
  const path = repoPathOf(entry.file);
  if (path === null) return refuse("not-repo-file", `${entry.file} is not inside a git repository`);
  try {
    const forge = factory(ctx);
    const branch = await forge.defaultBranch();
    if (ctx.ref !== `refs/heads/${branch}`) return refuse("not-default-branch", `pr-review is granted only on the default branch (${branch}); this run is on ${ctx.ref === "" ? "an unknown ref" : ctx.ref}`);
    const commits = await forge.commitsTouching(path, branch, HISTORY_LIMIT);
    if (commits.length === 0) return refuse("content-mismatch", `no commit on ${branch} touches ${path}`);
    let candidate: string | undefined;
    for (let i = 0; i < commits.length; i++) {
      const sha = commits[i] as string;
      const here = entry.hashIn(await forge.fileAt(path, sha));
      if (here !== entry.contentHash) {
        if (i === 0) return refuse("content-mismatch", `${path} on ${branch} does not hold the content being approved (approve from a checkout of the default branch's head)`);
        break;
      }
      candidate = sha;
      if (i === commits.length - 1 && commits.length >= HISTORY_LIMIT) {
        return refuse("history-too-deep", `the entry is unchanged in the last ${HISTORY_LIMIT} commits touching ${path}: its last change is too far back to verify`);
      }
    }
    return await verifyChange(forge, entry, path, branch, candidate as string, policy);
  } catch (err) {
    return forgeFailure(err, ctx.token);
  }
}

/**
 * RE-verifies a recorded `pr-review` approval (`check --require-approvals`): the recorded merged
 * commit is on the default branch, holds the approved content and changed it, and came from the
 * recorded pull request, approved by the recorded reviewer, who still qualifies. Runs on any event
 * (it reads only forge facts; a pull request's files cannot change them).
 */
export async function reverifyPrReview(entry: PrReviewEntry, pr: PrReview, env: Env, factory: ForgeFactory = githubForgeFactory, policy: PrReviewPolicy = { requireCodeOwner: requireCodeOwnerFromEnv(env) }): Promise<PrReviewVerdict> {
  const c = forgeContextFromEnv(env);
  if (!c.ok) return c;
  const path = repoPathOf(entry.file);
  if (path === null) return refuse("not-repo-file", `${entry.file} is not inside a git repository`);
  if (pr.forge !== undefined && pr.forge !== "github") return refuse("not-github", `recorded forge '${String(pr.forge)}' is not supported`);
  try {
    const forge = factory(c.ctx);
    const branch = await forge.defaultBranch();
    const v = await verifyChange(forge, entry, path, branch, pr.mergedSha, policy, { number: pr.number, reviewer: pr.reviewer, ...(pr.author === undefined ? {} : { author: pr.author }) });
    return v.ok ? { ok: true, pr: { ...pr, ...(v.pr.codeOwner === undefined ? {} : { codeOwner: v.pr.codeOwner }) } } : v;
  } catch (err) {
    return forgeFailure(err, c.ctx.token);
  }
}

// ── The re-verification cache ────────────────────────────────────────────────────────────────

/**
 * Whether the cache dir `dir` is untrusted by git: true when git tracks any file under it, and also
 * when git cannot say (no repository, git missing or failing — fail closed). Runs `git ls-files`
 * from the repository root with the dir as a pathspec (never with the cache dir as cwd: a committed
 * symlink there would make git fail and read as "nothing tracked").
 */
export type GitTracked = (dir: string) => Promise<boolean>;

export const gitTracksAnything: GitTracked = (dir) =>
  new Promise((resolveTracked) => {
    const root = findGitRoot(dir);
    const rel = root === null ? "" : relative(root, resolve(dir));
    if (root === null || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      resolveTracked(true);
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["ls-files", "--", rel.split(sep).join("/")], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolveTracked(true);
      return;
    }
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    // No git / a git error: untrusted.
    child.on("error", () => resolveTracked(true));
    child.on("close", (code) => resolveTracked(code !== 0 || out.trim() !== ""));
  });

/**
 * True when every path component from the git repository root down to `target` is a real
 * directory or file (no symlink), so `target` cannot resolve outside the repository. Components
 * that do not exist yet are fine (they will be created as real directories). Outside a repository,
 * or on any other error: false.
 */
export async function noSymlinkFromRepoRoot(target: string): Promise<boolean> {
  const abs = resolve(target);
  const root = findGitRoot(abs);
  if (root === null) return false;
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  let cur = root;
  for (const seg of rel.split(sep)) {
    cur = join(cur, seg);
    try {
      if ((await lstat(cur)).isSymbolicLink()) return false;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "ENOENT") return true;
      return false;
    }
  }
  return true;
}

export interface PrReviewCacheKey {
  readonly repo: string;
  readonly path: string;
  readonly contentHash: string;
  readonly pr: PrReview;
  readonly requireCodeOwner: boolean;
}

function cacheKey(k: PrReviewCacheKey): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, repo: k.repo, path: k.path, contentHash: k.contentHash, number: k.pr.number, mergedSha: k.pr.mergedSha, reviewer: k.pr.reviewer.toLowerCase(), author: k.pr.author ?? null, requireCodeOwner: k.requireCodeOwner }))
    .digest("hex");
}

/**
 * Positive re-verifications, cached by merged sha in the project's gitignored cache dir
 * (`<.jevitate>/cache/pr-review/<mergedSha>-<key>.json`) so CI does not re-ask the forge every run.
 * Only a success is cached, for `PR_REVIEW_CACHE_TTL_MS`; the cache is ignored entirely (never read,
 * never written) when any file in it is tracked by git or git cannot say (a committed "verified"
 * entry is never trusted), or when any path component from the repository root down to a cache
 * file is a symlink (a committed symlink could point it anywhere). It is never read nor written on
 * a pull-request event.
 */
export class PrReviewCache {
  #trusted: Promise<boolean> | undefined;
  constructor(
    private readonly dir: string | null,
    private readonly gitTracked: GitTracked = gitTracksAnything,
  ) {}

  #file(k: PrReviewCacheKey): string {
    return join(this.dir as string, `${k.pr.mergedSha}-${cacheKey(k).slice(0, 32)}.json`);
  }

  #isTrusted(): Promise<boolean> {
    const dir = this.dir;
    this.#trusted ??= dir === null ? Promise.resolve(false) : noSymlinkFromRepoRoot(dir).then(async (safe) => safe && !(await this.gitTracked(dir)));
    return this.#trusted;
  }

  /** The cache file for `k`, or null when the cache is untrusted or the file path is unsafe. */
  async #safeFile(k: PrReviewCacheKey): Promise<string | null> {
    if (this.dir === null || !(await this.#isTrusted())) return null;
    const file = this.#file(k);
    return (await noSymlinkFromRepoRoot(file)) ? file : null;
  }

  async hit(k: PrReviewCacheKey): Promise<boolean> {
    const file = await this.#safeFile(k);
    if (file === null) return false;
    try {
      const j = JSON.parse(await readFile(file, "utf8")) as { key?: unknown; verifiedAtMs?: unknown };
      if (j.key !== cacheKey(k) || typeof j.verifiedAtMs !== "number") return false;
      const age = clock.now() - j.verifiedAtMs;
      return age >= 0 && age < PR_REVIEW_CACHE_TTL_MS;
    } catch {
      return false;
    }
  }

  async put(k: PrReviewCacheKey): Promise<void> {
    const file = await this.#safeFile(k);
    if (file === null) return;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, `${JSON.stringify({ key: cacheKey(k), verifiedAtMs: clock.now(), number: k.pr.number, reviewer: k.pr.reviewer })}\n`, { mode: 0o600 });
    } catch {
      // a cache that cannot be written only costs a re-query next run
    }
  }
}

/** The cache dir of a project data dir (`<.jevitate>/cache/pr-review`), or null outside a project. */
export function prReviewCacheDir(catalogDir: string | null): string | null {
  return catalogDir === null ? null : join(catalogDir, "cache", "pr-review");
}

/**
 * Re-verification through the cache: a cached success is honoured and a fresh success is cached —
 * except on a pull-request event, where the cache is neither read nor written (always verified live).
 */
export async function reverifyPrReviewCached(entry: PrReviewEntry, pr: PrReview, env: Env, cache: PrReviewCache, factory: ForgeFactory = githubForgeFactory): Promise<PrReviewVerdict> {
  const c = forgeContextFromEnv(env);
  if (!c.ok) return c;
  const path = repoPathOf(entry.file);
  if (path === null) return refuse("not-repo-file", `${entry.file} is not inside a git repository`);
  const policy: PrReviewPolicy = { requireCodeOwner: requireCodeOwnerFromEnv(env) };
  const key: PrReviewCacheKey = { repo: c.ctx.repo, path, contentHash: entry.contentHash, pr, requireCodeOwner: policy.requireCodeOwner === true };
  const prEvent = c.ctx.event.startsWith("pull_request");
  if (!prEvent && (await cache.hit(key))) return { ok: true, pr };
  const v = await reverifyPrReview(entry, pr, env, factory, policy);
  if (v.ok && !prEvent) await cache.put(key);
  return v;
}
