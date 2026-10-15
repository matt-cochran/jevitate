import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findTreeArtifact, trustedRun } from "./find-tree-artifact.mjs";
import { verifyArtifact, writeArtifact } from "./release-artifact.mjs";
import { planRelease } from "./release-plan.mjs";

const TREE = "a".repeat(40);
const REPO = "matt-cochran/jevitate";

describe("planRelease (#534)", () => {
  const base = { event: "push", refType: "branch", refName: "staging", publishInput: false, version: "1.2.3", aliasVersion: "1.2.3", pending: 0, onNpm: { cli: false, alias: false } };

  it("staging with an unpublished version publishes next from the artifact", () => {
    expect(planRelease(base)).toMatchObject({ mode: "next", needsArtifact: true });
    expect(planRelease({ ...base, onNpm: { cli: true, alias: false } })).toMatchObject({ mode: "next", needsArtifact: true });
  });

  it("staging with the version already on npm, or changesets pending, does nothing", () => {
    expect(planRelease({ ...base, onNpm: { cli: true, alias: true } }).mode).toBe("none");
    expect(planRelease({ ...base, pending: 2 }).mode).toBe("none");
  });

  it("main moves latest; it publishes only when npm lacks the version", () => {
    const main = { ...base, refName: "main" };
    expect(planRelease({ ...main, onNpm: { cli: true, alias: true } })).toMatchObject({ mode: "latest", needsArtifact: false });
    expect(planRelease(main)).toMatchObject({ mode: "latest", needsArtifact: true });
  });

  it("a vX.Y.Z tag is the main channel", () => {
    const tag = { ...base, refType: "tag", refName: "v1.2.3", onNpm: { cli: true, alias: true } };
    expect(planRelease(tag).mode).toBe("latest");
    expect(planRelease({ ...tag, pending: 1 }).mode).toBe("none");
  });

  it("main with pending changesets versions them", () => {
    expect(planRelease({ ...base, refName: "main", pending: 1 }).mode).toBe("version");
  });

  it("a manual run acts only with publish checked", () => {
    const dispatch = { ...base, event: "workflow_dispatch", refName: "main" };
    expect(planRelease(dispatch).mode).toBe("none");
    expect(planRelease({ ...dispatch, publishInput: true }).mode).toBe("latest");
  });

  it("other refs never release, and the two packages must share a version", () => {
    expect(planRelease({ ...base, refName: "dev" }).mode).toBe("none");
    expect(() => planRelease({ ...base, aliasVersion: "1.2.4" })).toThrow(/release together/);
  });
});

describe("findTreeArtifact (#534)", () => {
  const run = (over = {}) => ({ id: 7, path: ".github/workflows/ci.yml", event: "push", head_branch: "dev", status: "completed", conclusion: "success", head_sha: "c1", repository: { full_name: REPO }, html_url: "u", ...over });
  const artifact = (over = {}) => ({ id: 70, name: `jevitate-${TREE}`, expired: false, created_at: "2026-10-01T00:00:00Z", workflow_run: { id: 7 }, ...over });
  const fakeApi = ({ artifacts, runs, trees }) => async (path) => {
    if (path.includes("/actions/artifacts?")) return { artifacts };
    const runId = /\/actions\/runs\/(\d+)$/.exec(path)?.[1];
    if (runId) return runs[runId];
    const sha = /\/git\/commits\/(\w+)$/.exec(path)?.[1];
    if (sha) return { tree: { sha: trees[sha] } };
    throw new Error(`unexpected ${path}`);
  };

  it("trusts only green dev pushes of ci.yml and Release runs in this repo", () => {
    expect(trustedRun(run(), REPO)).toBe(true);
    expect(trustedRun(run({ path: ".github/workflows/ci.yml@refs/heads/dev" }), REPO)).toBe(true);
    expect(trustedRun(run({ path: ".github/workflows/release.yml", head_branch: "staging" }), REPO)).toBe(true);
    expect(trustedRun(run({ event: "pull_request" }), REPO)).toBe(false);
    expect(trustedRun(run({ head_branch: "feature" }), REPO)).toBe(false);
    expect(trustedRun(run({ conclusion: "failure" }), REPO)).toBe(false);
    expect(trustedRun(run({ conclusion: null, status: "in_progress" }), REPO)).toBe(false);
    expect(trustedRun(run({ repository: { full_name: "evil/fork" } }), REPO)).toBe(false);
    expect(trustedRun(run({ path: ".github/workflows/windows-repeat.yml" }), REPO)).toBe(false);
  });

  it("returns the newest artifact whose run is trusted and whose commit really has the tree", async () => {
    const api = fakeApi({
      artifacts: [
        artifact({ id: 1, workflow_run: { id: 1 }, created_at: "2026-10-03T00:00:00Z" }),
        artifact({ id: 2, workflow_run: { id: 2 }, created_at: "2026-10-02T00:00:00Z" }),
        artifact({ id: 3, workflow_run: { id: 3 }, created_at: "2026-10-01T00:00:00Z" }),
        artifact({ id: 4, workflow_run: { id: 4 }, created_at: "2026-10-04T00:00:00Z", expired: true }),
      ],
      runs: { 1: run({ id: 1, conclusion: "failure" }), 2: run({ id: 2, head_sha: "c2" }), 3: run({ id: 3, head_sha: "c3" }) },
      trees: { c2: "b".repeat(40), c3: TREE },
    });
    const result = await findTreeArtifact({ api, repo: REPO, tree: TREE });
    expect(result).toMatchObject({ found: true, runId: 3, artifactId: 3, headSha: "c3" });
    expect(result.rejected).toHaveLength(2);
  });

  it("reports not-found (not an error) when nothing qualifies", async () => {
    const api = fakeApi({ artifacts: [], runs: {}, trees: {} });
    expect(await findTreeArtifact({ api, repo: REPO, tree: TREE })).toMatchObject({ found: false, artifact: `jevitate-${TREE}` });
  });
});

describe("release artifact write/verify (#534)", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A fake repo root with both package.json files, and an out dir holding the two tarballs. */
  function fixture({ version = "1.2.3", aliasDep = version } = {}) {
    const root = mkdtempSync(join(tmpdir(), "jev-release-"));
    dirs.push(root);
    const pack = (name, deps, file) => {
      const staging = join(root, "staging", file);
      mkdirSync(join(staging, "package"), { recursive: true });
      writeFileSync(join(staging, "package", "package.json"), JSON.stringify({ name, version, dependencies: deps }));
      execFileSync("tar", ["-czf", join(root, "out", file), "-C", staging, "package"]);
    };
    for (const [dir, name] of [["packages/cli", "@jevitate/cli"], ["packages/jevitate-cli-alias", "jevitate"]]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name, version }));
    }
    mkdirSync(join(root, "out"));
    pack("@jevitate/cli", {}, `jevitate-cli-${version}.tgz`);
    pack("jevitate", { "@jevitate/cli": aliasDep }, `jevitate-${version}.tgz`);
    const out = join(root, "out");
    writeArtifact(out, { tree: TREE, commit: "c".repeat(40), runId: "99", root });
    return out;
  }

  it("round-trips: what write produces, verify accepts", () => {
    const out = fixture();
    expect(verifyArtifact(out, { tree: TREE, version: "1.2.3" })).toMatchObject({ tree: TREE, runId: "99", versions: { "@jevitate/cli": "1.2.3", jevitate: "1.2.3" } });
    // plain `sha256sum` format, so `sha256sum -c SHA256SUMS` works by hand (ci.yml runs it)
    expect(readFileSync(join(out, "SHA256SUMS"), "utf8")).toMatch(/^([0-9a-f]{64} {2}(jevitate-cli-1\.2\.3\.tgz|jevitate-1\.2\.3\.tgz|manifest\.json)\n){3}$/);
  });

  it("rejects a tampered tarball, an unlisted file, another tree or another version", () => {
    const out = fixture();
    expect(() => verifyArtifact(out, { tree: "b".repeat(40), version: "1.2.3" })).toThrow(/expected bbbb/);
    expect(() => verifyArtifact(out, { tree: TREE, version: "1.2.4" })).toThrow(/expected 1.2.4/);
    writeFileSync(join(out, "extra.tgz"), "x");
    expect(() => verifyArtifact(out, { tree: TREE, version: "1.2.3" })).toThrow(/extra.tgz is not listed/);
    rmSync(join(out, "extra.tgz"));
    writeFileSync(join(out, "jevitate-1.2.3.tgz"), "tampered");
    expect(() => verifyArtifact(out, { tree: TREE, version: "1.2.3" })).toThrow(/checksum mismatch for jevitate-1.2.3.tgz/);
  });

  it("rejects an alias that does not pin the exact cli version", () => {
    const out = fixture({ aliasDep: "workspace:*" });
    expect(() => verifyArtifact(out, { tree: TREE, version: "1.2.3" })).toThrow(/depends on @jevitate\/cli workspace:\*/);
  });
});
