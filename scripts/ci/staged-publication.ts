import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGES, verifyArtifact } from './release-artifact.mjs';

type Api = (path: string) => any;
type Run = { id: number; run_attempt: number; head_sha: string; head_branch: string;
  head_repository: { full_name: string }; path: string; event: string; status: string; conclusion: string };
const sha = /^[a-f0-9]{40}$/;

export function requireStagedPlan(mode: string, needsArtifact: string, found: string): void {
  if (mode === 'version') throw new Error('Version packages on dev and promote through staging.');
  if (mode === 'none') return;
  if (mode !== 'latest' || needsArtifact !== 'false') {
    throw new Error('Production cannot first-publish a package: complete staging publication first.');
  }
  if (found !== 'true') throw new Error('No verified candidate artifact; production never rebuilds or retests.');
}

export function validateBuild(run: Run, manifest: any, repository: string, tree: string): void {
  if (run.status !== 'completed' || run.conclusion !== 'success'
    || run.head_repository?.full_name !== repository
    || !['.github/workflows/ci.yml', '.github/workflows/release.yml'].includes(run.path)
    || !['push', 'workflow_dispatch'].includes(run.event)
    || !['dev', 'staging'].includes(run.head_branch)
    || Number(manifest.runId) !== run.id || manifest.commit !== run.head_sha
    || manifest.tree !== tree || !sha.test(manifest.commit)) throw new Error('Untrusted candidate build');
}

export function validatePublication(run: Run, jobs: any[], repository: string, tree: string, commitTree: string): void {
  if (run.status !== 'completed' || run.conclusion !== 'success'
    || run.head_repository?.full_name !== repository || run.path !== '.github/workflows/release.yml'
    || run.head_branch !== 'staging' || !['push', 'workflow_dispatch'].includes(run.event)
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || !sha.test(run.head_sha) || !sha.test(tree) || commitTree !== tree) throw new Error('Untrusted staging publication');
  const publishers = jobs.filter(job => job.name === 'npm');
  if (publishers.length !== 1 || publishers[0].run_id !== run.id
    || (publishers[0].run_attempt != null && publishers[0].run_attempt !== run.run_attempt)
    || publishers[0].status !== 'completed' || publishers[0].conclusion !== 'success') {
    throw new Error('The matching staging run did not complete npm publication');
  }
}

export function verifyRegistry(name: string, version: string, bytes: Buffer, metadata: any): string {
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (metadata.name !== name || metadata.version !== version || metadata.dist?.integrity !== integrity) {
    throw new Error(`Registry bytes differ from the verified candidate: ${name}@${version}`);
  }
  return integrity;
}

export async function verifyPublication(dir: string, tree: string, version: string, buildId: number,
  repository: string, api: Api, registry: (name: string, version: string) => Promise<any>) {
  if (!sha.test(tree) || !Number.isSafeInteger(buildId) || buildId < 1) throw new Error('Expected exact tree and candidate run');
  const manifest = verifyArtifact(dir, { tree, version });
  const build = api(`repos/${repository}/actions/runs/${buildId}`);
  validateBuild(build, manifest, repository, tree);
  if (api(`repos/${repository}/git/commits/${manifest.commit}`).tree.sha !== tree) throw new Error('Candidate source tree changed');
  let staging: Run | undefined;
  for (let page = 1; page <= 10 && !staging; page++) {
    const runs: Run[] = api(`repos/${repository}/actions/workflows/release.yml/runs?branch=staging&status=success&per_page=100&page=${page}`).workflow_runs;
    for (const run of runs) {
      if (run.head_repository?.full_name !== repository || run.head_branch !== 'staging'
        || run.path !== '.github/workflows/release.yml' || !['push', 'workflow_dispatch'].includes(run.event)) continue;
      const commitTree = api(`repos/${repository}/git/commits/${run.head_sha}`).tree.sha;
      if (commitTree !== tree) continue;
      const jobs = api(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs;
      try { validatePublication(run, jobs, repository, tree, commitTree); } catch { continue; }
      staging = run; break;
    }
    if (runs.length < 100) break;
  }
  if (!staging) throw new Error('No successful staging npm publication matches this complete tree; no production fallback.');
  const packages = [];
  for (const pkg of PACKAGES) {
    const bytes = readFileSync(join(dir, manifest.files[pkg.name]));
    const integrity = verifyRegistry(pkg.name, version, bytes, await registry(pkg.name, version));
    packages.push({ name: pkg.name, version, integrity, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { repository, tree, build_run: buildId, staging_run: staging.id, staging_attempt: staging.run_attempt, packages };
}

async function main() {
  if (process.argv[2] === 'plan') {
    requireStagedPlan(process.env.MODE || '', process.env.NEEDS_ARTIFACT || '', process.env.FOUND || '');
    return;
  }
  if (process.argv[2] !== 'verify' || !process.argv[3]) throw new Error('Usage: staged-publication.ts plan | verify <candidate directory>');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const api: Api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const registry = async (name: string, version: string) => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    if (!response.ok) throw new Error(`Cannot verify registry metadata for ${name}@${version}: ${response.status}`);
    return response.json();
  };
  const version = JSON.parse(readFileSync(join(PACKAGES[0].dir, 'package.json'), 'utf8')).version;
  const proof = await verifyPublication(resolve(process.argv[3]), git('rev-parse', 'HEAD^{tree}'), version,
    Number(process.env.BUILD_RUN), process.env.GITHUB_REPOSITORY!, api, registry);
  console.log(JSON.stringify(proof, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Verified staged publication and registry byte identity. No build or test ran.\n\n\`\`\`json\n${JSON.stringify(proof, null, 2)}\n\`\`\`\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
