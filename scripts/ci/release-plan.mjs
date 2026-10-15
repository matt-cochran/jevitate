#!/usr/bin/env node
// Decides what one Release workflow run does (#534). Plain data in, one mode out; the workflow
// gathers the facts (versions, pending changesets, what npm already has) and acts on the mode.
//
//   version - main, changesets pending: `changeset version`, push changeset-release/main.
//   next    - staging, a version npm doesn't have: publish the tree's tested tarballs with
//             dist-tag `next` (the release candidate; `npm i -g @jevitate/cli@next`).
//   latest  - a pushed vX.Y.Z tag (or a manual run with `publish` on main): point dist-tag
//             `latest` at the version (published by the staging run), publishing the tested tarballs first only if npm lacks the version
//             (the staging step was skipped or failed); then package tags, vX.Y.Z and the
//             GitHub release.
//   none    - nothing to do. A plain push to main never promotes: prod is the explicit tag push
//             (maintainer decision, 0.15.0), so main only reports "ready: push vX.Y.Z".
//
// A manual run (workflow_dispatch) only acts with `publish` checked: it is the retry path.
//
//   node scripts/ci/release-plan.mjs   (reads the facts from the environment / npm; see main())
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {object} f
 * @param {string} f.event         github.event_name
 * @param {string} f.refType       github.ref_type ("branch" | "tag")
 * @param {string} f.refName       github.ref_name
 * @param {boolean} f.publishInput workflow_dispatch's `publish` checkbox
 * @param {string} f.version       packages/cli version
 * @param {string} f.aliasVersion  packages/jevitate-cli-alias version
 * @param {number} f.pending       pending .changeset/*.md files
 * @param {{cli: boolean, alias: boolean}} f.onNpm   whether npm has each package at `version`
 * @returns {{mode: "version"|"next"|"latest"|"none", needsArtifact: boolean, reason: string}}
 */
export function planRelease(f) {
  const none = (reason) => ({ mode: "none", needsArtifact: false, reason });
  const channel = f.refType === "tag" ? "main" : f.refName === "main" || f.refName === "staging" ? f.refName : undefined;
  if (channel === undefined) return none(`${f.refType} ${f.refName} is not a release channel (staging, main, vX.Y.Z)`);
  if (f.pending > 0) {
    if (channel === "main" && f.refType !== "tag") return { mode: "version", needsArtifact: false, reason: `${f.pending} changeset(s) pending` };
    return none(`${f.pending} changeset(s) pending; version them first (RELEASING.md)`);
  }
  if (f.aliasVersion !== f.version) throw new Error(`jevitate is ${f.aliasVersion} but @jevitate/cli is ${f.version}; they release together`);
  if (f.event === "workflow_dispatch" && !f.publishInput) return none("manual run without `publish` (plan only)");
  const missing = !f.onNpm.cli || !f.onNpm.alias;
  if (channel === "staging") {
    return missing ? { mode: "next", needsArtifact: true, reason: `${f.version} is not on npm: publish it as next` } : none(`${f.version} is already on npm`);
  }
  if (f.refType !== "tag" && f.event === "push") {
    return none(`${f.version} is ready for prod: push the tag (git tag -a v${f.version} -m v${f.version} origin/main && git push origin v${f.version})`);
  }
  return {
    mode: "latest",
    needsArtifact: missing,
    reason: missing ? `${f.version} is not on npm (staging step skipped or failed): publish it as latest` : `${f.version} is on npm: move latest to it`,
  };
}

function main() {
  const env = process.env;
  const read = (dir) => JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version;
  const version = read("packages/cli");
  const aliasVersion = read("packages/jevitate-cli-alias");
  const onNpm = (spec) => {
    try {
      return execFileSync("npm", ["view", spec, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
    } catch {
      return false; // E404: not published
    }
  };
  const facts = {
    event: env.GITHUB_EVENT_NAME,
    refType: env.GITHUB_REF_TYPE,
    refName: env.GITHUB_REF_NAME,
    publishInput: env.PUBLISH_INPUT === "true",
    version,
    aliasVersion,
    pending: readdirSync(".changeset").filter((f) => f.endsWith(".md") && f !== "README.md").length,
    onNpm: { cli: onNpm(`@jevitate/cli@${version}`), alias: onNpm(`jevitate@${aliasVersion}`) },
  };
  const plan = planRelease(facts);
  console.log(JSON.stringify({ facts, plan }, null, 2));
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `mode=${plan.mode}\nversion=${version}\nneeds_artifact=${plan.needsArtifact}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Release plan: \`${plan.mode}\`\n\n${plan.reason}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`::error title=Release plan::${err.message}`);
    process.exitCode = 1;
  }
}
