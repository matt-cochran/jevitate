import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isReleaseBuild, RELEASE_SIGNAL } from "../../packages/cli/scripts/generate-build-info.mjs";
import { versionString } from "../../packages/cli/src/program.ts";
import { checkVersionIdentity, verifyInstalledIdentity } from "./release-artifact.mjs";

const COMMIT = "abc1234".padEnd(40, "0");
const TREE = "def5678".padEnd(40, "0");
const BUILT = "2026-10-15T00:00:00.000Z";
const RELEASE_LINE = `1.2.3 (commit abc1234, tree def5678, built ${BUILT})`;
const manifest = { tree: TREE, commit: COMMIT, versions: { "@jevitate/cli": "1.2.3", jevitate: "1.2.3" }, files: { "@jevitate/cli": "jevitate-cli-1.2.3.tgz", jevitate: "jevitate-1.2.3.tgz" }, runId: null };
const engine = { version: "1.2.3", commit: "abc1234", builtAt: BUILT };

describe("how a build knows it is a release (#784)", () => {
  it("a build with no release signal is unreleased", () => {
    expect(isReleaseBuild({})).toBe(false);
  });

  it("a signal naming this checkout's tree is a release build", () => {
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    expect(isReleaseBuild({ [RELEASE_SIGNAL]: tree })).toBe(true);
  });

  it("a signal naming any other tree stops the build", () => {
    expect(() => isReleaseBuild({ [RELEASE_SIGNAL]: "1" })).toThrow(/this checkout's tree/);
  });
});

describe("--version (#784)", () => {
  it("a source build carries the marker and the commit in its version", () => {
    expect(versionString(engine, "def5678", false)).toBe(`1.2.3-source-abc1234 (commit abc1234, tree def5678, built ${BUILT})`);
  });

  it("a source build without git identity still carries the marker", () => {
    expect(versionString({ version: "1.2.3", commit: "unknown", builtAt: "unknown" }, "unknown", false)).toBe("1.2.3-source-unknown");
  });

  it("a release build keeps the published format byte for byte", () => {
    expect(versionString(engine, "def5678", true)).toBe(RELEASE_LINE);
  });

  it("a build nothing signalled defaults to the source marker", () => {
    expect(versionString()).toMatch(/^\d+\.\d+\.\d+-source-/);
  });
});

describe("checkVersionIdentity (#784)", () => {
  it("a release line matching the manifest yields its identity", () => {
    expect(checkVersionIdentity(RELEASE_LINE, manifest)).toEqual({ version: "1.2.3", commit: "abc1234", tree: "def5678", builtAt: BUILT });
  });

  it("a source build of the manifest's own commit is refused", () => {
    expect(() => checkVersionIdentity(versionString(engine, "def5678", false), manifest)).toThrow(/reports version 1\.2\.3-source-abc1234/);
  });

  it("another version is refused", () => {
    expect(() => checkVersionIdentity(RELEASE_LINE.replace("1.2.3", "1.2.4"), manifest)).toThrow(/reports version 1\.2\.4/);
  });

  it("another commit is refused", () => {
    expect(() => checkVersionIdentity(RELEASE_LINE.replace("abc1234", "ea67344"), manifest)).toThrow(/reports commit ea67344/);
  });

  it("another tree is refused", () => {
    expect(() => checkVersionIdentity(RELEASE_LINE.replace("def5678", "ac54147"), manifest)).toThrow(/reports tree ac54147/);
  });

  it("a line without commit and tree is refused", () => {
    expect(() => checkVersionIdentity("1.2.3", manifest)).toThrow(/not in the release format/);
  });
});

describe("verifyInstalledIdentity (#784)", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** An artifact whose dependency-free cli tarball prints `line`, so real npm installs it offline. */
  function artifactPrinting(line) {
    const dir = mkdtempSync(join(tmpdir(), "jevitate-identity-test-"));
    dirs.push(dir);
    const pkg = join(dir, "src", "package");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@jevitate/cli", version: "1.2.3", bin: { jevitate: "dist/bin.js" } }));
    writeFileSync(join(pkg, "dist", "bin.js"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(line)});\n`);
    chmodSync(join(pkg, "dist", "bin.js"), 0o755);
    const out = join(dir, "artifact");
    mkdirSync(out);
    execFileSync("tar", ["-czf", join(out, manifest.files["@jevitate/cli"]), "-C", join(dir, "src"), "package"]);
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
    return out;
  }

  it("an installed tarball reporting the manifest's identity passes", () => {
    expect(verifyInstalledIdentity(artifactPrinting(RELEASE_LINE)).tree).toBe("def5678");
  }, 120_000);

  it("an installed tarball holding a source build is refused", () => {
    expect(() => verifyInstalledIdentity(artifactPrinting(`1.2.3-source-abc1234 (commit abc1234, tree def5678, built ${BUILT})`))).toThrow(/reports version/);
  }, 120_000);
});

// The real pack needs a build and the registry, so it runs on request against a pack's output:
//   pnpm -r build && bash scripts/ci/pack-release.sh <dir>
//   JEVITATE_RELEASE_ARTIFACT=<dir> pnpm exec vitest run scripts/ci/release-identity.test.mjs
const artifact = process.env.JEVITATE_RELEASE_ARTIFACT;
describe.skipIf(artifact === undefined)("the real packed tarball (#784)", () => {
  it("its installed --version names the manifest's tree", () => {
    const { tree } = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8"));
    expect(tree.startsWith(verifyInstalledIdentity(artifact).tree)).toBe(true);
  }, 600_000);
});
