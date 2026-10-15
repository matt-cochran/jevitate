#!/usr/bin/env node
// The release-candidate artifact (#534): the two `pnpm pack` tarballs a green dev push built,
// plus a manifest and SHA-256 checksums, so staging/main publish the tested bytes instead of
// rebuilding. The artifact is named after the git TREE hash, which a dev squash commit and the
// staging/main merge commits that promote it share.
//
//   node scripts/ci/release-artifact.mjs write  <dir>   (after scripts/ci/pack-release.sh)
//   node scripts/ci/release-artifact.mjs verify <dir> --tree <sha> --version <x.y.z>
//
// <dir> holds exactly: jevitate-cli-<v>.tgz, jevitate-<v>.tgz, manifest.json, SHA256SUMS.
// SHA256SUMS uses `sha256sum` format, so `sha256sum -c SHA256SUMS` also works by hand.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The two public packages, in publish order (the alias depends on the cli). */
export const PACKAGES = [
  { name: "@jevitate/cli", dir: "packages/cli", file: (v) => `jevitate-cli-${v}.tgz` },
  { name: "jevitate", dir: "packages/jevitate-cli-alias", file: (v) => `jevitate-${v}.tgz` },
];

export const artifactName = (tree) => `jevitate-${tree}`;

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** `package/package.json` inside a tarball (`tar` is on every runner). */
function packedManifest(tgz) {
  return JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }));
}

/** Writes manifest.json and SHA256SUMS for the tarballs pack-release.sh put in `dir`. */
export function writeArtifact(dir, { tree, commit, runId, root = "." }) {
  const versions = {};
  const files = {};
  for (const pkg of PACKAGES) {
    const version = JSON.parse(readFileSync(join(root, pkg.dir, "package.json"), "utf8")).version;
    versions[pkg.name] = version;
    files[pkg.name] = pkg.file(version);
  }
  const manifest = { tree, commit, versions, files, runId };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = [...Object.values(files), "manifest.json"].map((f) => `${sha256(join(dir, f))}  ${f}`);
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return manifest;
}

/**
 * Checks a downloaded artifact before anything is published from it. Returns the manifest;
 * throws on the first problem: a checksum mismatch, a file missing from or not listed in
 * SHA256SUMS, a manifest for another tree or version, or a tarball whose package.json disagrees
 * (including the alias not pinning the exact cli version).
 */
export function verifyArtifact(dir, { tree, version }) {
  const fail = (msg) => {
    throw new Error(`release artifact in ${dir}: ${msg}`);
  };
  const listed = new Map();
  for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) fail(`malformed SHA256SUMS line: ${line}`);
    listed.set(m[2], m[1]);
  }
  const present = readdirSync(dir).filter((f) => f !== "SHA256SUMS");
  for (const f of present) if (!listed.has(f)) fail(`${f} is not listed in SHA256SUMS`);
  for (const [f, want] of listed) {
    if (!present.includes(f)) fail(`${f} is listed in SHA256SUMS but missing`);
    const got = sha256(join(dir, f));
    if (got !== want) fail(`checksum mismatch for ${f}: expected ${want}, got ${got}`);
  }
  if (!listed.has("manifest.json")) fail("manifest.json is not covered by SHA256SUMS");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.tree !== tree) fail(`built from tree ${manifest.tree}, expected ${tree}`);
  for (const pkg of PACKAGES) {
    if (manifest.versions?.[pkg.name] !== version) fail(`${pkg.name} is ${manifest.versions?.[pkg.name]}, expected ${version}`);
    const file = manifest.files?.[pkg.name];
    if (file !== pkg.file(version) || !listed.has(file)) fail(`no ${pkg.file(version)} for ${pkg.name}`);
    const packed = packedManifest(join(dir, file));
    if (packed.name !== pkg.name || packed.version !== version) fail(`${file} contains ${packed.name}@${packed.version}`);
  }
  const alias = packedManifest(join(dir, PACKAGES[1].file(version)));
  if (alias.dependencies?.["@jevitate/cli"] !== version) {
    fail(`jevitate depends on @jevitate/cli ${alias.dependencies?.["@jevitate/cli"]}, expected exactly ${version}`);
  }
  return manifest;
}

function main(argv) {
  const [cmd, dir, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };
  if (cmd === "write" && dir) {
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
    const manifest = writeArtifact(resolve(dir), {
      tree: git("rev-parse", "HEAD^{tree}"),
      commit: git("rev-parse", "HEAD"),
      runId: process.env.GITHUB_RUN_ID ?? null,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }
  if (cmd === "verify" && dir && opt("tree") && opt("version")) {
    const manifest = verifyArtifact(resolve(dir), { tree: opt("tree"), version: opt("version") });
    console.log(`verified ${Object.values(manifest.files).join(", ")} (tree ${manifest.tree}, commit ${manifest.commit}, run ${manifest.runId})`);
    return 0;
  }
  console.error("usage: release-artifact.mjs write <dir> | verify <dir> --tree <sha> --version <x.y.z>");
  return 64;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error title=Release artifact::${err.message}`);
    process.exitCode = 1;
  }
}
