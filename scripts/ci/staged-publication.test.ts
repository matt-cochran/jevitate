import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateBuild, validatePublication, verifyRegistry, requireStagedPlan } from './staged-publication.ts';

const repository = 'matt-cochran/jevitate', tree = 'a'.repeat(40), commit = 'b'.repeat(40);
const stage = { id: 51, run_attempt: 2, head_sha: commit, head_branch: 'staging',
  head_repository: { full_name: repository }, path: '.github/workflows/release.yml', event: 'push', status: 'completed', conclusion: 'success' };
const jobs = [{ name: 'npm', run_id: 51, run_attempt: 2, status: 'completed', conclusion: 'success' }];
test('production cannot first-publish even when a candidate artifact exists', () => {
  assert.throws(() => requireStagedPlan('latest', 'true', 'true'), /staging publication/);
  assert.throws(() => requireStagedPlan('latest', 'false', 'false'), /never rebuilds/);
  assert.throws(() => requireStagedPlan('version', 'false', 'true'), /Version packages on dev/);
  assert.throws(() => requireStagedPlan('next', 'false', 'true'));
  requireStagedPlan('latest', 'false', 'true');
  requireStagedPlan('none', '', '');
});
test('a completed same-tree staging publication is accepted', () => validatePublication(stage, jobs, repository, tree, tree));
test('main, forks, PRs, failed runs, wrong workflows and other trees are rejected', () => {
  for (const patch of [{ head_branch: 'main' }, { head_repository: { full_name: 'fork/jevitate' } },
    { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }, { path: '.github/workflows/ci.yml' }, { run_attempt: 0 }]) {
    assert.throws(() => validatePublication({ ...stage, ...patch }, jobs, repository, tree, tree));
  }
  assert.throws(() => validatePublication(stage, jobs, repository, tree, 'c'.repeat(40)));
});
test('skipped/failed publication and a mismatched rerun cannot serve as acceptance', () => {
  for (const patch of [{ conclusion: 'skipped' }, { conclusion: 'failure' }, { run_attempt: 1 }, { run_id: 99 }, { status: 'queued' }]) {
    assert.throws(() => validatePublication(stage, [{ ...jobs[0], ...patch }], repository, tree, tree));
  }
  assert.throws(() => validatePublication(stage, [], repository, tree, tree));
  assert.throws(() => validatePublication(stage, [...jobs, ...jobs], repository, tree, tree));
});
test('the candidate must belong to its own successful pre-main build and commit', () => {
  const build = { ...stage, id: 42, path: '.github/workflows/ci.yml', head_branch: 'dev' };
  const manifest = { runId: '42', commit, tree };
  validateBuild(build, manifest, repository, tree);
  for (const patch of [{ runId: 43 }, { commit: 'c'.repeat(40) }, { tree: 'c'.repeat(40) }]) {
    assert.throws(() => validateBuild(build, { ...manifest, ...patch }, repository, tree));
  }
  assert.throws(() => validateBuild({ ...build, head_branch: 'main' }, manifest, repository, tree));
});
test('both package identity and exact compressed tarball bytes must match the registry', () => {
  const bytes = Buffer.from('retained tarball bytes');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const metadata = { name: '@jevitate/cli', version: '1.2.3', dist: { integrity } };
  assert.equal(verifyRegistry('@jevitate/cli', '1.2.3', bytes, metadata), integrity);
  assert.throws(() => verifyRegistry('@jevitate/cli', '1.2.3', Buffer.from('changed'), metadata));
  assert.throws(() => verifyRegistry('jevitate', '1.2.3', bytes, metadata));
  assert.throws(() => verifyRegistry('@jevitate/cli', '1.2.4', bytes, metadata));
});
test('the retired manual publisher exits before installing, building or publishing', () => {
  const result = spawnSync('bash', ['scripts/release.sh'], { encoding: 'utf8', input: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /retained.*release|release.*retained/i);
});
