import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isReleaseBuild, RELEASE_SIGNAL } from "../../packages/cli/scripts/generate-build-info.mjs";
import { versionString } from "../../packages/cli/src/program.ts";
import { checkVersionIdentity, verifyPackedIdentity } from "./release-artifact.mjs";

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

describe("verifyPackedIdentity (#784)", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "jevitate-identity-test-"));
    dirs.push(dir);
    return dir;
  };
  const put = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const printing = (line) => `console.log(${JSON.stringify(line)});\n`;
  const PRINT_PINNED_DEP = `import { line } from "pinned-dep";\nconsole.log(line);\n`;

  /**
   * A checkout after a frozen install: the cli has one dependency, which exists nowhere but here (so
   * a registry install could not get it), and a working dist that reports the manifest's identity.
   */
  function frozenCheckout() {
    const root = scratch();
    put(join(root, "pnpm-lock.yaml"), "lockfile\n");
    put(join(root, "node_modules/.pnpm/lock.yaml"), "lockfile\n");
    put(join(root, "packages/cli/dist/bin.js"), printing(RELEASE_LINE));
    const dep = join(root, "packages/cli/node_modules/pinned-dep");
    put(join(dep, "package.json"), JSON.stringify({ name: "pinned-dep", version: "1.0.0", type: "module", exports: "./index.js" }));
    put(join(dep, "index.js"), `export const line = ${JSON.stringify(RELEASE_LINE)};\n`);
    const playwright = join(root, "packages/cli/node_modules/playwright");
    put(join(playwright, "package.json"), JSON.stringify({ name: "playwright", version: "1.63.0" }));
    return root;
  }

  /** The bundled root export: the documented functions, reporting the same identity as the bin (#815). */
  const rootExport = (line = RELEASE_LINE) => `export function buildProgram() {}\nexport function versionString() { return ${JSON.stringify(line)}; }\n`;

  /** An artifact whose cli tarball has the given bin source and package.json fields. */
  function artifactOf(binSource, pkgFields = {}, artifactManifest = manifest, indexSource = rootExport()) {
    const dir = scratch();
    const pkg = join(dir, "src", "package");
    const fields = { name: "@jevitate/cli", version: "1.2.3", type: "module", bin: { jevitate: "dist/bin.js" }, main: "dist/index.js", exports: { ".": "./dist/index.js" }, ...pkgFields };
    put(join(pkg, "package.json"), JSON.stringify(fields));
    put(join(pkg, "dist", "bin.js"), binSource);
    put(join(pkg, "dist", "index.js"), indexSource);
    const out = join(dir, "artifact");
    mkdirSync(out);
    execFileSync("tar", ["-czf", join(out, artifactManifest.files["@jevitate/cli"]), "-C", join(dir, "src"), "package"]);
    writeFileSync(join(out, "manifest.json"), JSON.stringify(artifactManifest));
    return out;
  }

  const WITH_PINNED_DEP = { dependencies: { "pinned-dep": "^1.0.0" } };

  it("a tarball reporting the manifest's identity through its lockfile-installed dependency passes", () => {
    expect(verifyPackedIdentity(artifactOf(PRINT_PINNED_DEP, WITH_PINNED_DEP), { root: frozenCheckout() }).tree).toBe("def5678");
  });

  it("a tarball holding a source build is refused though the working dist reports the manifest's identity", () => {
    const sourceBuild = printing(`1.2.3-source-abc1234 (commit abc1234, tree def5678, built ${BUILT})`);
    expect(() => verifyPackedIdentity(artifactOf(sourceBuild), { root: frozenCheckout() })).toThrow(/reports version 1\.2\.3-source-abc1234/);
  });

  it("a manifest naming another commit is refused", () => {
    const wrong = { ...manifest, commit: "ea67344".padEnd(40, "0") };
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), {}, wrong), { root: frozenCheckout() })).toThrow(/reports commit abc1234/);
  });

  it("a tarball importing a dependency it does not declare is refused", () => {
    expect(() => verifyPackedIdentity(artifactOf(PRINT_PINNED_DEP), { root: frozenCheckout() })).toThrow(/Cannot find package 'pinned-dep'/);
  });

  it("a tarball declaring a dependency the frozen lockfile did not install is refused", () => {
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), { dependencies: { "not-locked": "^1.0.0" } }), { root: frozenCheckout() })).toThrow(/depends on not-locked/);
  });

  it("node_modules installed from another lockfile is refused", () => {
    const root = frozenCheckout();
    writeFileSync(join(root, "pnpm-lock.yaml"), "a newer lockfile\n");
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE)), { root })).toThrow(/does not match pnpm-lock\.yaml/);
  });

  it("a checkout with no record of a pnpm install is refused", () => {
    const root = frozenCheckout();
    rmSync(join(root, "node_modules"), { recursive: true });
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE)), { root })).toThrow(/no frozen install/);
  });

  it("a corrupt tarball is refused", () => {
    const artifact = artifactOf(printing(RELEASE_LINE));
    writeFileSync(join(artifact, manifest.files["@jevitate/cli"]), "not a tarball");
    expect(() => verifyPackedIdentity(artifact, { root: frozenCheckout() })).toThrow(/tar/);
  });

  it("a root export importing a package the tarball does not declare is refused (#815)", () => {
    const index = `import "@jevitate/playwright";\n${rootExport()}`;
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), {}, manifest, index), { root: frozenCheckout() })).toThrow(/root export[\s\S]*Cannot find package '@jevitate\/playwright'/);
  });

  it("a root export without a documented function is refused (#815)", () => {
    const index = `export function versionString() { return ${JSON.stringify(RELEASE_LINE)}; }\n`;
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), {}, manifest, index), { root: frozenCheckout() })).toThrow(/root export lacks buildProgram/);
  });

  it("a root export reporting another build than its bin is refused (#815, #784)", () => {
    const index = rootExport(`1.2.3-source-abc1234 (commit abc1234, tree def5678, built ${BUILT})`);
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), {}, manifest, index), { root: frozenCheckout() })).toThrow(/root export reports 1\.2\.3-source-abc1234/);
  });

  it("a package without a root export is refused (#815)", () => {
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), { main: undefined, exports: undefined }, manifest, ""), { root: frozenCheckout() })).toThrow(/root export/);
  });

  it("a tarball pinning playwright to the version the frozen install tested passes (#825)", () => {
    expect(verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), { dependencies: { playwright: "1.63.0" } }), { root: frozenCheckout() }).tree).toBe("def5678");
  });

  it("a tarball declaring playwright as a range is refused (#825)", () => {
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), { dependencies: { playwright: "^1.49.0" } }), { root: frozenCheckout() })).toThrow(/playwright "\^1\.49\.0", not the exact 1\.63\.0 the release gate tested/);
  });

  it("a tarball pinning another playwright than the frozen install is refused (#825)", () => {
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), { dependencies: { playwright: "1.65.0" } }), { root: frozenCheckout() })).toThrow(/playwright "1\.65\.0", not the exact 1\.63\.0/);
  });

  it("a bin pointing out of the tarball is refused", () => {
    const outside = scratch();
    writeFileSync(join(outside, "bin.js"), printing(RELEASE_LINE));
    // From <tmpdir>/<prefix>/node_modules/@jevitate/cli, up to the tmpdir both scratch dirs share.
    const bin = { jevitate: `../../../../${basename(outside)}/bin.js` };
    expect(() => verifyPackedIdentity(artifactOf(printing(RELEASE_LINE), { bin }), { root: frozenCheckout() })).toThrow(/outside the tarball/);
  });
});

describe("the tested Playwright (#825)", () => {
  const lock = readFileSync("pnpm-lock.yaml", "utf8");
  const locked = [...new Set([...lock.matchAll(/^  playwright@(\d+\.\d+\.\d+):$/gm)].map((m) => m[1]))];
  const specifiers = [...lock.matchAll(/^      playwright:\n        specifier: (\S+)\n        version: (\S+)$/gm)].map((m) => ({ specifier: m[1], version: m[2] }));

  it("the lockfile resolves one Playwright", () => {
    expect(locked).toHaveLength(1);
  });

  it("every workspace package pins exactly that version", () => {
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s).toEqual({ specifier: locked[0], version: locked[0] });
  });

  it("the published cli declares that exact version", () => {
    const cli = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
    expect(cli.dependencies.playwright).toBe(locked[0]);
  });
});

describe("which jobs run package code (H1)", () => {
  const workflow = (file) => readFileSync(join(".github/workflows", file), "utf8");
  /** A job's text without comments; throws rather than pass vacuously when the job is gone. */
  function job(file, name) {
    const match = new RegExp(`^  ${name}:\\n(?:(?:    .*)?\\n)+`, "m").exec(workflow(file));
    if (!match) throw new Error(`${file} has no job ${name}`);
    return match[0].replace(/^\s*#.*\n/gm, "");
  }

  it("the publish job holds id-token: write", () => {
    expect(job("release.yml", "npm")).toMatch(/id-token: write/);
  });

  it("the publish job does not run the identity check", () => {
    expect(job("release.yml", "npm")).not.toMatch(/release-artifact\.mjs identity|pack-release/);
  });

  it("the publish job verifies the bytes", () => {
    expect(job("release.yml", "npm")).toMatch(/release-artifact\.mjs verify /);
  });

  it("the publish job installs an exact npm version", () => {
    expect(job("release.yml", "npm")).toMatch(/npm install -g npm@\d+\.\d+\.\d+\n/);
  });

  it("the pack job runs the identity check through pack-release.sh", () => {
    expect(readFileSync("scripts/ci/pack-release.sh", "utf8")).toMatch(/^node scripts\/ci\/release-artifact\.mjs identity "\$out"$/m);
  });

  it("the pack workflow holds no id-token", () => {
    expect(workflow("ci.yml")).not.toMatch(/id-token/);
  });
});

// The real pack needs a build and a frozen install, so it runs on request against a pack's output:
//   pnpm -r build && bash scripts/ci/pack-release.sh <dir>
//   JEVITATE_RELEASE_ARTIFACT=<dir> pnpm exec vitest run scripts/ci/release-identity.test.mjs
const artifact = process.env.JEVITATE_RELEASE_ARTIFACT;
describe.skipIf(artifact === undefined)("the real packed tarball (#784)", () => {
  it("its packed --version names the manifest's tree", () => {
    const { tree } = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8"));
    expect(tree.startsWith(verifyPackedIdentity(artifact).tree)).toBe(true);
  }, 120_000);
});
