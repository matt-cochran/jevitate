#!/usr/bin/env node
// Finds a green, still-downloadable release-candidate artifact for a git tree (#534), so a
// promotion PR (dev → staging → main) or a staging/main release reuses what a dev push already
// built and tested instead of running the suite again on identical content.
//
//   node scripts/ci/find-tree-artifact.mjs <tree-sha>
//
// Needs GITHUB_TOKEN (actions: read, contents: read) and GITHUB_REPOSITORY. Prints the match
// as JSON and, under Actions, writes `found`, `run_id`, `artifact_id`, `head_sha` and
// `artifact` to $GITHUB_OUTPUT. "Not found" is NOT an error (exit 0, found=false): the caller
// then runs the full suite (or builds) itself. An API failure exits 1.
//
// An artifact counts only when ALL hold:
//   - it is named jevitate-<tree>, not expired, and uploaded in THIS repository;
//   - its run concluded `success`: either a CI push run on `dev` (.github/workflows/ci.yml),
//     or a Release run (.github/workflows/release.yml, whose fallback build runs the same suite);
//   - the run's head commit really has that tree (asked of the git API, not trusted from the name).
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { artifactName } from "./release-artifact.mjs";

const workflowFile = (path) => (path ?? "").replace(/@.*$/, "");

/** Whether a workflow run may vouch for a release-candidate artifact (see the header). */
export function trustedRun(run, repo) {
  if (run?.conclusion !== "success" || run.repository?.full_name !== repo) return false;
  const file = workflowFile(run.path);
  if (file === ".github/workflows/ci.yml") return run.event === "push" && run.head_branch === "dev";
  return file === ".github/workflows/release.yml";
}

/**
 * The newest artifact for `tree` that a trusted run produced. `api(path)` resolves a GitHub REST
 * path (e.g. `/repos/o/r/actions/runs/1`) to its JSON body; injected so tests need no network.
 */
export async function findTreeArtifact({ api, repo, tree }) {
  const name = artifactName(tree);
  const { artifacts = [] } = await api(`/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
  const candidates = artifacts
    .filter((a) => a.name === name && !a.expired && a.workflow_run?.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const rejected = [];
  for (const artifact of candidates) {
    const run = await api(`/repos/${repo}/actions/runs/${artifact.workflow_run.id}`);
    if (!trustedRun(run, repo)) {
      rejected.push(`run ${run?.id} (${workflowFile(run?.path)} ${run?.event} ${run?.head_branch}: ${run?.status}/${run?.conclusion})`);
      continue;
    }
    const commit = await api(`/repos/${repo}/git/commits/${run.head_sha}`);
    if (commit?.tree?.sha !== tree) {
      rejected.push(`run ${run.id} (commit ${run.head_sha} has tree ${commit?.tree?.sha})`);
      continue;
    }
    return { found: true, tree, artifact: name, artifactId: artifact.id, runId: run.id, headSha: run.head_sha, runUrl: run.html_url, rejected };
  }
  return { found: false, tree, artifact: name, rejected };
}

function githubApi(token) {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return async (path) => {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };
}

async function main(argv) {
  const tree = argv[0];
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!/^[0-9a-f]{40}$/.test(tree ?? "") || !repo || !token) {
    console.error("usage: GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo find-tree-artifact.mjs <40-hex tree sha>");
    return 64;
  }
  const result = await findTreeArtifact({ api: githubApi(token), repo, tree });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    const out = { found: result.found, artifact: result.artifact, run_id: result.runId ?? "", artifact_id: result.artifactId ?? "", head_sha: result.headSha ?? "" };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(""));
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(`::error title=Artifact lookup failed::${err.message}`);
      process.exitCode = 1;
    },
  );
}
